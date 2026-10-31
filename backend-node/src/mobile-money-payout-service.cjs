'use strict';

const crypto = require('node:crypto');
const security = require('./security.cjs');
const { applyWalletOperation } = require('./wallet.cjs');
const { calculateFees, loadCredentials } = require('./paydunya-invoice-routes.cjs');
const {
  FIAT_WALLET_CURRENCY_SET, MOBILE_MONEY_COUNTRY_CURRENCY,
} = require('./supported-currencies.cjs');

const PAYDUNYA_CALLBACK_ORIGIN = 'https://biz-transpay.com';

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

const COUNTRY_DIAL_CODES = {
  BF: '226', BJ: '229', CI: '225', CM: '237', CG: '242', CD: '243',
  GA: '241', GN: '224', ML: '223', NE: '227', SN: '221', TG: '228',
  GH: '233', NG: '234', GM: '220', KE: '254', RW: '250', TZ: '255',
  UG: '256', ZA: '27', ZM: '260', EG: '20',
};

function localPhone(value, country) {
  let phone = digits(value);
  if (phone.startsWith('00')) phone = phone.slice(2);
  const dial = COUNTRY_DIAL_CODES[country];
  if (dial && phone.startsWith(dial)) phone = phone.slice(dial.length);
  if (phone.length < 6 || phone.length > 12) {
    throw failure(422, 'Numéro Mobile Money invalide.');
  }
  return phone;
}

function providerStatus(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  return String(data?.status || data?.state || payload?.status || '').trim().toLowerCase();
}

function providerId(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  return String(data?.transaction_id || data?.id || data?.reference || '').trim();
}

function payoutMetadata(transaction) {
  const value = transaction?.metadata;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  return {};
}

function publicPayoutTransaction(transaction) {
  if (!transaction || typeof transaction !== 'object') return transaction;
  if (!Object.hasOwn(transaction, 'metadata')) return transaction;
  if (typeof transaction.metadata === 'string') {
    const metadata = { ...payoutMetadata(transaction) };
    delete metadata.paydunya_invoice_token;
    return { ...transaction, metadata };
  }
  if (!transaction.metadata || typeof transaction.metadata !== 'object'
      || Array.isArray(transaction.metadata)) {
    const safe = { ...transaction };
    delete safe.metadata;
    return safe;
  }
  const metadata = { ...transaction.metadata };
  delete metadata.paydunya_invoice_token;
  return { ...transaction, metadata };
}

const PAYDUNYA_WITHDRAW_MODES = new Set([
  'paydunya', 'orange-money-senegal', 'free-money-senegal', 'expresso-senegal',
  'wave-senegal', 'mtn-benin', 'moov-benin', 'celtiis-cash', 'mtn-ci',
  'orange-money-ci', 'moov-ci', 'wave-ci', 't-money-togo', 'moov-togo',
  'orange-money-mali', 'orange-money-burkina', 'moov-burkina-faso',
  'mtn-cameroun', 'djamo-ci', 'djamo-sn',
]);

const PAYDUNYA_WITHDRAW_MODE_ALIASES = {
  'mtn-bj': 'mtn-benin',
  'moov-bj': 'moov-benin',
  'celtiis-bj': 'celtiis-cash',
  celtiis: 'celtiis-cash',
  'orange-sn': 'orange-money-senegal',
  'free-sn': 'free-money-senegal',
  'wave-sn': 'wave-senegal',
  'expresso-sn': 'expresso-senegal',
  'orange-ci': 'orange-money-ci',
  'orange-ml': 'orange-money-mali',
  'orange-bf': 'orange-money-burkina',
  'moov-bf': 'moov-burkina-faso',
  'mtn-cm': 'mtn-cameroun',
  'moov-tg': 'moov-togo',
  'togocel': 't-money-togo',
  'togocel-tg': 't-money-togo',
  'tmoney': 't-money-togo',
  'tmoney-tg': 't-money-togo',
  't-money': 't-money-togo',
};

