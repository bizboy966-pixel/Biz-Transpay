'use strict';

const { decryptSetting } = require('./provider-settings.cjs');
const { applyWalletOperation } = require('./wallet.cjs');
const {
  FIAT_WALLET_CURRENCY_SET, MOBILE_MONEY_COUNTRY_CURRENCY,
} = require('./supported-currencies.cjs');
const mbiyo = require('./mbiyo-payin.cjs');

const CALLBACK_PATH = '/api/webhooks/mbiyo';
const MAX_BODY_BYTES = 64 * 1024;

function reply(res, status, body) {
  if (res.headersSent) return;
  const data = body === undefined ? '' : JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(data));
  res.end(data);
}

async function readRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Payload too large');
      error.status = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function numeric(value) {
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/[,\s]/g, '');
    if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return NaN;
    value = cleaned;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function sameMoney(left, right) {
  const a = numeric(left);
  const b = numeric(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.000001;
}

function normalizedOperator(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function networkToken(value) {
  const normalized = normalizedOperator(value);
  return ['orange', 'mtn', 'moov', 'wave', 'airtel', 'free', 'qmoney', 'aps']
    .find(token => normalized.includes(token)) || '';
}

function countryToken(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  const aliases = {
    benin: 'BJ', burkinafaso: 'BF', cameroon: 'CM', coteivoire: 'CI',
    ivorycoast: 'CI', democraticrepublicofthecongo: 'CD', congo: 'CG',
    gambia: 'GM', thegambia: 'GM', ghana: 'GH', guinea: 'GN', mali: 'ML',
    nigeria: 'NG', rwanda: 'RW', senegal: 'SN', southafrica: 'ZA', tanzania: 'TZ',
    togo: 'TG', uganda: 'UG', zambia: 'ZM', egypt: 'EG',
  };
  return /^[A-Z]{2}$/.test(String(value || '').trim().toUpperCase())
    ? String(value).trim().toUpperCase() : aliases[normalized] || '';
}

function createMbiyoWebhookRoutes({
  db, env = process.env, sessionSecret = '', fetchImpl = globalThis.fetch,
  now = () => Date.now(), logger = console,
} = {}) {
  const deposits = typeof db?.collection === 'function'
    ? db.collection('momo_deposits') : null;

  async function loadConfig() {
    const config = await db.collection('settings').find_one(
      { id: 'payment_provider_mbiyo' }, { _id: 0 },
    );
    const apiKey = decryptSetting(config, 'api_key', sessionSecret)
      || decryptSetting(config, 'secret_key', sessionSecret)
      || String(env.MBIYO_API_KEY || env.MBIYO_SECRET_KEY || '').trim();
    const webhookSecret = decryptSetting(config, 'webhook_secret', sessionSecret)
      || String(env.MBIYO_WEBHOOK_SECRET || '').trim();
    if (!apiKey || !webhookSecret) {
      throw Object.assign(new Error('Mbiyo credentials unavailable'), { status: 503 });
    }
    return {
      apiKey,
      webhookSecret,
      baseUrl: config?.base_url || env.MBIYO_BASE_URL || mbiyo.BASE_URL,
    };
  }

  async function quarantine(deposit, reason, providerResponse = null) {
    const at = new Date(now()).toISOString();
    await deposits.update_one({
      id: String(deposit.id), provider: 'mbiyo', status: 'pending',
    }, { $set: {
      reconciliation_state: 'quarantined',
      quarantine_reason: String(reason).slice(0, 100),
      ...(providerResponse ? {
        mbiyo_last_provider_status: mbiyo.statusValue(providerResponse).slice(0, 64),
      } : {}),
      next_reconcile_at: null,
      updated_at: at,
    } });
    logger.warn?.('Mbiyo deposit quarantined', { reason });
    return { status: 'pending', reconciliation_state: 'quarantined' };
  }

  function expectedProviderAmount(deposit) {
    return Number(deposit.provider_submitted_amount ?? deposit.charged_amount ?? deposit.amount);
  }

  async function verifyAndSettle(deposit, providerResponse, requestedProviderId = '') {
    const status = mbiyo.statusValue(providerResponse);
    const responseProviderId = mbiyo.transactionId(providerResponse);
    const storedProviderId = String(
      deposit.mbiyo_transaction_id || deposit.provider_transaction_id || '',
    ).trim();
    const providerId = storedProviderId || requestedProviderId || responseProviderId;

    if (!providerId) return { status: 'pending', reason: 'provider_transaction_id_missing' };
    if (storedProviderId && requestedProviderId && storedProviderId !== requestedProviderId) {
      return quarantine(deposit, 'provider_transaction_identity_mismatch', providerResponse);
    }
    if (responseProviderId && responseProviderId !== providerId) {
      return quarantine(deposit, 'provider_transaction_identity_mismatch', providerResponse);
    }

    const orderId = mbiyo.scalarValue(providerResponse, [
      'order_id', 'orderId', 'merchant_order_id', 'merchantOrderId', 'local_order_id',
    ]);
    if (orderId !== null && String(orderId).trim() !== String(deposit.mbiyo_order_id || deposit.id)) {
      return quarantine(deposit, 'provider_order_identity_mismatch', providerResponse);
    }

    const amountValue = mbiyo.scalarValue(providerResponse, [
      'amount', 'paid_amount', 'transaction_amount', 'gross_amount',
    ]);
    const expectedAmount = expectedProviderAmount(deposit);
    if (amountValue !== null && !sameMoney(amountValue, expectedAmount)) {
      return quarantine(deposit, 'provider_amount_mismatch', providerResponse);
    }
    const currencyValue = mbiyo.scalarValue(providerResponse, ['currency', 'currency_code']);
    const currency = String(deposit.currency || '').toUpperCase();
    if (!FIAT_WALLET_CURRENCY_SET.has(currency)
        || MOBILE_MONEY_COUNTRY_CURRENCY[String(deposit.country || '').toUpperCase()] !== currency
        || (currencyValue !== null && String(currencyValue).trim().toUpperCase() !== currency)) {
      return quarantine(deposit, 'provider_currency_mismatch', providerResponse);
    }

    const responseCountry = mbiyo.scalarValue(providerResponse, ['country_code', 'country']);
    if (responseCountry !== null && countryToken(responseCountry)
        && countryToken(responseCountry) !== countryToken(deposit.country)) {
      return quarantine(deposit, 'provider_country_mismatch', providerResponse);
    }
    const responseNetwork = mbiyo.scalarValue(providerResponse, ['network', 'operator', 'operator_code']);
    const responseNetworkToken = networkToken(responseNetwork);
    const expectedNetworkToken = networkToken(deposit.operator)
      || networkToken(deposit.operator_name);
    if (responseNetworkToken && expectedNetworkToken
        && responseNetworkToken !== expectedNetworkToken) {
      return quarantine(deposit, 'provider_network_mismatch', providerResponse);
    }
    const responsePhone = mbiyo.scalarValue(providerResponse, [
      'phone_number', 'phone', 'customer_phone', 'msisdn',
    ]);
    if (responsePhone !== null && deposit.phone_number
        && !mbiyo.sameMobileNumber(responsePhone, deposit.phone_number)) {
      return quarantine(deposit, 'provider_phone_mismatch', providerResponse);
    }

    if (mbiyo.FAILURE_STATUSES.has(status)) {
      const failedAt = new Date(now()).toISOString();
      await deposits.update_one({ id: String(deposit.id), provider: 'mbiyo', status: 'pending' }, {
        $set: {
          status: 'failed',
          provider_status: status,
          failed_reason: 'provider_failed',
          reconciliation_state: 'terminal',
          next_reconcile_at: null,
          updated_at: failedAt,
        },
      });
      return { status: 'failed', provider_status: status };
    }
    if (!mbiyo.SUCCESS_STATUSES.has(status)) {
      const checkedAt = new Date(now()).toISOString();
      await deposits.update_one({ id: String(deposit.id), provider: 'mbiyo', status: 'pending' }, {
        $set: {
          provider_status: status || 'pending',
          mbiyo_last_status_check_at: checkedAt,
          reconciliation_state: 'pending',
          next_reconcile_at: new Date(now() + 30_000).toISOString(),
          updated_at: checkedAt,
        },
      });
      return { status: 'pending', provider_status: status || 'pending' };
    }

    if (!orderId && !storedProviderId) {
      return quarantine(deposit, 'provider_order_identity_missing', providerResponse);
    }
    const userId = String(deposit.user_id || '');
    const amount = Number(deposit.amount);
    const totalFee = Number(deposit.total_fee || 0);
    const net = Number(deposit.wallet_credit_amount
      ?? (String(deposit.fee_bearer || '') === 'client' ? amount : amount - totalFee));
    if (!userId || !Number.isFinite(net) || net <= 0) {
      return quarantine(deposit, 'deposit_accounting_invalid', providerResponse);
    }
    const verifiedAt = new Date(now()).toISOString();
    const operationId = `mbiyo:deposit:${deposit.id}`;
    const walletField = `balance_${currency.toLowerCase()}`;
    const ledgerId = `mbiyo-deposit-${deposit.id}`;
    const mutation = await applyWalletOperation(db, {
      userId,
      operationId,
      direction: 'credit',
      primaryField: walletField,
      increments: { [walletField]: net },
      aliases: [`mbiyo:payment:${providerId}`],
      legacyMarkers: [['credited_deposit_ids', String(deposit.id)]],
      ledger: {
        id: ledgerId,
        user_id: userId,
        type: 'deposit',
        direction: 'in',
        amount: net,
        currency,
        status: 'completed',
        reference: `BTP-MB-${String(deposit.id).slice(0, 16)}`,
        description: `Dépôt Mobile Money (${deposit.operator || 'Mbiyo'})`,
        created_at: deposit.created_at || verifiedAt,
        completed_at: verifiedAt,
        metadata: {
          operation_id: operationId,
          wallet_operation_id: operationId,
          provider: 'mbiyo',
          provider_reference: providerId,
          operator: deposit.operator || null,
          operator_name: deposit.operator_name || null,
          country: String(deposit.country || '').toUpperCase(),
          country_code: String(deposit.country || '').toUpperCase(),
          phone_number: deposit.phone_number || null,
          customer_name: deposit.full_name || null,
          customer_email: deposit.email || null,
          amount_gross: amount,
          fee: totalFee,
          gateway_fee: Number(deposit.gateway_fee || 0),
          platform_fee: Number(deposit.platform_fee || 0),
          amount_net: net,
          method: 'mobile_money',
        },
      },
    });
    if (mutation.state === 'duplicate_event') {
      return quarantine(deposit, 'provider_payment_identity_reused', providerResponse);
    }
    if (!['applied', 'already'].includes(mutation.state)) {
      throw Object.assign(new Error('Wallet settlement unavailable'), { status: 503 });
    }
    await deposits.update_one({ id: String(deposit.id), provider: 'mbiyo', status: 'pending' }, {
      $set: {
        status: 'approved',
        approved_at: verifiedAt,
        updated_at: verifiedAt,
        provider_status: status,
        provider_transaction_id: providerId,
        mbiyo_transaction_id: providerId,
        mbiyo_verified_at: verifiedAt,
        reconciliation_state: 'settled',
        next_reconcile_at: null,
        amount_gross: amount,
        amount_net: net,
        wallet_credit_operation_id: operationId,
      },
    });
    return { status: 'approved', provider_status: status, amount_net: net };
  }

  async function reconcileDepositById(id, { force = false, requestedProviderId = '' } = {}) {
    if (!deposits) throw Object.assign(new Error('Database unavailable'), { status: 503 });
    const deposit = await deposits.find_one({ id: String(id), provider: 'mbiyo' }, { _id: 0 });
    if (!deposit || deposit.status !== 'pending') return deposit || null;
    if (deposit.reconciliation_state === 'quarantined') return deposit;
    if (deposit.mbiyo_reconcile_paused === true) return deposit;
    const nowMs = now();
    const expiresAt = Date.parse(deposit.pending_expires_at || '');
    if (Number.isFinite(expiresAt) && expiresAt <= nowMs) {
      const expiredAt = new Date(nowMs).toISOString();
      await deposits.update_one({ id: String(id), provider: 'mbiyo', status: 'pending' }, {
        $set: {
          status: 'failed',
          provider_status: 'confirmation_timeout',
          failed_reason: 'confirmation_timeout',
          reconciliation_state: 'expired',
          next_reconcile_at: null,
          updated_at: expiredAt,
        },
      });
      return { ...deposit, status: 'failed', failed_reason: 'confirmation_timeout' };
    }
    const scheduledAt = Date.parse(deposit.next_reconcile_at || '');
    if (!force && Number.isFinite(scheduledAt) && scheduledAt > nowMs) return deposit;
    const providerId = String(
      requestedProviderId || deposit.mbiyo_transaction_id || deposit.provider_transaction_id || '',
    ).trim();
    if (!providerId) {
      const checkedAt = new Date(nowMs).toISOString();
      await deposits.update_one({ id: String(id), provider: 'mbiyo', status: 'pending' }, {
        $set: {
          mbiyo_last_status_check_at: checkedAt,
          reconciliation_state: 'awaiting_provider_reference',
          next_reconcile_at: new Date(nowMs + 30_000).toISOString(),
          updated_at: checkedAt,
        },
      });
      return { ...deposit, reconciliation_state: 'awaiting_provider_reference' };
    }
    const credentials = await loadConfig();
    let response;
    try {
      response = await mbiyo.requestMbiyo({
        apiKey: credentials.apiKey,
        baseUrl: credentials.baseUrl,
        fetchImpl,
        method: 'GET',
        path: `merchant/transactions/${encodeURIComponent(providerId)}`,
      });
    } catch (error) {
      const failedCheckAt = new Date(now()).toISOString();
      await deposits.update_one({ id: String(id), provider: 'mbiyo', status: 'pending' }, {
        $set: {
          mbiyo_last_status_error: error.outcomeUnknown ? 'provider_status_unavailable' : 'provider_status_failed',
          mbiyo_last_status_check_at: failedCheckAt,
          next_reconcile_at: new Date(now() + 60_000).toISOString(),
          updated_at: failedCheckAt,
        },
      }).catch(() => {});
      throw error;
    }
    if (!deposit.mbiyo_transaction_id && !deposit.provider_transaction_id) {
      const confirmedOrderId = mbiyo.scalarValue(response, [
        'order_id', 'orderId', 'merchant_order_id', 'merchantOrderId', 'local_order_id',
      ]);
      if (String(confirmedOrderId || '').trim() !== String(deposit.mbiyo_order_id || deposit.id)) {
        return quarantine(deposit, 'callback_reference_not_confirmed', response);
      }
      await deposits.update_one({ id: String(id), provider: 'mbiyo', status: 'pending' }, {
        $set: {
          mbiyo_transaction_id: providerId,
          provider_transaction_id: providerId,
          provider_reference: providerId,
          provider_binding_verified: true,
          updated_at: new Date(now()).toISOString(),
        },
      });
      deposit.mbiyo_transaction_id = providerId;
      deposit.provider_transaction_id = providerId;
    }
    return verifyAndSettle(deposit, response, providerId);
  }

  async function reconcileOrder(orderId) {
    return reconcileDepositById(String(orderId), { force: true });
  }

  async function finalizeDepositById(deposit, otp) {
    const code = String(otp || '').trim();
    if (!deposit?.id || deposit.status !== 'pending'
        || !(deposit.auth_mode === 'pin' || deposit.otp_required)) {
      throw Object.assign(new Error('Ce dépôt ne demande pas de code de confirmation.'), {
        status: 409,
      });
    }
    if (!code || code.length > 32) {
      throw Object.assign(new Error('Le code de confirmation est invalide.'), { status: 422 });
    }
    if (['submitting', 'submitted', 'outcome_unknown'].includes(deposit.challenge_status)) {
      throw Object.assign(new Error('La confirmation a déjà été envoyée; vérifiez le statut du dépôt.'), {
        status: 409,
      });
    }
    const providerId = String(
      deposit.mbiyo_transaction_id || deposit.provider_transaction_id || '',
    ).trim();
    if (!providerId) {
      throw Object.assign(new Error('Référence de transaction Mbiyo manquante.'), { status: 409 });
    }
    const credentials = await loadConfig();
    const claimed = await deposits.update_one({
      id: String(deposit.id),
      provider: 'mbiyo',
      status: 'pending',
      otp_required: true,
      challenge_status: deposit.challenge_status || 'pending',
    }, { $set: {
      challenge_status: 'submitting',
      mbiyo_finalize_started_at: new Date(now()).toISOString(),
      updated_at: new Date(now()).toISOString(),
    } });
    if (claimed.modified_count !== 1) {
      throw Object.assign(new Error('Une confirmation est déjà en cours.'), { status: 409 });
    }
    try {
      await mbiyo.requestMbiyo({
        apiKey: credentials.apiKey,
        baseUrl: credentials.baseUrl,
        fetchImpl,
        method: 'POST',
        path: `merchant/transactions/${encodeURIComponent(providerId)}/finalize`,
        body: { otp: code },
      });
    } catch (error) {
      const rejected = Number(error?.providerStatusCode) > 0
        && Number(error.providerStatusCode) < 500;
      const failedAt = new Date(now()).toISOString();
      await deposits.update_one({
        id: String(deposit.id), provider: 'mbiyo', status: 'pending',
        challenge_status: 'submitting',
      }, { $set: {
        challenge_status: rejected ? 'required' : 'outcome_unknown',
        otp_required: rejected,
        auth_mode: rejected ? 'pin' : null,
        mbiyo_finalize_error: rejected ? 'provider_rejected_otp' : 'provider_outcome_unknown',
        ...(rejected ? {} : { next_reconcile_at: failedAt }),
        updated_at: failedAt,
      } });
      if (rejected) {
        throw Object.assign(new Error('Mbiyo a refusé le code de confirmation.'), {
          status: 422,
        });
      }
      try { await reconcileDepositById(deposit.id, { force: true }); } catch { /* worker retries */ }
      return { status: 'pending', challenge_status: 'outcome_unknown' };
    }

    const submittedAt = new Date(now()).toISOString();
    await deposits.update_one({
      id: String(deposit.id), provider: 'mbiyo', status: 'pending',
      challenge_status: 'submitting',
    }, { $set: {
      challenge_status: 'submitted',
      otp_required: false,
      auth_mode: null,
      mbiyo_finalize_submitted_at: submittedAt,
      next_reconcile_at: submittedAt,
      updated_at: submittedAt,
    } });
    try { return await reconcileDepositById(deposit.id, { force: true }); } catch {
      return { status: 'pending', challenge_status: 'submitted' };
    }
  }

  async function handleRoute(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== CALLBACK_PATH) return false;
    if (req.method === 'GET' || req.method === 'HEAD') {
      reply(res, 200, { ok: true });
      return true;
    }
    if (req.method !== 'POST') {
      reply(res, 405, { error: 'Méthode non autorisée.' });
      return true;
    }
    try {
      const raw = await readRawBody(req);
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); } catch {
        reply(res, 400, { error: 'Notification invalide.' });
        return true;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        reply(res, 400, { error: 'Notification invalide.' });
        return true;
      }
      const credentials = await loadConfig();
      const signature = req.headers?.signature
        || req.headers?.['x-mbiyo-signature']
        || req.headers?.['x-signature'];
      if (!mbiyo.verifySignature(raw, signature, credentials.webhookSecret)) {
        reply(res, 401, { error: 'Signature invalide.' });
        return true;
      }
      const reference = String(
        url.searchParams.get('ref')
        || mbiyo.scalarValue(payload, [
          'order_id', 'orderId', 'merchant_order_id', 'merchantOrderId', 'local_order_id',
        ])
        || '',
      ).trim();
      const providerId = mbiyo.transactionId(payload);
      let deposit = reference
        ? await deposits.find_one({ id: reference, provider: 'mbiyo' }, { _id: 0 })
        : null;
      if (!deposit && providerId) {
        deposit = await deposits.find_one({
          provider: 'mbiyo',
          $or: [{ mbiyo_transaction_id: providerId }, { provider_transaction_id: providerId }],
        }, { _id: 0 });
      }
      if (!deposit) {
        reply(res, 200, { ok: true });
        return true;
      }
      const storedId = String(deposit.mbiyo_transaction_id || deposit.provider_transaction_id || '');
      if (storedId && providerId && storedId !== providerId) {
        await quarantine(deposit, 'callback_transaction_identity_mismatch', payload);
        reply(res, 200, { ok: true });
        return true;
      }
      if (!storedId && !providerId) {
        reply(res, 200, { ok: true });
        return true;
      }
      await reconcileDepositById(deposit.id, {
        force: true,
        requestedProviderId: storedId || providerId,
      });
      reply(res, 200, { ok: true });
    } catch (error) {
      logger.warn?.('Mbiyo callback processing failed', {
        status: Number(error?.status) || 503,
      });
      reply(res, Number(error?.status) === 413 ? 413 : 503, {
        error: 'Notification enregistrée pour vérification.',
      });
    }
    return true;
  }

  return {
    handleRoute,
    reconcileDepositById,
    reconcileOrder,
    finalizeDepositById,
  };
}

module.exports = { createMbiyoWebhookRoutes, CALLBACK_PATH };
