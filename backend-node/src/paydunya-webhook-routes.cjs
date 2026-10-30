'use strict';

const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { applyWalletOperation } = require('./wallet.cjs');
const { loadCredentials } = require('./paydunya-invoice-routes.cjs');
const { sessionToken } = require('./auth-session-routes.cjs');
const { publicMomoDeposit } = require('./deposit-status-routes.cjs');

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function redirect(res, location) {
  res.writeHead(303, {
    Location: location,
    'Cache-Control': 'no-store',
    'Content-Length': '0',
  });
  res.end();
}

function safeEqualHex(left, right) {
  const a = Buffer.from(String(left || '').trim().toLowerCase(), 'hex');
  const b = Buffer.from(String(right || '').trim().toLowerCase(), 'hex');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function staticHashValid(provided, masterKey) {
  if (!provided || !masterKey) return false;
  const expected = crypto.createHash('sha512').update(String(masterKey), 'utf8').digest('hex');
  return safeEqualHex(provided, expected);
}

function setNested(root, parts, value) {
  let node = root;
  for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(node, part)) node[part] = {};
    if (!node[part] || typeof node[part] !== 'object' || Array.isArray(node[part])) {
      throw new Error('Invalid nested form');
    }
    node = node[part];
  }
  const leaf = parts.at(-1);
  if (Object.hasOwn(node, leaf)) throw new Error('Duplicate nested form field');
  node[leaf] = value;
}

function parsePaydunyaWebhook(raw, contentType = '') {
  let form;
  if (String(contentType).toLowerCase().includes('application/json')) {
    form = JSON.parse(raw.toString('utf8') || '{}');
  } else {
    const params = new URLSearchParams(raw.toString('utf8'));
    form = {};
    const nested = {};
    for (const [key, value] of params.entries()) {
      const match = /^data((?:\[[^\[\]]+\])+)$/.exec(key);
      if (match) {
        const parts = [...match[1].matchAll(/\[([^\[\]]+)\]/g)].map(item => item[1]);
        if (!parts.length || parts.length > 8 || parts.some(part => part.length > 128)) {
          throw new Error('Invalid nested form field');
        }
        setNested(nested, parts, value);
      } else if (Object.hasOwn(form, key)) {
        throw new Error('Duplicate form field');
      } else {
        form[key] = value;
      }
    }
    if (Object.keys(nested).length) form.data = nested;
    if (typeof form.data === 'string') {
      try { form.data = JSON.parse(form.data); } catch { /* retain string as raw data */ }
    }
  }
  if (!form || typeof form !== 'object' || Array.isArray(form)) {
    throw new Error('Invalid webhook form');
  }
  const suppliedHash = String(form.hash || form.HASH || form.signature || '');
  const rawPayload = form.data || form.payload || form.response || form;
  let payload = rawPayload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { payload = { raw: payload }; }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    payload = { data: payload };
  }
  return {
    payload,
    suppliedHash: suppliedHash || String(payload.hash || ''),
  };
}

function webhookInvoiceToken(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const invoice = data?.invoice && typeof data.invoice === 'object' ? data.invoice : {};
  return String(invoice.token || invoice.invoice_token || data?.token || payload?.token || '').trim();
}

function confirmationDetails(response) {
  const data = response?.data && typeof response.data === 'object' ? response.data : response;
  const invoice = data?.invoice && typeof data.invoice === 'object' ? data.invoice : {};
  const custom = data?.custom_data && typeof data.custom_data === 'object'
    ? data.custom_data
    : (invoice.custom_data && typeof invoice.custom_data === 'object' ? invoice.custom_data : {});
  const currencyValue = data.currency || invoice.currency || custom.biztranspay_currency || '';
  const currency = typeof currencyValue === 'object'
    ? String(currencyValue.iso || currencyValue.code || '').toUpperCase()
    : String(currencyValue).toUpperCase();
  return {
    code: String(data.response_code || response?.response_code || ''),
    status: String(data.status || invoice.status || '').toLowerCase(),
    token: String(data.token || data.invoice_token || invoice.token || ''),
    amount: data.amount ?? data.total_amount ?? invoice.total_amount ?? custom.biztranspay_amount,
    currency,
    depositId: String(custom.biztranspay_token || ''),
    hash: String(data.hash || invoice.hash || response?.hash || ''),
  };
}