const PAYDUNYA_MODE_COUNTRIES = {
  'orange-money-senegal': 'SN',
  'free-money-senegal': 'SN',
  'expresso-senegal': 'SN',
  'wave-senegal': 'SN',
  'djamo-sn': 'SN',
  'mtn-benin': 'BJ',
  'moov-benin': 'BJ',
  'celtiis-cash': 'BJ',
  'mtn-ci': 'CI',
  'orange-money-ci': 'CI',
  'moov-ci': 'CI',
  'wave-ci': 'CI',
  'djamo-ci': 'CI',
  't-money-togo': 'TG',
  'moov-togo': 'TG',
  'orange-money-mali': 'ML',
  'orange-money-burkina': 'BF',
  'moov-burkina-faso': 'BF',
  'mtn-cameroun': 'CM',
};

const PAYDUNYA_OPERATOR_MODES = {
  'orange-sn': 'orange-money-senegal',
  'free-sn': 'free-money-senegal',
  'moov-sn': 'free-money-senegal',
  'wave-sn': 'wave-senegal',
  'djamo-sn': 'djamo-sn',
  'mtn-bj': 'mtn-benin',
  'moov-bj': 'moov-benin',
  'celtiis-bj': 'celtiis-cash',
  'mtn-ci': 'mtn-ci',
  'orange-ci': 'orange-money-ci',
  'moov-ci': 'moov-ci',
  'wave-ci': 'wave-ci',
  'djamo-ci': 'djamo-ci',
  'tmoney': 't-money-togo',
  'tmoney-tg': 't-money-togo',
  'togocel': 't-money-togo',
  'togocel-tg': 't-money-togo',
  't-money-togo': 't-money-togo',
  'moov-tg': 'moov-togo',
  'moov-togo': 'moov-togo',
  'orange-ml': 'orange-money-mali',
  'orange-bf': 'orange-money-burkina',
  'moov-bf': 'moov-burkina-faso',
  'mtn-cm': 'mtn-cameroun',
};

function paydunyaWithdrawMode(operator, country, operatorCode) {
  const raw = String(
    operator.withdraw_mode || operator.code || operator.public_code || '',
  ).trim().toLowerCase().replace(/^paydunya[_-]/, '').replace(/_/g, '-');
  const mode = PAYDUNYA_WITHDRAW_MODE_ALIASES[raw] || raw;
  if (!PAYDUNYA_WITHDRAW_MODES.has(mode)) {
    throw failure(
      422,
      'Le mode de retrait PayDunya configuré n’est pas pris en charge.',
      'PAYDUNYA_WITHDRAW_MODE_INVALID',
    );
  }
  const routeCode = String(operatorCode || operator.code || operator.public_code || '')
    .trim().toLowerCase().replace(/^paydunya[_-]/, '').replace(/_/g, '-');
  const expectedMode = PAYDUNYA_OPERATOR_MODES[routeCode];
  if ((expectedMode && expectedMode !== mode)
      || (PAYDUNYA_MODE_COUNTRIES[mode]
        && PAYDUNYA_MODE_COUNTRIES[mode] !== String(country || '').toUpperCase())) {
    throw failure(
      422,
      'Le mode de retrait PayDunya ne correspond pas au pays et à l’opérateur choisis.',
      'PAYDUNYA_WITHDRAW_MODE_MISMATCH',
    );
  }
  return mode;
}

function paydunyaResponseCode(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const code = String(data?.response_code || data?.responseCode || '').trim();
  return code ? code.padStart(2, '0') : '';
}

function paydunyaResponseText(payload) {
  return String(providerField(payload, ['response_text', 'response_message']) || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function providerField(payload, names) {
  const wanted = new Set(names.map(name => name.toLowerCase()));
  const queue = [payload];
  const seen = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      if (wanted.has(key.toLowerCase()) && child !== null && child !== undefined) {
        return child;
      }
      if (child && typeof child === 'object') queue.push(child);
    }
  }
  return '';
}

async function submitPaydunyaInvoice(fetchImpl, base, headers, token, disbursementId) {
  const response = await fetchImpl(`${base}/api/v2/disburse/submit-invoice`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers,
    body: JSON.stringify({ disburse_invoice: token, disburse_id: disbursementId }),
  });
  const payload = await responseJson(response);
  return {
    accepted: response.ok && paydunyaResponseCode(payload) === '00',
    payload,
    responseCode: paydunyaResponseCode(payload),
  };
}

