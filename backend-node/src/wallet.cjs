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

// Preserve the exact legacy float serialization used in stored signatures.
function legacyFloat(value) {
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
    .map(key => `${asciiJson(key)}:${legacyFloat(input.increments[key])}`).join(',');
  const requestFingerprint = input.requestFingerprint === undefined
    ? '' : `,"request_fingerprint":${asciiJson(input.requestFingerprint)}`;
  const serialized = `{"direction":${asciiJson(input.direction)},"increments":{${entries}},`
    + `"required_balance_amount":${legacyFloat(input.requiredBalanceAmount ?? 0)},`
    + `"required_balance_field":${asciiJson(input.requiredBalanceField ?? null)},`
    + `"user_id":${asciiJson(String(input.userId))}${requestFingerprint}}`;
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
  if (input.requestFingerprint !== undefined
      && (typeof input.requestFingerprint !== 'string'
        || !/^[a-f0-9]{64}$/.test(input.requestFingerprint))) return false;
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
    if (['applied', 'already'].includes(state) && input.ledger) {
      if (!input.ledger.id || String(input.ledger.user_id) !== userId
          || String(input.ledger.metadata?.wallet_operation_id || '') !== operationId) {
        throw new Error('Invalid atomic wallet ledger entry');
      }
      const ledgerId = String(input.ledger.id);
      const existingLedger = await repo.get('transactions', ledgerId);
      const hasLegacyCreditMarker = Array.isArray(input.legacyMarkers)
        && input.legacyMarkers.length > 0;
      const canCreateLedger = state === 'applied' || snapshot !== null || hasLegacyCreditMarker;
      const metadata = {
        ...(existingLedger?.metadata || {}),
        ...(input.ledger.metadata || {}),
      };
      delete metadata.wallet_snapshot;
      if (snapshot) metadata.wallet_snapshot = snapshot;
      else if (existingLedger?.metadata?.wallet_snapshot) {
        metadata.wallet_snapshot = existingLedger.metadata.wallet_snapshot;
      }
      const ledger = {
        ...(existingLedger || {}),
        ...input.ledger,
        ...(existingLedger?.reference ? { reference: existingLedger.reference } : {}),
        metadata,
      };
      if (existingLedger) {
        const existingOperationId = String(existingLedger.metadata?.wallet_operation_id || '');
        const matchesOperation = String(existingLedger.user_id) === userId
            && String(existingLedger.type || '') === String(input.ledger.type || '')
            && String(existingLedger.currency || '') === String(input.ledger.currency || '')
            && Number(existingLedger.amount) === Number(input.ledger.amount)
            && (existingOperationId
              ? existingOperationId === operationId
              : String(existingLedger.reference || '') === String(input.ledger.reference || ''));
        if (!matchesOperation
            || !['pending', 'completed'].includes(existingLedger.status)
            || (state === 'applied' && existingLedger.status !== 'pending')) {
          throw new Error('Conflicting existing wallet ledger entry');
        }
        if (existingLedger.status === 'pending') {
          await repo.replace('transactions', ledgerId, ledger);
        }
      } else if (canCreateLedger) {
        await repo.insert('transactions', ledgerId, ledger);
      }
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

async function applyInternalTransfer(store, input) {
  const fromUserId = String(input?.fromUserId || '');
  const toUserId = String(input?.toUserId || '');
  const operationId = String(input?.operationId || '');
  const field = String(input?.walletField || '');
  const amount = Number(input?.amount);
  const currency = String(input?.currency || '');
  const fieldPattern = /^[a-zA-Z0-9_]+$/;
  if (!fromUserId || !toUserId || fromUserId === toUserId || !operationId
      || !fieldPattern.test(field) || !Number.isFinite(amount) || amount <= 0
      || !input.transactionOut?.id || !input.transactionIn?.id
      || String(input.transactionOut.user_id) !== fromUserId
      || String(input.transactionIn.user_id) !== toUserId) {
    return { state: 'invalid' };
  }

  const debitOperationId = `${operationId}:out`;
  const creditOperationId = `${operationId}:in`;
  const debitClaimId = operationIdentity('internal_transfer_debit', `${fromUserId}:${operationId}`);
  const creditClaimId = operationIdentity('internal_transfer_credit', `${toUserId}:${operationId}`);
  const signature = createHash('sha256').update(JSON.stringify({
    fromUserId, toUserId, operationId, walletField: field, amount,
    currency,
    requestFingerprint: String(input?.requestFingerprint || ''),
  })).digest('hex');

  return store.transaction(async repo => {
    await repo.lockWallets();
    const sender = await repo.get('users', fromUserId);
    const recipient = await repo.get('users', toUserId);
    if (!sender || !recipient) return { state: 'missing_user' };

    const debitClaim = await repo.get('wallet_operations', debitClaimId);
    const creditClaim = await repo.get('wallet_operations', creditClaimId);
    if (debitClaim || creditClaim) {
      if (!debitClaim || !creditClaim
          || debitClaim.signature !== signature || creditClaim.signature !== signature) {
        return { state: 'idempotency_conflict' };
      }
      return {
        state: 'already',
        snapshots: { sender: debitClaim.snapshot, recipient: creditClaim.snapshot },
      };
    }

    const debitMarkers = sender.wallet_debit_operation_ids ?? [];
    const creditMarkers = recipient.wallet_credit_operation_ids ?? [];
    if (debitMarkers.includes(debitOperationId) || creditMarkers.includes(creditOperationId)) {
      return { state: 'already', snapshots: null };
    }
    if (new Decimal(sender[field] ?? 0).lt(amount)) return { state: 'insufficient' };

    const senderBefore = Number(sender[field] ?? 0);
    const recipientBefore = Number(recipient[field] ?? 0);
    const senderAfter = new Decimal(senderBefore).minus(amount).toNumber();
    const recipientAfter = new Decimal(recipientBefore).plus(amount).toNumber();
    if (![senderBefore, recipientBefore, senderAfter, recipientAfter].every(Number.isFinite)) {
      throw new Error('Invalid wallet amount');
    }
    sender[field] = senderAfter;
    recipient[field] = recipientAfter;
    sender.wallet_debit_operation_ids = [...new Set([...debitMarkers, debitOperationId])];
    recipient.wallet_credit_operation_ids = [...new Set([...creditMarkers, creditOperationId])];

    const now = new Date().toISOString();
    const senderSnapshot = {
      wallet_field: field, balance_before: senderBefore, balance_after: senderAfter,
      direction: 'debit', amount,
    };
    const recipientSnapshot = {
      wallet_field: field, balance_before: recipientBefore, balance_after: recipientAfter,
      direction: 'credit', amount,
    };
    await repo.replace('users', fromUserId, sender);
    await repo.replace('users', toUserId, recipient);
    await repo.insert('wallet_operations', debitClaimId, {
      id: debitClaimId, identity_type: 'internal_transfer_debit',
      primary_operation_id: debitClaimId, user_id: fromUserId,
      signature, snapshot: senderSnapshot, snapshot_available: true, created_at: now,
    });
    await repo.insert('wallet_operations', creditClaimId, {
      id: creditClaimId, identity_type: 'internal_transfer_credit',
      primary_operation_id: debitClaimId, user_id: toUserId,
      signature, snapshot: recipientSnapshot, snapshot_available: true, created_at: now,
    });

    const transactionOut = {
      ...input.transactionOut,
      metadata: {
        ...(input.transactionOut.metadata ?? {}),
        wallet_operation_id: debitOperationId,
        wallet_snapshot: senderSnapshot,
      },
    };
    const transactionIn = {
      ...input.transactionIn,
      metadata: {
        ...(input.transactionIn.metadata ?? {}),
        wallet_operation_id: creditOperationId,
        wallet_snapshot: recipientSnapshot,
      },
    };
    await repo.insert('transactions', String(transactionOut.id), transactionOut);
    await repo.insert('transactions', String(transactionIn.id), transactionIn);
    return {
      state: 'applied',
      snapshots: { sender: senderSnapshot, recipient: recipientSnapshot },
    };
  });
}

module.exports = {
  operationIdentity, operationSignature, legacyFloat,
  applyWalletOperation, applyInternalTransfer,
};
