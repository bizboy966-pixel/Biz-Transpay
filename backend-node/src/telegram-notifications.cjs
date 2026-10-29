'use strict';

const ALLOWED_KYC_EVENTS = new Set([
  'kyc_submitted', 'kyc_verified', 'kyc_rejected', 'kyc_resubmit_requested',
]);
const MAX_QUEUE = 200;

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

function createTelegramNotifier({ db, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const queue = [];
  let draining = false;

  async function deliver(event) {
    if (!db || !fetchImpl || env.NODE_ENV !== 'production') return;
    const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
    const chatId = String(env.TELEGRAM_CHAT_ID || '').trim();
    if (!token || !chatId) return;
    if (event.type !== 'admin_login' && !ALLOWED_KYC_EVENTS.has(event.type)) return;
    const user = await db.collection('users').find_one({ id: event.userId }, {
      _id: 0, full_name: 1, username: 1, email: 1,
    });
    if (!user) return;
    const text = event.type === 'admin_login'
      ? formatAdminLogin({
        user, ip: event.ip, unusual: event.unusual, detectedAt: event.detectedAt,
      })
      : formatKycEvent(event);
    try {
      await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      // External messaging is best-effort; never log tokens, customer data, or provider bodies.
    }
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const event = queue.shift();
        try { await deliver(event); } catch { /* best-effort delivery */ }
      }
    } finally {
      draining = false;
      if (queue.length) setImmediate(drain);
    }
  }

  function enqueue(event) {
    if (!event?.userId || queue.length >= MAX_QUEUE
        || (event.type !== 'admin_login' && !ALLOWED_KYC_EVENTS.has(event.type))) return false;
    queue.push({
      type: event.type,
      userId: String(event.userId),
      ip: maskIp(event.ip),
      unusual: Boolean(event.unusual),
      detectedAt: event.detectedAt,
      status: String(event.status || '').slice(0, 80),
    });
    setImmediate(drain);
    return true;
  }

  return {
    enqueueAdminLogin: event => event?.type === 'admin_login' ? enqueue(event) : false,
    enqueueKycEvent: enqueue,
  };
}

module.exports = {
  createTelegramNotifier, formatAdminLogin, formatKycEvent, maskEmail, maskIp, escapeHtml,
};