async function checkPaydunyaDisbursement(
  fetchImpl, base, headers, { token, mode, amount, disbursementId },
) {
  try {
    const response = await fetchImpl(`${base}/api/v2/disburse/check-status`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
      headers,
      body: JSON.stringify({ disburse_invoice: token }),
    });
    const payload = await responseJson(response);
    const returnedToken = String(providerField(payload, [
      'token', 'disburse_token', 'disburse_invoice',
    ]) || '').trim();
    const returnedMode = String(providerField(payload, [
      'withdraw_mode', 'withdrawMode',
    ]) || '').trim().toLowerCase();
    const returnedAmount = Number(providerField(payload, ['amount']));
    const returnedDisbursementId = String(providerField(payload, [
      'disburse_id', 'disbursement_id',
    ]) || '').trim();
    const verified = response.ok
      && paydunyaResponseCode(payload) === '00'
      && returnedToken === token
      && Number.isFinite(returnedAmount)
      && Math.abs(returnedAmount - amount) < 0.005
      && returnedMode === mode
      && (!returnedDisbursementId || returnedDisbursementId === disbursementId);
    return {
      verified,
      payload,
      status: providerStatus(payload),
      responseCode: paydunyaResponseCode(payload),
    };
  } catch {
    return { verified: false, payload: null, status: '', responseCode: '' };
  }
}

