'use strict';
const { createHash } = require('node:crypto');
const Decimal = require('decimal.js');

function operationIdentity(type, value) {
  return createHash('sha256').update(`biztranspay:${type}:${value}`).digest('hex');
}

function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// Preserve the signatures already stored by Python json.dumps(float(...)).
function pythonFloat(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('Non-finite amount');
  if (Object.is(number, -0)) return '-0.0';
  const absolute = Math.abs(number);
  if (absolute !== 0 && (absolute < 1e-4 || absolute >= 1e16)) {
    const [mantissa, exponent] = number.toExponential().split('e');
    const exp = Number(exponent);
    return `${mantissa}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  return `${number}${Number.isInteger(number) ? '.0' : ''}`;
}

function operationSignature(input) {
  const entries = Object.keys(input.increments).sort()
    .map(key => `${asciiJson(key)}:${pythonFloat(input.increments[key])}`).join(',');
  const serialized = `{"direction":${asciiJson(input.direction)},"increments":{${entries}},`
    + `"required_balance_amount":${pythonFloat(input.requiredBalanceAmount ?? 0)},`
    + `"required_balance_field":${asciiJson(input.requiredBalanceField ?? null)},`
    + `"user_id":${asciiJson(String(input.userId))}}`;
  return createHash('sha256').update(serialized).digest('hex');
}

function validInput(input) {
  if (!input?.userId || !input.operationId || !['credit', 'debit', 'exchange'].includes(input.direction)
      || !input.increments || !Object.keys(input.increments).length
      || !Object.hasOwn(input.increments, input.primaryField)) return false;
  const fieldPattern = /^[a-zA-Z0-9_]+$/;
  if (input.requiredBalanceField && !fieldPattern.test(input.requiredBalanceField)) return false;
  if (!Number.isFinite(Number(input.requiredBalanceAmount ?? 0))
      || Number(input.requiredBalanceAmount ?? 0) < 0) return false;
  return Object.entries(input.increments).every(([key, amount]) =>
    fieldPattern.test(key) && typeof amount === 'number' && Number.isFinite(amount) && amount !== 0);
}

// Internal accounting primitive, never exposed as a public arbitrary-credit API.
async function applyWalletOperation(store, input) {
  if (!validInput(input)) return { state: 'invalid' };
  const userId = String(input.userId);
  const operationId = String(input.operationId);
  const primaryId = operationIdentity('operation', `${userId}:${operationId}`);
  const aliasIds = [...new Set((input.aliases ?? []).filter(v => String(v).trim())
    .map(v => operationIdentity('provider_event', String(v))))].sort();
  const signature = operationSignature(input);
  const markerFields = input.direction === 'credit' ? ['wallet_credit_operation_ids']
    : input.direction === 'debit' ? ['wallet_debit_operation_ids']
      : ['wallet_debit_operation_ids', 'wallet_credit_operation_ids'];

  return store.transaction(async repo => {
    await repo.lockWallets();
    const user = await repo.get('users', userId);
    if (!user || String(user.id) !== userId) return { state: 'missing_user' };
    const claims = new Map();
    for (const id of [primaryId, ...aliasIds]) {
      const claim = await repo.get('wallet_operations', id);
      if (claim) claims.set(id, claim);
    }
    for (const id of aliasIds) {
      const claim = claims.get(id);
      if (!claim) continue;
      if (claim.primary_operation_id !== primaryId) return { state: 'duplicate_event' };
      if (claim.signature !== signature) return { state: 'idempotency_conflict' };
    }
    const primaryClaim = claims.get(primaryId);
    if (primaryClaim && primaryClaim.signature !== signature) return { state: 'idempotency_conflict' };
    const legacy = [...markerFields.map(field => [field, operationId]), ...(input.legacyMarkers ?? [])]
      .some(([field, value]) => (user[field] ?? []).includes(String(value)));
    let state = 'already';
    let snapshot = primaryClaim?.snapshot ?? null;
    if (!primaryClaim && !legacy && !aliasIds.some(id => claims.has(id))) {
      if (input.requiredBalanceField
          && new Decimal(user[input.requiredBalanceField] ?? 0)
            .lt(input.requiredBalanceAmount ?? 0)) return { state: 'insufficient' };
      const before = {}; const after = {};
      for (const [field, amount] of Object.entries(input.increments)) {
        before[field] = Number(user[field] ?? 0);
        after[field] = new Decimal(before[field]).plus(amount).toNumber();
        if (!Number.isFinite(before[field]) || !Number.isFinite(after[field])) {
          throw new Error('Invalid wallet amount');
        }
        user[field] = after[field];
      }
      for (const field of markerFields) {
        user[field] = [...new Set([...(user[field] ?? []), operationId])];
      }
      await repo.replace('users', userId, user);
      snapshot = {
        wallet_field: input.primaryField,
        balance_before: before[input.primaryField], balance_after: after[input.primaryField],
        wallet_balances_before: before, wallet_balances_after: after,
        direction: input.direction, amount: Math.abs(input.increments[input.primaryField]),
      };
      state = 'applied';
    } else if (!primaryClaim && !snapshot) {
      snapshot = aliasIds.map(id => claims.get(id)?.snapshot).find(Boolean) ?? null;
    }
    // Imported legacy markers block re-crediting. Never invent an old balance snapshot.
    for (const [id, type] of [[primaryId, 'operation'], ...aliasIds.map(id => [id, 'provider_event'])]) {
      if (claims.has(id)) continue;
      await repo.insert('wallet_operations', id, {
        id, identity_type: type, primary_operation_id: primaryId,
        user_id: userId, signature, snapshot, snapshot_available: snapshot !== null,
        created_at: new Date().toISOString(),
      });
    }
    if (state === 'applied' && input.ledger) {
      if (!input.ledger.id || String(input.ledger.user_id) !== userId
          || String(input.ledger.metadata?.wallet_operation_id || '') !== operationId) {
        throw new Error('Invalid atomic wallet ledger entry');
      }
      await repo.insert('transactions', String(input.ledger.id), input.ledger);
    }
    if (state === 'applied' && input.adminLog) {
      if (!input.adminLog.id || !input.adminLog.admin_id
          || String(input.adminLog.target_user_id || '') !== userId
          || String(input.adminLog.details?.operation_id || '') !== operationId) {
        throw new Error('Invalid atomic admin audit entry');
      }
      await repo.insert('admin_logs', String(input.adminLog.id), input.adminLog);
    }
    return { state, snapshot };
  });
}

module.exports = { operationIdentity, operationSignature, pythonFloat, applyWalletOperation };
