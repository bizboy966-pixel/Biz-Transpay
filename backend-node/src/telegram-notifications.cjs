'use strict';

const ALLOWED_KYC_EVENTS = new Set([
  'kyc_submitted', 'kyc_verified', 'kyc_rejected', 'kyc_resubmit_requested',
]);
const ALLOWED_OPERATION_EVENTS = new Set([
  'deposit_success', 'withdrawal_success', 'withdrawal_failed',
  'withdrawal_manual_review', 'transfer_success', 'exchange_success',
  'payment_success', 'security_alert',
]);
const OPERATION_LABELS = {
  deposit_success: 'DÉPÔT CONFIRMÉ',
  withdrawal_success: 'RETRAIT CONFIRMÉ',
  withdrawal_failed: 'ÉCHEC DU RETRAIT',
  withdrawal_manual_review: 'RETRAIT EN REVUE MANUELLE',
  transfer_success: 'TRANSFERT CONFIRMÉ',
  exchange_success: 'ÉCHANGE CONFIRMÉ',
  payment_success: 'PAIEMENT CONFIRMÉ',
  security_alert: 'ALERTE DE SÉCURITÉ',
};
const MAX_QUEUE = 200;
const MAX_MESSAGE_LENGTH = 3900;
const SAFE_OPERATION_FIELDS = [
  'amount', 'amount_net', 'amount_gross', 'fee', 'currency', 'reference',
  'transaction_id', 'deposit_id', 'operation_id', 'provider_reference',
  'external_reference', 'transfer_type',
  'provider', 'operator', 'country', 'status', 'phone', 'recipient_phone',
  'payer_phone', 'email', 'detected_at', 'created_at',
];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function maskEmail(value) {
  const email = String(value || '').trim();
  const at = email.lastIndexOf('@');
  if (at < 1) return '—';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

function maskIp(value) {
  const ip = String(value || '').trim();
  if (!ip || ip === 'unknown') return 'inconnue';
  if (ip.includes('.')) {
    const parts = ip.split('.');
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.xxx` : 'masquée';
  }
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::…`;
  return 'masquée';
}

function formatAdminLogin({ user = {}, ip, unusual, detectedAt }) {
  const name = String(user.full_name || 'Compte Biz-transPay').slice(0, 120);
  const username = String(user.username || '—').slice(0, 120);
  const date = new Date(detectedAt || Date.now());
  const time = Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('fr-FR', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Douala',
    }).format(date);
  const unusualLabel = unusual ? ' — caractéristiques inhabituelles' : '';
  return [
    `<b>🔐 CONNEXION ADMINISTRATEUR${escapeHtml(unusualLabel)}</b>`,
    '━━━━━━━━━━━━━━━━━━━━',
    `👤 Compte : <b>${escapeHtml(name)}</b>`,
    `🔑 Username : <code>${escapeHtml(username)}</code>`,
    `📧 Email : <code>${escapeHtml(maskEmail(user.email))}</code>`,
    `🌐 IP : <code>${escapeHtml(maskIp(ip))}</code>`,
    `🕘 Heure : <b>${escapeHtml(time)}</b>`,
  ].join('\n').slice(0, 4000);
}

function formatKycEvent({ user = {}, type, status, detectedAt }) {
  const labels = {
    kyc_submitted: 'SOUMIS — EN ATTENTE DE VALIDATION',
    kyc_verified: 'VALIDÉ',
    kyc_rejected: 'REJETÉ',
    kyc_resubmit_requested: 'NOUVEAUX DOCUMENTS DEMANDÉS',
  };
  const name = String(user.full_name || 'Compte Biz-transPay').slice(0, 120);
  const username = String(user.username || '—').slice(0, 120);
  const date = new Date(detectedAt || Date.now());
  const time = Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('fr-FR', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Douala',
    }).format(date);
  return [
    `<b>🪪 KYC — ${escapeHtml(labels[type] || 'MISE À JOUR')}</b>`,
    '━━━━━━━━━━━━━━━━━━━━',
    `👤 Compte : <b>${escapeHtml(name)}</b>`,
    `🔑 Username : <code>${escapeHtml(username)}</code>`,
    `📧 Email : <code>${escapeHtml(maskEmail(user.email))}</code>`,
    `📊 Statut : <b>${escapeHtml(status || labels[type])}</b>`,
    `🕘 Heure : <b>${escapeHtml(time)}</b>`,
  ].join('\n').slice(0, 4000);
}

function maskPhone(value) {
  const phone = String(value || '').trim();
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '—';
  return `${digits.slice(0, 3)}••••${digits.slice(-2)}`;
}