function createMobileMoneyPayoutService({
  db, sessionSecret = '', env = process.env, fetchImpl = globalThis.fetch,
}) {
  async function refundRejectedPayout(transaction, statusValue) {
    const metadata = payoutMetadata(transaction);
    const provider = String(metadata.provider || '');
    const walletField = String(metadata.wallet_field
      || `balance_${String(transaction?.currency || '').toLowerCase()}`);
    const amount = Number(metadata.total_debit);
    if (!transaction?.id || !transaction.user_id
        || !Number.isFinite(amount) || amount <= 0
        || !/^balance_[a-zA-Z0-9_]+$/.test(walletField)) {
      throw failure(503, 'Le remboursement du retrait doit être vérifié.');
    }
    const operationId = `${provider}-withdrawal-refund:${transaction.id}`;
    const requestFingerprint = crypto.createHash('sha256')
      .update(`${transaction.id}:${amount}:${walletField}`).digest('hex');
    const verifiedAt = new Date().toISOString();
    const refund = await applyWalletOperation(db, {
      userId: String(transaction.user_id), operationId,
      direction: 'credit', primaryField: walletField,
      increments: { [walletField]: amount }, requestFingerprint,
      ledger: {
        id: `payout-refund-${transaction.id}`,
        user_id: String(transaction.user_id), type: 'refund', direction: 'in',
        amount, currency: String(transaction.currency || '').toUpperCase(),
        status: 'completed', reference: `REF-${transaction.reference || transaction.id}`,
        description: 'Remboursement du retrait Mobile Money refusé',
        created_at: verifiedAt, completed_at: verifiedAt,
        metadata: {
          original_transaction_id: String(transaction.id),
          provider, provider_status: String(statusValue || 'rejected'),
          operation_id: operationId, wallet_operation_id: operationId,
        },
      },
    });
    if (!['applied', 'already'].includes(refund.state)) {
      throw failure(503, 'Le remboursement du retrait doit être réconcilié.');
    }
    await db.collection('transactions').update_one(
      { id: String(transaction.id), status: 'pending' },
      { $set: {
        status: 'failed', completed_at: verifiedAt, updated_at: verifiedAt,
        'metadata.provider_status': String(statusValue || 'rejected'),
        'metadata.refunded': true,
         'metadata.manual_review_required': false,
        'metadata.refund_operation_id': operationId,
        'metadata.refund_wallet_snapshot': refund.snapshot || null,
      } },
    );
    return db.collection('transactions').find_one(
      { id: String(transaction.id), user_id: String(transaction.user_id) },
      { _id: 0 },
    );
  }

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
        || !FIAT_WALLET_CURRENCY_SET.has(currency)
        || MOBILE_MONEY_COUNTRY_CURRENCY[country] !== currency || !recipient
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
    const [transferConfig, paydunya, mbiyo, afribapay, features] = await Promise.all([
      settings.find_one({ id: 'transfer_config' }, { _id: 0 }),
      settings.find_one({ id: 'payment_provider_paydunya' }, { _id: 0 }),
      settings.find_one({ id: 'payment_provider_mbiyo' }, { _id: 0 }),
      settings.find_one({ id: 'payment_provider_afribapay' }, { _id: 0 }),
      settings.find_one({ id: 'app_features' }, { _id: 0 }),
    ]);
    const section = transferConfig?.mobile_money || {};
    if (!section.enabled) throw failure(403, 'Les retraits Mobile Money sont désactivés.');
    const walletFlag = `wallet_${currency.toLowerCase()}_enabled`;
    const withdrawalFlag = `withdrawal_${currency.toLowerCase()}_enabled`;
    if (features?.[walletFlag] === false || features?.[withdrawalFlag] === false) {
      throw failure(403, 'Les retraits ne sont pas activés pour ce portefeuille.');
    }
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
    const minimum = Number(operator.min) > 0 ? Number(operator.min) : 100;
    const maximum = Number(operator.max) > 0 ? Number(operator.max) : Infinity;
    if (amount < minimum || amount > maximum) {
      throw failure(422, `Le montant doit être compris entre ${minimum} et ${Number.isFinite(maximum) ? maximum : 'sans plafond'} ${currency}.`);
    }
    const provider = String(operator.provider || 'paydunya').toLowerCase();
    const walletField = `balance_${currency.toLowerCase()}`;
    if (!Object.hasOwn(user, walletField)) throw failure(422, 'Portefeuille non disponible.');
    let paydunyaCredentials;
    let paydunyaMode;
    let mbiyoApiKey;
    let afribapayCredentials;
    let providerPhone = recipient;
    if (provider === 'paydunya') {
      if (String(paydunya?.mode || '').toLowerCase() !== 'live'
          || !operator.withdraw_mode) {
        throw failure(503, 'PayDunya production ou mode de retrait non configuré.');
      }
      paydunyaCredentials = loadCredentials(paydunya, sessionSecret, env);
      paydunyaMode = paydunyaWithdrawMode(operator, country, operatorCode);
      providerPhone = localPhone(recipient, country);
    } else if (provider === 'mbiyo') {
      if (String(mbiyo?.mode || '').toLowerCase() !== 'live') {
        throw failure(503, 'Mbiyo doit être configuré en mode production pour les retraits.');
      }
      mbiyoApiKey = decryptSetting(mbiyo, 'api_key', sessionSecret)
        || decryptSetting(mbiyo, 'secret_key', sessionSecret);
      if (!mbiyoApiKey) throw failure(503, 'Clé Mbiyo non configurée.');
      if (country === 'CI' || country === 'ML') providerPhone = localPhone(recipient, country);
    } else if (provider === 'afribapay') {
      if (String(afribapay?.mode || '').toLowerCase() !== 'live') {
        throw failure(503, 'AfriBaPay doit être configuré en mode production pour les retraits.');
      }
      afribapayCredentials = {
        apiUser: decryptSetting(afribapay, 'api_user', sessionSecret),
        apiKey: decryptSetting(afribapay, 'api_key', sessionSecret),
        merchantKey: decryptSetting(afribapay, 'merchant_key', sessionSecret),
        apiBase: String(afribapay.live_api_base_url || afribapay.api_base_url || '').replace(/\/+$/, ''),
        payoutBase: String(afribapay.live_payout_base_url || afribapay.payout_base_url || '').replace(/\/+$/, ''),
      };
      if (!afribapayCredentials.apiUser || !afribapayCredentials.apiKey
          || !afribapayCredentials.merchantKey || !afribapayCredentials.apiBase
          || !afribapayCredentials.payoutBase) {
        throw failure(503, 'Configuration AfriBaPay de retrait incomplète.');
      }
    } else {
      throw failure(503, 'Prestataire de retrait non pris en charge.');
    }
    const fees = calculateFees(amount, operator, feeBearer);
    const totalDebit = Number(fees.charged_amount);
    const recipientGets = Number(fees.wallet_credit_amount);
    if (!Number.isFinite(totalDebit) || totalDebit <= 0
        || !Number.isFinite(recipientGets) || recipientGets <= 0) {
      throw failure(422, 'Frais de retrait invalides.');
    }
    const configuredCallbackOrigin = String(
      env.OFFICIAL_DOMAIN || env.BIZTRANSPAY_PUBLIC_URL || '',
    ).trim().replace(/\/+$/, '');
    if (!/^https:\/\/[^/]+$/i.test(configuredCallbackOrigin)) {
      throw failure(503, 'L’URL publique HTTPS des callbacks doit être configurée avant les retraits.');
    }
    const callbackOrigin = provider === 'paydunya'
      ? PAYDUNYA_CALLBACK_ORIGIN
      : configuredCallbackOrigin;
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
      return { transaction: publicPayoutTransaction(previous), idempotent_replay: true };
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
      requestFingerprint: fingerprint,
      ledger: transaction,
    });
    if (debit.state === 'insufficient') throw failure(400, 'Solde insuffisant, frais inclus.');
    if (!['applied', 'already'].includes(debit.state)) {
      throw failure(503, 'Le retrait n’a pas pu être réservé en toute sécurité.');
    }
    if (debit.state === 'already') {
      const saved = await transactions.find_one({ id: txId, user_id: ownerId }, { _id: 0 });
      if (!saved) throw failure(503, 'Retrait précédemment réservé mais introuvable.');
      return {
        transaction: publicPayoutTransaction(saved),
        idempotent_replay: true,
        pending_manual: true,
      };
    }
    await transactions.update_one({ id: txId, user_id: ownerId }, { $set: {
      'metadata.wallet_snapshot': debit.snapshot || null,
      'metadata.balance_before': debit.snapshot?.balance_before ?? null,
      'metadata.balance_after': debit.snapshot?.balance_after ?? null,
      'metadata.submission_phase': 'dispatching',
    } });

    const callbackUrl = `${callbackOrigin}/api/webhooks/${provider === 'paydunya' ? 'paydunya/disbursement' : provider}?ref=${encodeURIComponent(txId)}`;
    let upstream;
    try {
      if (provider === 'paydunya') {
        const credentials = paydunyaCredentials;
        const base = 'https://app.paydunya.com';
        const alias = providerPhone;
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
            withdraw_mode: paydunyaMode,
            callback_url: callbackUrl,
          }),
        });
        const invoice = await responseJson(invoiceResponse);
        const invoiceAccepted = invoiceResponse.ok
          && paydunyaResponseCode(invoice) === '00';
        if (!invoiceAccepted) {
          const code = paydunyaResponseCode(invoice);
          if (!invoiceResponse.ok && invoiceResponse.status >= 500) {
            throw failure(502, 'Réponse PayDunya incertaine pendant la préparation du retrait.');
          }
          const message = code === '1001'
            ? 'PayDunya ne reconnaît pas le mode de retrait configuré.'
            : code === '401'
              ? 'PayDunya a refusé l’autorisation du compte marchand.'
              : code === '4002'
                ? 'PayDunya n’a pas pu préparer le retrait.'
                : code === '5000'
                  ? 'PayDunya signale une indisponibilité temporaire.'
                  : 'PayDunya a refusé la préparation du retrait.';
          const providerDetail = code === '4002' ? paydunyaResponseText(invoice) : '';
          throw failure(422,
            `${message}${code ? ` (code ${code})` : ''}${providerDetail
              ? ` Détail PayDunya : ${providerDetail}.`
              : ''}`,
            code ? `PAYDUNYA_${code}` : 'PAYDUNYA_INVOICE_REJECTED');
        }
        const token = String(
          invoice.disburse_token || invoice.token
            || invoice.disburse_invoice || invoice.invoice_token || '',
        ).trim();
        if (!token) throw failure(502, 'Référence de retrait PayDunya absente.');
        await transactions.update_one({ id: txId }, { $set: {
          'metadata.paydunya_invoice_token': token,
          'metadata.paydunya_withdraw_mode': paydunyaMode,
          'metadata.paydunya_disbursement_id': txId,
          'metadata.paydunya_amount': Math.round(recipientGets),
          'metadata.paydunya_status': 'created',
          'metadata.submission_phase': 'invoice_created',
        } });
        const submit = async () => {
          try {
            return await submitPaydunyaInvoice(
              fetchImpl, base, headers, token, txId,
            );
          } catch {
            return { accepted: false, payload: null, responseCode: '' };
          }
        };
        let submitted = await submit();
        if (submitted.accepted) {
          upstream = submitted.payload;
        } else {
          let statusCheck = await checkPaydunyaDisbursement(fetchImpl, base, headers, {
            token, mode: paydunyaMode,
            amount: Math.round(recipientGets), disbursementId: txId,
          });
          if (!statusCheck.verified) {
            await transactions.update_one({ id: txId, status: 'pending' }, { $set: {
              'metadata.submission_phase': 'outcome_unknown',
              'metadata.manual_review_required': true,
              'metadata.paydunya_status_check': 'unverified',
              'metadata.provider_error_code': submitted.responseCode || null,
            } });
            return {
              transaction: publicPayoutTransaction(
                await transactions.find_one({ id: txId, user_id: ownerId }, { _id: 0 }),
              ),
              pending_manual: true,
            };
          }

          if (statusCheck.status === 'created') {
            submitted = await submit();
            if (submitted.accepted) {
              upstream = submitted.payload;
            } else {
              statusCheck = await checkPaydunyaDisbursement(fetchImpl, base, headers, {
                token, mode: paydunyaMode,
                amount: Math.round(recipientGets), disbursementId: txId,
              });
              if (!statusCheck.verified) {
                await transactions.update_one({ id: txId, status: 'pending' }, { $set: {
                  'metadata.submission_phase': 'outcome_unknown',
                  'metadata.manual_review_required': true,
                  'metadata.paydunya_status_check': 'unverified',
                  'metadata.provider_error_code': submitted.responseCode || null,
                } });
                return {
                  transaction: publicPayoutTransaction(
                    await transactions.find_one({ id: txId, user_id: ownerId }, { _id: 0 }),
                  ),
                  pending_manual: true,
                };
              }
              upstream = statusCheck.payload;
            }
          } else {
            upstream = statusCheck.payload;
          }
          await transactions.update_one({ id: txId, status: 'pending' }, { $set: {
            'metadata.paydunya_status_check': statusCheck.status || 'verified',
            'metadata.paydunya_submit_response_code': submitted.responseCode || null,
          } });
        }
      } else if (provider === 'mbiyo') {
        const apiKey = mbiyoApiKey;
        const base = String(mbiyo.base_url || env.MBIYO_BASE_URL
          || 'https://dashboard.mbiyo.africa/api/v1').replace(/\/+$/, '');
        const response = await fetchImpl(`${base}/merchant/payout`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            amount: recipientGets, currency, payment_method: 'mobile_money',
            order_id: txId, callback_url: callbackUrl,
            metadata: {
              network: operator.network || operator.operator || operatorCode,
              phone_number: providerPhone, country_code: country,
              beneficiary: String(body.recipient_name || user.full_name || recipient),
            },
          }),
        });
        upstream = await responseJson(response);
        if (!response.ok) throw failure(response.status >= 400 && response.status < 500
          ? 422 : 502, 'Mbiyo n’a pas confirmé le retrait.');
      } else if (provider === 'afribapay') {
        const { apiUser, apiKey, merchantKey, apiBase, payoutBase } = afribapayCredentials;
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
        if (!response.ok) throw failure(response.status >= 400 && response.status < 500
          ? 422 : 502, 'AfriBaPay n’a pas confirmé le retrait.');
      } else {
        throw failure(503, 'Prestataire de retrait non pris en charge.');
      }
    } catch (error) {
      if (error.status >= 400 && error.status < 500) {
        const latest = await transactions.find_one({ id: txId, user_id: ownerId }, { _id: 0 });
        await refundRejectedPayout(latest, error.code || 'provider_rejected');
        if (provider === 'paydunya') {
          throw failure(
            422,
            `${error.message || 'PayDunya a refusé le retrait.'} Le montant a été remboursé.`,
            error.code || 'PAYDUNYA_REJECTED',
          );
        }
        throw failure(422, 'Le prestataire a refusé le retrait; le montant a été remboursé.');
      }
      await transactions.update_one({ id: txId, status: 'pending' }, { $set: {
        'metadata.submission_phase': 'outcome_unknown',
        'metadata.manual_review_required': true,
        'metadata.provider_error': String(error.message || 'provider error').slice(0, 200),
      } });
      if (error.status && error.status < 500) throw error;
      return {
        transaction: publicPayoutTransaction(
          await transactions.find_one({ id: txId }, { _id: 0 }),
        ),
        pending_manual: true,
      };
    }
    const upstreamId = providerId(upstream);
    const status = providerStatus(upstream) || 'pending';
    if (['failed', 'rejected', 'cancelled', 'canceled', 'error'].includes(status)) {
      const saved = await transactions.find_one({ id: txId, user_id: ownerId }, { _id: 0 });
      const failed = await refundRejectedPayout(saved, status);
      return { transaction: publicPayoutTransaction(failed), pending_manual: false };
    }
    const confirmed = [
      'success', 'successful', 'completed', 'confirmed', 'paid', 'approved',
    ].includes(status);
    const resolvedAt = new Date().toISOString();
    await transactions.update_one({ id: txId, status: 'pending' }, { $set: {
      'metadata.provider_transaction_id': upstreamId || null,
      'metadata.provider_status': status,
      ...(provider === 'paydunya' ? {
        'metadata.paydunya_status': status,
        'metadata.paydunya_response_code': paydunyaResponseCode(upstream) || null,
      } : {}),
      'metadata.submission_phase': upstreamId ? 'provider_id_persisted' : 'response_without_provider_id',
      'metadata.manual_review_required': !upstreamId && !confirmed,
      ...(confirmed ? {
        status: 'completed',
        completed_at: resolvedAt,
        'metadata.provider_verified_at': resolvedAt,
      } : {}),
      updated_at: resolvedAt,
    } });
    const saved = await transactions.find_one({ id: txId, user_id: ownerId }, { _id: 0 });
    if (!saved) throw failure(503, 'Retrait enregistré mais transaction introuvable.');
    return {
      transaction: publicPayoutTransaction(saved),
      pending_manual: !upstreamId && !confirmed,
    };
  }

  async function refreshPayoutStatus(transactionId, userId) {
    const transactions = db.collection('transactions');
    const transaction = await transactions.find_one({
      id: String(transactionId), user_id: String(userId),
    }, { _id: 0 });
    if (!transaction || transaction.status !== 'pending') {
      return publicPayoutTransaction(transaction);
    }
    const metadata = payoutMetadata(transaction);
    const provider = String(metadata.provider || '');
    if (!['paydunya', 'mbiyo', 'afribapay'].includes(provider)
        || (provider !== 'paydunya'
          && metadata.submission_phase !== 'provider_id_persisted')) {
      return publicPayoutTransaction(transaction);
    }
    const settings = db.collection('settings');
    const config = await settings.find_one(
      { id: `payment_provider_${provider}` }, { _id: 0 },
    );
    if (!config?.enabled || String(config.mode || '').toLowerCase() !== 'live') {
      return publicPayoutTransaction(transaction);
    }

    if (provider === 'paydunya') {
      const token = String(metadata.paydunya_invoice_token || '').trim();
      const mode = String(metadata.paydunya_withdraw_mode || '').trim().toLowerCase();
      const amount = Number(metadata.paydunya_amount ?? metadata.recipient_gets);
      const disbursementId = String(metadata.paydunya_disbursement_id || transaction.id);
      if (!token || !PAYDUNYA_WITHDRAW_MODES.has(mode)
          || !Number.isSafeInteger(amount) || amount <= 0) {
        return publicPayoutTransaction(transaction);
      }
      const polledAt = new Date().toISOString();
      try {
        const credentials = loadCredentials(config, sessionSecret, env);
        const statusCheck = await checkPaydunyaDisbursement(
          fetchImpl,
          'https://app.paydunya.com',
          {
            'PAYDUNYA-MASTER-KEY': credentials.master_key,
            'PAYDUNYA-PRIVATE-KEY': credentials.private_key,
            'PAYDUNYA-TOKEN': credentials.token,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          { token, mode, amount, disbursementId },
        );
        if (!statusCheck.verified || !statusCheck.status) {
          await transactions.update_one(
            { id: transaction.id, status: 'pending' },
            { $set: {
              'metadata.last_status_poll_error': 'status_unverified',
              'metadata.last_status_poll_at': polledAt,
            } },
          );
          return publicPayoutTransaction(transaction);
        }
        const currentStatus = statusCheck.status;
        const successful = [
          'success', 'successful', 'completed', 'confirmed', 'paid', 'approved',
        ].includes(currentStatus);
        const failed = [
          'failed', 'rejected', 'cancelled', 'canceled', 'error',
        ].includes(currentStatus);
        if (failed) {
          await refundRejectedPayout(transaction, currentStatus);
          await transactions.update_one(
            { id: transaction.id, status: 'failed' },
            { $set: {
              'metadata.paydunya_status': currentStatus,
              'metadata.paydunya_response_code': statusCheck.responseCode || null,
              'metadata.last_status_poll_at': polledAt,
              'metadata.last_status_poll_error': null,
            } },
          );
        } else if (successful) {
          await transactions.update_one(
            { id: transaction.id, status: 'pending' },
            { $set: {
              status: 'completed',
              completed_at: polledAt,
              updated_at: polledAt,
              'metadata.provider_status': currentStatus,
              'metadata.paydunya_status': currentStatus,
              'metadata.paydunya_response_code': statusCheck.responseCode || null,
              'metadata.provider_verified_at': polledAt,
              'metadata.last_status_poll_at': polledAt,
              'metadata.last_status_poll_error': null,
              'metadata.manual_review_required': false,
            } },
          );
        } else {
          await transactions.update_one(
            { id: transaction.id, status: 'pending' },
            { $set: {
              'metadata.provider_status': currentStatus,
              'metadata.paydunya_status': currentStatus,
              'metadata.paydunya_response_code': statusCheck.responseCode || null,
              'metadata.last_status_poll_at': polledAt,
              'metadata.last_status_poll_error': null,
            } },
          );
        }
        const refreshed = await transactions.find_one(
          { id: transaction.id, user_id: String(userId) }, { _id: 0 },
        );
        return publicPayoutTransaction(refreshed || transaction);
      } catch {
        await transactions.update_one(
          { id: transaction.id, status: 'pending' },
          { $set: {
            'metadata.last_status_poll_error': 'provider_unavailable',
            'metadata.last_status_poll_at': polledAt,
          } },
        );
        return publicPayoutTransaction(transaction);
      }
    }

    let response;
    let payload;
    try {
      if (provider === 'mbiyo') {
        const apiKey = decryptSetting(config, 'api_key', sessionSecret)
          || decryptSetting(config, 'secret_key', sessionSecret);
        if (!apiKey || !metadata.provider_transaction_id) return transaction;
        const base = String(config.base_url || env.MBIYO_BASE_URL
          || 'https://dashboard.mbiyo.africa/api/v1').replace(/\/+$/, '');
        response = await fetchImpl(
          `${base}/merchant/transactions/${encodeURIComponent(metadata.provider_transaction_id)}`,
          {
            method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
            headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
          },
        );
      } else {
        const apiUser = decryptSetting(config, 'api_user', sessionSecret);
        const apiKey = decryptSetting(config, 'api_key', sessionSecret);
        const apiBase = String(config.live_api_base_url || config.api_base_url || '').replace(/\/+$/, '');
        if (!apiUser || !apiKey || !apiBase) return transaction;
        const tokenResponse = await fetchImpl(`${apiBase}/v1/token`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: {
            authorization: `Basic ${Buffer.from(`${apiUser}:${apiKey}`).toString('base64')}`,
            accept: 'application/json',
          },
        });
        const tokenPayload = await responseJson(tokenResponse);
        const accessToken = String(tokenPayload?.data?.access_token || '');
        if (!tokenResponse.ok || !accessToken) return transaction;
        const statusUrl = new URL(
          `${String(config.live_payout_base_url || config.payout_base_url || '').replace(/\/+$/, '')}/v1/status`,
        );
        statusUrl.searchParams.set('order_id', transaction.id);
        response = await fetchImpl(statusUrl, {
          method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        });
      }
      payload = await responseJson(response);
    } catch {
      await transactions.update_one({ id: transaction.id, status: 'pending' }, { $set: {
        'metadata.last_status_poll_error': 'provider_unavailable',
        'metadata.last_status_poll_at': new Date().toISOString(),
      } });
      return transaction;
    }
    if (!response.ok) return transaction;
    const currentStatus = providerStatus(payload);
    const successful = ['success', 'successful', 'completed', 'confirmed', 'paid', 'approved'].includes(currentStatus);
    const failed = ['failed', 'rejected', 'cancelled', 'canceled', 'error'].includes(currentStatus);
    if (!successful && !failed) return transaction;

    const verifiedAt = new Date().toISOString();
    if (failed) {
      return refundRejectedPayout(transaction, currentStatus);
    } else {
      await transactions.update_one({ id: transaction.id, status: 'pending' }, { $set: {
        status: 'completed', completed_at: verifiedAt, updated_at: verifiedAt,
        'metadata.provider_status': currentStatus,
        'metadata.provider_verified_at': verifiedAt,
      } });
    }
    return transactions.find_one({ id: transaction.id, user_id: String(userId) }, { _id: 0 });
  }

  return { createIntegrationPayout, refreshPayoutStatus };
}

module.exports = { createMobileMoneyPayoutService, decryptSetting };
