'use strict';

const crypto = require('node:crypto');
const security = require('./security.cjs');
const { applyWalletOperation } = require('./wallet.cjs');
const { calculateFees, loadCredentials } = require('./paydunya-invoice-routes.cjs');

function failure(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

function decryptSetting(config, field, sessionSecret) {
  const encrypted = config?.[`${field}_encrypted`];
  if (!encrypted) return String(config?.[field] || '').trim();
  if (!sessionSecret) throw failure(503, 'Identifiants du prestataire indisponibles.');
  try {
    return security.decryptFernet(encrypted, security.fernetKey(sessionSecret));
  } catch {
    throw failure(503, 'Identifiants du prestataire illisibles.');
  }
}

async function responseJson(response) {
  const text = await response.text();
  if (text.length > 256_000) throw failure(502, 'Réponse prestataire trop volumineuse.');
  try { return JSON.parse(text); } catch { throw failure(502, 'Réponse prestataire invalide.'); }
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function providerStatus(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  return String(data?.status || data?.state || payload?.status || '').trim().toLowerCase();
}

function providerId(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  return String(data?.transaction_id || data?.id || data?.reference || '').trim();
}

function createMobileMoneyPayoutService({
  db, sessionSecret = '', env = process.env, fetchImpl = globalThis.fetch,
}) {
  async function createIntegrationPayout(userId, body, idempotencyKey) {
    const ownerId = String(userId || '');
    const country = String(body.country || '').trim().toUpperCase();
    const operatorCode = String(body.operator || '').trim().toLowerCase();
    const currency = String(body.currency || '').trim().toUpperCase();
    const recipient = String(body.recipient || '').trim();
    const amount = Number(body.amount);
    const feeBearer = String(body.fee_bearer || 'sender').trim().toLowerCase();
    const key = String(idempotencyKey || '').trim();
    if (!ownerId || !/^[A-Z]{2}$/.test(country) || !operatorCode
        || !['XOF', 'XAF'].includes(currency) || !recipient
        || recipient.length > 40 || !Number.isSafeInteger(amount) || amount <= 0
        || !['sender', 'receiver'].includes(feeBearer)
        || !/^[A-Za-z0-9._-]{8,128}$/.test(key)) {
      throw failure(422, 'Informations de retrait Mobile Money invalides.');
    }
    const user = await db.collection('users').find_one({ id: ownerId }, { _id: 0 });
    if (!user || user.kyc_status !== 'verified' || user.is_banned || user.is_blocked) {
      throw failure(403, 'Compte vérifié et actif requis pour un retrait.');
    }
    const settings = db.collection('settings');
    const [transferConfig, paydunya, mbiyo, afribapay] = await Promise.all([
      settings.find_one({ id: 'transfer_config' }, { _id: 0 }),
      settings.find_one({ id: 'payment_provider_paydunya' }, { _id: 0 }),
      settings.find_one({ id: 'payment_provider_mbiyo' }, { _id: 0 }),
      settings.find_one({ id: 'payment_provider_afribapay' }, { _id: 0 }),
    ]);
    const section = transferConfig?.mobile_money || {};
    if (!section.enabled) throw failure(403, 'Les retraits Mobile Money sont désactivés.');
    const candidates = (Array.isArray(section.operators) ? section.operators : [])
      .filter(row => row && row.active !== false && !row.archived && !row.hidden
        && String(row.country || '').toUpperCase() === country
        && String(row.public_code || row.code || '').toLowerCase().replace(/^mbiyo_/, '') === operatorCode
        && String(row.currency || '').toUpperCase() === currency);
    const enabledProvider = {
      paydunya: Boolean(paydunya?.enabled),
      mbiyo: Boolean(mbiyo?.enabled),
      afribapay: Boolean(afribapay?.enabled),
    };
    const operator = candidates.find(row => enabledProvider[String(row.provider || 'paydunya').toLowerCase()]);
    if (!operator) throw failure(422, 'Opérateur Mobile Money non disponible pour ce pays.');
    const provider = String(operator.provider || 'paydunya').toLowerCase();
    const walletField = `balance_${currency.toLowerCase()}`;
    if (!Object.hasOwn(user, walletField)) throw failure(422, 'Portefeuille non disponible.');
    const fees = calculateFees(amount, operator, feeBearer);
    const totalDebit = Number(fees.charged_amount);
    const recipientGets = Number(fees.wallet_credit_amount);
    if (!Number.isFinite(totalDebit) || totalDebit <= 0
        || !Number.isFinite(recipientGets) || recipientGets <= 0) {
      throw failure(422, 'Frais de retrait invalides.');
    }
    const fingerprint = crypto.createHash('sha256')
      .update(JSON.stringify({
        amount, country, operator: operatorCode, currency, recipient, fee_bearer: feeBearer,
      })).digest('hex');
    const txId = `wd_${crypto.createHash('sha256')
      .update(`${ownerId}:${key}`).digest('hex').slice(0, 32)}`;
    const transactions = db.collection('transactions');
    const previous = await transactions.find_one({ id: txId, user_id: ownerId }, { _id: 0 });
    if (previous) {
      if (previous.metadata?.request_fingerprint !== fingerprint) {
        throw failure(409, 'Cette clé d’idempotence est déjà associée à un autre retrait.');
      }
      return { transaction: previous, idempotent_replay: true };
    }

    const now = new Date().toISOString();
    const operationId = `${provider}-withdrawal:${txId}`;
    const reference = `BTP-WD-${crypto.createHash('sha256').update(txId).digest('hex').slice(0, 12).toUpperCase()}`;
    const transaction = {
      id: txId, user_id: ownerId, type: 'withdrawal', direction: 'out',
      amount, currency, status: 'pending', counterparty: recipient, reference,
      description: String(body.description || '').slice(0, 300),
      created_at: now,
      metadata: {
        transfer_type: 'biz_to_mobile', provider, provider_name: operator.name || operatorCode,
        country, operator: operatorCode, recipient_phone: recipient,
        fee: Number(fees.total_fee || 0), gateway_fee: Number(fees.gateway_fee || 0),
        platform_fee: Number(fees.platform_fee || 0), recipient_gets: recipientGets,
        total_debit: totalDebit, fee_snapshot: fees, wallet_field: walletField,
        operation_id: operationId, wallet_operation_id: operationId,
        idempotency_key: key, request_fingerprint: fingerprint,
        submission_phase: 'not_submitted',
      },
    };
    const debit = await applyWalletOperation(db, {
      userId: ownerId, operationId, direction: 'debit', primaryField: walletField,
      increments: { [walletField]: -totalDebit },
      requiredBalanceField: walletField, requiredBalanceAmount: totalDebit,
      ledger: transaction,
    });
    if (debit.state === 'insufficient') throw failure(400, 'Solde insuffisant, frais inclus.');
    if (!['applied', 'already'].includes(debit.state)) {
      throw failure(503, 'Le retrait n’a pas pu être réservé en toute sécurité.');
    }
    await transactions.update_one({ id: txId, user_id: ownerId }, { $set: {
      'metadata.wallet_snapshot': debit.snapshot || null,
      'metadata.balance_before': debit.snapshot?.balance_before ?? null,
      'metadata.balance_after': debit.snapshot?.balance_after ?? null,
      'metadata.submission_phase': 'dispatching',
    } });

    const callbackOrigin = String(
      env.OFFICIAL_DOMAIN || env.BIZTRANSPAY_PUBLIC_URL || '',
    ).trim().replace(/\/+$/, '');
    if (!/^https:\/\/[^/]+$/i.test(callbackOrigin)) {
      await transactions.update_one({ id: txId }, { $set: {
        'metadata.submission_phase': 'manual_review',
        'metadata.manual_review_required': true,
        'metadata.manual_review_reason': 'callback_origin_not_configured',
      } });
      return {
        transaction: await transactions.find_one({ id: txId }, { _id: 0 }),
        pending_manual: true,
      };
    }
    const callbackUrl = `${callbackOrigin}/api/webhooks/${provider === 'paydunya' ? 'paydunya/disbursement' : provider}?ref=${encodeURIComponent(txId)}`;
    let upstream;
    try {
      if (provider === 'paydunya') {
        const credentials = loadCredentials(paydunya, sessionSecret, env);
        const base = paydunya.mode === 'live'
          ? 'https://app.paydunya.com' : 'https://app.paydunya.com';
        const alias = digits(recipient);
        if (alias.length < 6 || alias.length > 15 || !operator.withdraw_mode) {
          throw failure(422, 'Numéro ou mode de retrait PayDunya invalide.');
        }
        const headers = {
          'PAYDUNYA-MASTER-KEY': credentials.master_key,
          'PAYDUNYA-PRIVATE-KEY': credentials.private_key,
          'PAYDUNYA-TOKEN': credentials.token,
          'Content-Type': 'application/json', Accept: 'application/json',
        };
        const invoiceResponse = await fetchImpl(`${base}/api/v2/disburse/get-invoice`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers,
          body: JSON.stringify({
            account_alias: alias,
            amount: Math.round(recipientGets),
            withdraw_mode: operator.withdraw_mode,
            callback_url: callbackUrl,
          }),
        });
        const invoice = await responseJson(invoiceResponse);
        if (!invoiceResponse.ok || String(invoice.response_code || '').padStart(2, '0') !== '00') {
          throw failure(502, 'PayDunya n’a pas créé le retrait.');
        }
        const token = String(invoice.token || invoice.disburse_invoice || invoice.invoice_token || '');
        if (!token) throw failure(502, 'Référence de retrait PayDunya absente.');
        await transactions.update_one({ id: txId }, { $set: {
          'metadata.paydunya_invoice_token': token,
          'metadata.paydunya_status': 'created',
        } });
        const submitResponse = await fetchImpl(`${base}/api/v2/disburse/submit-invoice`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers, body: JSON.stringify({ disburse_invoice: token, disburse_id: txId }),
        });
        upstream = await responseJson(submitResponse);
        if (!submitResponse.ok || String(upstream.response_code || '').padStart(2, '0') !== '00') {
          throw failure(502, 'Réponse PayDunya non confirmée; retrait conservé en attente.');
        }
      } else if (provider === 'mbiyo') {
        const apiKey = decryptSetting(mbiyo, 'api_key', sessionSecret)
          || decryptSetting(mbiyo, 'secret_key', sessionSecret);
        const base = String(mbiyo.base_url || env.MBIYO_BASE_URL
          || 'https://dashboard.mbiyo.africa/api/v1').replace(/\/+$/, '');
        if (!apiKey) throw failure(503, 'Clé Mbiyo non configurée.');
        const response = await fetchImpl(`${base}/merchant/payout`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            amount: recipientGets, currency, payment_method: 'mobile_money',
            order_id: txId, callback_url: callbackUrl,
            metadata: {
              network: operator.network || operator.operator || operatorCode,
              phone_number: recipient, country_code: country,
              beneficiary: String(body.recipient_name || user.full_name || recipient),
            },
          }),
        });
        upstream = await responseJson(response);
        if (!response.ok) throw failure(502, 'Réponse Mbiyo non confirmée; retrait conservé en attente.');
      } else if (provider === 'afribapay') {
        const apiUser = decryptSetting(afribapay, 'api_user', sessionSecret);
        const apiKey = decryptSetting(afribapay, 'api_key', sessionSecret);
        const merchantKey = decryptSetting(afribapay, 'merchant_key', sessionSecret);
        const apiBase = String(afribapay.live_api_base_url || afribapay.api_base_url || '').replace(/\/+$/, '');
        const payoutBase = String(afribapay.live_payout_base_url || afribapay.payout_base_url || '').replace(/\/+$/, '');
        if (!apiUser || !apiKey || !merchantKey || !apiBase || !payoutBase) {
          throw failure(503, 'Configuration AfriBaPay de retrait incomplète.');
        }
        const tokenResponse = await fetchImpl(`${apiBase}/v1/token`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: { authorization: `Basic ${Buffer.from(`${apiUser}:${apiKey}`).toString('base64')}`, accept: 'application/json' },
        });
        const tokenPayload = await responseJson(tokenResponse);
        const accessToken = String(tokenPayload?.data?.access_token || '');
        if (!tokenResponse.ok || !accessToken) throw failure(502, 'Jeton AfriBaPay indisponible.');
        const response = await fetchImpl(`${payoutBase}/v1/pay/payout`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
          headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            operator: operator.operator || operatorCode, country, phone_number: recipient,
            amount: recipientGets, currency, order_id: txId, reference_id: key,
            notify_url: callbackUrl, merchant_key: merchantKey,
          }),
        });
        upstream = await responseJson(response);
        if (!response.ok) throw failure(502, 'Réponse AfriBaPay non confirmée; retrait conservé en attente.');
      } else {
        throw failure(503, 'Prestataire de retrait non pris en charge.');
      }
    } catch (error) {
      await transactions.update_one({ id: txId, status: 'pending' }, { $set: {
        'metadata.submission_phase': 'outcome_unknown',
        'metadata.manual_review_required': true,
        'metadata.provider_error': String(error.message || 'provider error').slice(0, 200),
      } });
      if (error.status && error.status < 500) throw error;
      return {
        transaction: await transactions.find_one({ id: txId }, { _id: 0 }),
        pending_manual: true,
      };
    }
    const upstreamId = providerId(upstream);
    const status = providerStatus(upstream) || 'pending';
    await transactions.update_one({ id: txId, status: 'pending' }, { $set: {
      'metadata.provider_transaction_id': upstreamId || null,
      'metadata.provider_status': status,
      'metadata.submission_phase': upstreamId ? 'provider_id_persisted' : 'response_without_provider_id',
      'metadata.manual_review_required': !upstreamId,
      updated_at: new Date().toISOString(),
    } });
    const saved = await transactions.find_one({ id: txId, user_id: ownerId }, { _id: 0 });
    if (!saved) throw failure(503, 'Retrait enregistré mais transaction introuvable.');
    return { transaction: saved, pending_manual: !upstreamId };
  }

  return { createIntegrationPayout };
}

module.exports = { createMobileMoneyPayoutService };