function confirmationValid(response, deposit, masterKey) {
  const details = confirmationDetails(response);
  const token = String(deposit.paydunya_token || '');
  const currency = String(deposit.currency || 'XOF').toUpperCase();
  const expectedAmount = Number(deposit.charged_amount ?? deposit.amount);
  const returnedAmount = Number(details.amount);
  const identityOkay = !details.depositId || details.depositId === String(deposit.id);
  const currencyOkay = details.currency === currency
    || (!details.currency && currency === 'XOF' && identityOkay);
  return details.code === '00'
    && ['completed', 'paid', 'success', 'successful'].includes(details.status)
    && details.token === token
    && Number.isFinite(returnedAmount)
    && Math.abs(returnedAmount - expectedAmount) < 0.005
    && currencyOkay
    && identityOkay
    && staticHashValid(details.hash, masterKey);
}

async function readRawBody(req, maximum = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) {
      const error = new Error('Payload too large');
      error.status = 413;
      throw error;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function providerReference(response, fallback) {
  const data = response?.data && typeof response.data === 'object' ? response.data : response;
  const invoice = data?.invoice && typeof data.invoice === 'object' ? data.invoice : {};
  return String(data.transaction_id || data.payment_id || invoice.reference || fallback || '');
}

function createPaydunyaWebhookRoutes({
  db, env = process.env, fetchImpl = globalThis.fetch, sessionService,
  reconcileDeposit,
}) {
  async function handleRoute(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const finalizeMatch = req.method === 'POST'
      ? /^\/api\/deposits\/mobile-money\/([^/]+)\/finalize$/.exec(url.pathname)
      : null;
    if (finalizeMatch) {
      try {
        if (!sessionService?.authenticate) {
          reply(res, 503, { detail: 'Service de session indisponible.' });
          return true;
        }
        const identity = await sessionService.authenticate(sessionToken(req));
        const userId = String(identity?.userId || '');
        if (!userId) {
          reply(res, 401, { detail: 'Session requise.' });
          return true;
        }
        const depositId = decodeURIComponent(finalizeMatch[1]);
        if (!depositId || depositId.length > 160) {
          reply(res, 422, { detail: 'Identifiant de dépôt invalide.' });
          return true;
        }
        let deposit = await db.collection('momo_deposits').find_one(
          { id: depositId, user_id: userId }, { _id: 0 },
        );
        if (!deposit) {
          reply(res, 404, { detail: 'Dépôt introuvable.' });
          return true;
        }
        if (deposit.provider !== 'paydunya') {
          reply(res, 409, {
            detail: 'Ce dépôt doit être confirmé par le prestataire qui l’a initié.',
          });
          return true;
        }
        if (deposit.status === 'pending') {
          const reconcile = typeof reconcileDeposit === 'function'
            ? reconcileDeposit : settleDepositById;
          await reconcile(depositId);
          deposit = await db.collection('momo_deposits').find_one(
            { id: depositId, user_id: userId }, { _id: 0 },
          ) || deposit;
        }
        reply(res, 200, publicMomoDeposit(deposit));
      } catch (error) {
        reply(res, error.status || 500, {
          detail: error.status ? error.message : 'Impossible de vérifier le dépôt.',
        });
      }
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/deposits/paydunya/return') {
      try {
        const reference = String(url.searchParams.get('ref') || '').trim();
        const providerToken = String(url.searchParams.get('token') || '').trim();
        let deposit = reference
          ? await db.collection('momo_deposits').find_one({
            provider: 'paydunya', id: reference,
          }, { _id: 0 })
          : null;
        if (!deposit && providerToken) {
          deposit = await db.collection('momo_deposits').find_one({
            provider: 'paydunya', paydunya_token: providerToken,
          }, { _id: 0 });
        }
        if (!deposit) {
          redirect(res, '/dashboard?paydunya=not_found');
          return true;
        }
        if (deposit.status !== 'approved' && deposit.paydunya_token) {
          await settleDepositById(String(deposit.id));
          deposit = await db.collection('momo_deposits').find_one(
            { id: String(deposit.id) }, { _id: 0 },
          ) || deposit;
        }
        const outcome = deposit.status === 'approved'
          ? 'completed'
          : deposit.status === 'failed' ? 'failed' : 'pending';
        redirect(res, `/dashboard?paydunya=${outcome}`);
      } catch {
        redirect(res, '/dashboard?paydunya=pending');
      }
      return true;
    }
    if (req.method !== 'POST' || url.pathname !== '/api/webhooks/paydunya') return false;

    let deposit = null;
    try {
      const raw = await readRawBody(req);
      let parsed;
      try {
        parsed = parsePaydunyaWebhook(raw, req.headers?.['content-type'] || '');
      } catch {
        reply(res, 400, { detail: 'Payload PayDunya invalide.' });
        return true;
      }
      const settings = await db.collection('settings').find_one(
        { id: 'payment_provider_paydunya' }, { _id: 0 },
      );
      if (!settings) {
        reply(res, 503, { detail: 'Passerelle PayDunya indisponible.' });
        return true;
      }
      const credentials = loadCredentials(settings, env.SESSION_SECRET || '', env);
      if (!staticHashValid(parsed.suppliedHash, credentials.master_key)) {
        reply(res, 400, { detail: 'Signature PayDunya invalide.' });
        return true;
      }
      const token = webhookInvoiceToken(parsed.payload);
      if (!token || token.length > 255) {
        reply(res, 400, { detail: 'Jeton de facture PayDunya manquant.' });
        return true;
      }
      deposit = await db.collection('momo_deposits').find_one({
        provider: 'paydunya',
        paydunya_token: token,
      }, { _id: 0 });
      if (!deposit) {
        reply(res, 200, { received: true });
        return true;
      }
      if (deposit.status === 'approved') {
        if (deposit.link_payment_id) {
          await db.collection('link_payments').update_one(
            { id: String(deposit.link_payment_id), status: { $in: ['creating', 'pending'] } },
            { $set: {
              status: 'paid',
              amount_net: Number(deposit.wallet_credit_amount ?? deposit.amount_net ?? deposit.amount),
              fee: Number(deposit.total_fee ?? deposit.fee ?? 0),
              paid_at: deposit.approved_at || new Date().toISOString(),
              updated_at: new Date().toISOString(),
            } },
          );
        }
        reply(res, 200, { received: true, duplicate: true });
        return true;
      }
      if (!['pending', 'failed'].includes(String(deposit.status || ''))
          || !deposit.user_id) {
        reply(res, 503, { received: true, pending_review: true });
        return true;
      }

      const mode = deposit.provider_mode === 'live'
        ? 'live'
        : deposit.provider_mode === 'test' ? 'test' : settings.mode === 'live' ? 'live' : 'test';
      const confirmUrl = mode === 'live'
        ? `https://app.paydunya.com/api/v1/checkout-invoice/confirm/${encodeURIComponent(token)}`
        : `https://app.paydunya.com/sandbox-api/v1/checkout-invoice/confirm/${encodeURIComponent(token)}`;
      let response;
      try {
        response = await fetchImpl(confirmUrl, {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(12_000),
          headers: {
            'PAYDUNYA-MASTER-KEY': credentials.master_key,
            'PAYDUNYA-PRIVATE-KEY': credentials.private_key,
            'PAYDUNYA-TOKEN': credentials.token,
            Accept: 'application/json',
          },
        });
      } catch {
        reply(res, 503, { received: true, retry: true });
        return true;
      }
      let confirmation;
      try { confirmation = await response.json(); } catch { confirmation = null; }
      if (!response.ok || !confirmation || typeof confirmation !== 'object') {
        reply(res, 503, { received: true, retry: true });
        return true;
      }
      if (!confirmationValid(confirmation, deposit, credentials.master_key)) {
        const details = confirmationDetails(confirmation);
        const identityConflict = details.depositId && details.depositId !== String(deposit.id);
        const amountConflict = Number.isFinite(Number(details.amount))
          && Math.abs(Number(details.amount) - Number(deposit.charged_amount ?? deposit.amount)) >= 0.005;
        const tokenConflict = details.token && details.token !== token;
        if (identityConflict || amountConflict || tokenConflict) {
          await db.collection('momo_deposits').update_one(
            { id: deposit.id, status: deposit.status },
            { $set: {
              status: 'quarantined',
              settlement_error: 'paydunya_confirmation_mismatch',
              updated_at: new Date().toISOString(),
            } },
          );
        }
        reply(res, 200, { received: true });
        return true;
      }

      const currency = String(deposit.currency || 'XOF').toUpperCase();
      if (!['XOF', 'XAF'].includes(currency)) {
        await db.collection('momo_deposits').update_one(
          { id: deposit.id, status: deposit.status },
          { $set: {
            status: 'quarantined',
            settlement_error: 'unsupported_paydunya_currency',
            updated_at: new Date().toISOString(),
          } },
        );
        reply(res, 200, { received: true });
        return true;
      }
      const net = Number(deposit.wallet_credit_amount ?? deposit.amount_net ?? deposit.amount);
      const gross = Number(deposit.requested_amount ?? deposit.amount);
      const platformFee = Number(deposit.platform_fee || 0);
      const fee = Number(deposit.total_fee ?? deposit.fee
        ?? (Number(deposit.gateway_fee || 0) + platformFee));
      const gatewayFee = Number(deposit.gateway_fee ?? Math.max(0, fee - platformFee));
      if (!Number.isFinite(net) || net <= 0 || !Number.isFinite(gross)
          || gross <= 0 || net > gross || !Number.isFinite(fee) || fee < 0 || fee > gross
          || !Number.isFinite(gatewayFee) || gatewayFee < 0
          || !Number.isFinite(platformFee) || platformFee < 0
          || Math.abs(gatewayFee + platformFee - fee) >= 0.005) {
        await db.collection('momo_deposits').update_one(
          { id: deposit.id, status: deposit.status },
          { $set: {
            status: 'quarantined',
            settlement_error: 'invalid_paydunya_settlement_amount',
            updated_at: new Date().toISOString(),
          } },
        );
        reply(res, 200, { received: true });
        return true;
      }
      const operationId = `paydunya:deposit:${deposit.id}`;
      const verifiedAt = new Date().toISOString();
      const walletField = `balance_${currency.toLowerCase()}`;
      const reference = `BTP-PD-${String(deposit.id).slice(0, 16)}`;
      const metadata = {
        operation_id: operationId,
        wallet_operation_id: operationId,
        provider: 'paydunya',
        ...(deposit.link_payment_id ? {
          source: 'link_payment',
          link_payment_id: String(deposit.link_payment_id),
        } : {}),
        provider_reference: providerReference(confirmation, deposit.paydunya_reference || token),
        operator: deposit.operator || null,
        operator_name: deposit.operator_name || null,
        country: deposit.country || null,
        phone_number: deposit.phone_number || null,
        customer_name: deposit.full_name || null,
        customer_email: deposit.email || null,
        amount_gross: gross,
        fee,
        gateway_fee: gatewayFee,
        platform_fee: platformFee,
        amount_net: net,
        method: 'mobile_money',
      };
      const mutation = await applyWalletOperation(db, {
        userId: String(deposit.user_id),
        operationId,
        direction: 'credit',
        primaryField: walletField,
        increments: { [walletField]: net },
        aliases: [`paydunya:payment:${token}`],
        legacyMarkers: [['credited_deposit_ids', String(deposit.id)]],
        ledger: {
          id: `paydunya-deposit-${deposit.id}`,
          user_id: String(deposit.user_id),
          type: deposit.link_payment_id ? 'link_payment' : 'deposit',
          direction: 'in',
          amount: net,
          currency,
          status: 'completed',
          reference,
          description: `Dépôt Mobile Money (${deposit.operator || 'PayDunya'})`,
          created_at: deposit.created_at || verifiedAt,
          completed_at: verifiedAt,
          metadata,
        },
      });
      if (['duplicate_event', 'idempotency_conflict'].includes(mutation.state)) {
        await db.collection('momo_deposits').update_one(
          { id: deposit.id },
          { $set: {
            status: 'quarantined',
            settlement_error: 'provider_payment_identity_reused',
            updated_at: verifiedAt,
          } },
        );
        reply(res, 200, { received: true, pending_review: true });
        return true;
      }
      if (!['applied', 'already'].includes(mutation.state)) {
        reply(res, 503, { received: true, retry: true });
        return true;
      }
      await db.collection('momo_deposits').update_one(
        { id: deposit.id },
        { $set: {
          status: 'approved',
          approved_at: verifiedAt,
          updated_at: verifiedAt,
          provider_status: confirmationDetails(confirmation).status,
          provider_transaction_id: providerReference(confirmation, token),
          wallet_snapshot: mutation.snapshot || null,
          ...(mutation.snapshot ? {
            balance_before: mutation.snapshot.balance_before,
            balance_after: mutation.snapshot.balance_after,
          } : {}),
        } },
      );
      if (deposit.link_payment_id) {
        await db.collection('link_payments').update_one(
          { id: String(deposit.link_payment_id), status: { $in: ['creating', 'pending'] } },
          { $set: {
            status: 'paid',
            amount_net: net,
            charged_amount: gross,
            fee,
            gateway_fee: gatewayFee,
            platform_fee: platformFee,
            paid_at: verifiedAt,
            updated_at: verifiedAt,
            wallet_snapshot: mutation.snapshot || null,
            ...(mutation.snapshot ? {
              balance_before: mutation.snapshot.balance_before,
              balance_after: mutation.snapshot.balance_after,
            } : {}),
          } },
        );
      }
      reply(res, 200, { received: true });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 503;
      reply(res, status, { received: Boolean(deposit), retry: status >= 500 });
    }
    return true;
  }

  async function settleDepositById(depositId) {
    const deposit = await db.collection('momo_deposits').find_one(
      { id: String(depositId), provider: 'paydunya' }, { _id: 0 },
    );
    if (!deposit?.paydunya_token || deposit.status === 'approved') return deposit;
    const settings = await db.collection('settings').find_one(
      { id: 'payment_provider_paydunya' }, { _id: 0 },
    );
    if (!settings) return deposit;
    const credentials = loadCredentials(settings, env.SESSION_SECRET || '', env);
    const hash = crypto.createHash('sha512')
      .update(credentials.master_key, 'utf8').digest('hex');
    const payload = Buffer.from(JSON.stringify({
      hash,
      data: { invoice: { token: deposit.paydunya_token } },
    }));
    const internalRequest = Readable.from([payload]);
    internalRequest.method = 'POST';
    internalRequest.url = '/api/webhooks/paydunya';
    internalRequest.headers = { 'content-type': 'application/json' };
    const internalResponse = {
      statusCode: 500,
      writeHead(status) { this.statusCode = status; },
      end(text) { this.body = text ? JSON.parse(text) : null; },
    };
    await handleRoute(internalRequest, internalResponse);
    return db.collection('momo_deposits').find_one(
      { id: String(depositId) }, { _id: 0 },
    ) || deposit;
  }

  return { handleRoute, settleDepositById };
}

module.exports = {
  createPaydunyaWebhookRoutes,
  staticHashValid,
  parsePaydunyaWebhook,
  webhookInvoiceToken,
  confirmationValid,
};