function formatOperationEvent({ user = {}, type, data = {} }) {
  const clean = {};
  for (const field of SAFE_OPERATION_FIELDS) {
    const value = data[field];
    if (value === undefined || value === null || value === '') continue;
    clean[field] = String(value).slice(0, 120);
  }
  const reference = clean.reference || clean.transaction_id || clean.deposit_id
    || clean.operation_id || '—';
  const providerReference = clean.provider_reference || clean.external_reference;
  const amount = clean.amount_net || clean.amount || clean.amount_gross || '—';
  const currency = clean.currency || '';
  const phone = clean.phone || clean.recipient_phone || clean.payer_phone;
  const eventTime = clean.detected_at || clean.created_at;
  const date = new Date(eventTime || Date.now());
  const time = Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Douala',
  }).format(date);
  return [
    `<b>💳 ${escapeHtml(OPERATION_LABELS[type] || 'OPÉRATION')}</b>`,
    '━━━━━━━━━━━━━━━━━━━━',
    ...(user.full_name ? [`👤 Compte : <b>${escapeHtml(String(user.full_name).slice(0, 100))}</b>`] : []),
    `🔎 Référence : <code>${escapeHtml(reference)}</code>`,
    ...(providerReference && providerReference !== reference
      ? [`🔗 Référence prestataire : <code>${escapeHtml(providerReference)}</code>`] : []),
    `💰 Montant : <b>${escapeHtml(amount)} ${escapeHtml(currency)}</b>`,
    ...(clean.fee ? [`Frais : ${escapeHtml(clean.fee)} ${escapeHtml(currency)}`] : []),
    ...(clean.provider || clean.operator
      ? [`🏦 Parcours : ${escapeHtml([clean.provider, clean.operator].filter(Boolean).join(' — '))}`] : []),
    ...(phone ? [`📱 Téléphone : <code>${escapeHtml(maskPhone(phone))}</code>`] : []),
    ...(clean.email ? [`📧 E-mail : <code>${escapeHtml(maskEmail(clean.email))}</code>`] : []),
    `🕘 Heure : <b>${escapeHtml(time)}</b>`,
  ].join('\n').slice(0, MAX_MESSAGE_LENGTH);
}

function isProduction(env) {
  if (env.BIZTRANSPAY_MIGRATION_ENV) {
    return env.BIZTRANSPAY_MIGRATION_ENV === 'production';
  }
  return env.NODE_ENV === 'production';
}

function createTelegramNotifier({
  db, env = process.env, fetchImpl = globalThis.fetch, logger = console,
} = {}) {
  const queue = [];
  let draining = false;
  let missingConfigWarned = false;

  async function sendMessage(chatId, text) {
    if (!isProduction(env) || typeof fetchImpl !== 'function') return false;
    const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
    if (!token || !chatId) {
      if (!missingConfigWarned) {
        logger.warn?.('Telegram delivery disabled: configure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');
        missingConfigWarned = true;
      }
      return false;
    }
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: String(chatId), text: String(text).slice(0, MAX_MESSAGE_LENGTH),
          parse_mode: 'HTML', disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10000),
      });
      let result = null;
      try { result = await response.json(); } catch { /* status still catches network proxies */ }
      const accepted = Boolean(response.ok && result?.ok !== false);
      if (!accepted) logger.warn?.(`Telegram delivery rejected (HTTP ${response.status}).`);
      return accepted;
    } catch (error) {
      logger.warn?.(`Telegram delivery failed (${String(error?.name || 'network')}).`);
      return false;
    }
  }

  async function deliver(event) {
    if (!db || !fetchImpl || !isProduction(env)) return;
    const chatId = String(env.TELEGRAM_CHAT_ID || '').trim();
    if (!chatId) return;
    if (event.type !== 'admin_login' && !ALLOWED_KYC_EVENTS.has(event.type)
        && !ALLOWED_OPERATION_EVENTS.has(event.type)) return;
    const user = await db.collection('users').find_one({ id: event.userId }, {
      _id: 0, full_name: 1, username: 1, email: 1,
    });
    const text = event.type === 'admin_login'
      ? formatAdminLogin({
        user: user || {}, ip: event.ip, unusual: event.unusual, detectedAt: event.detectedAt,
      })
      : ALLOWED_KYC_EVENTS.has(event.type)
        ? formatKycEvent({ ...event, user: user || {} })
        : formatOperationEvent({ ...event, user: user || {} });
    await sendMessage(chatId, text);
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const event = queue.shift();
        try { await deliver(event); } catch {
          logger.warn?.('Telegram notification could not be prepared.');
        }
      }
    } finally {
      draining = false;
      if (queue.length) setImmediate(drain);
    }
  }

  function enqueue(event) {
    if (!event?.userId || queue.length >= MAX_QUEUE
        || (event.type !== 'admin_login' && !ALLOWED_KYC_EVENTS.has(event.type)
          && !ALLOWED_OPERATION_EVENTS.has(event.type))) return false;
    queue.push({
      type: event.type,
      userId: String(event.userId),
      ip: maskIp(event.ip),
      unusual: Boolean(event.unusual),
      detectedAt: event.detectedAt,
      status: String(event.status || '').slice(0, 80),
      data: Object.fromEntries(SAFE_OPERATION_FIELDS
        .filter(field => event.data?.[field] !== undefined)
        .map(field => [field, String(event.data[field]).slice(0, 120)])),
    });
    setImmediate(drain);
    return true;
  }

  return {
    enqueueAdminLogin: event => event?.type === 'admin_login' ? enqueue(event) : false,
    enqueueKycEvent: enqueue,
    enqueueOperationEvent: enqueue,
    sendMessage,
  };
}

module.exports = {
  createTelegramNotifier, formatAdminLogin, formatKycEvent, formatOperationEvent,
  maskEmail, maskIp, maskPhone, escapeHtml, ALLOWED_OPERATION_EVENTS,
};
