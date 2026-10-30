'use strict';

const crypto = require('node:crypto');
const { sessionToken } = require('./auth-session-routes.cjs');
const { reply } = require('./auth-login.cjs');

const MOMO_PENDING_MINUTES = 10;
const MOMO_RESTORE_WINDOW_MS = 48 * 60 * 60 * 1000;

function plainText(value) {
  if (typeof value !== 'string') return null;
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
    .slice(0, 3000);
}

function publicInstructions(value) {
  if (typeof value === 'string') return plainText(value);
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'string') return plainText(item);
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      for (const key of ['text', 'label', 'message', 'description', 'title']) {
        const text = plainText(item[key]);
        if (text) return text;
      }
      return null;
    }).filter(Boolean).slice(0, 20);
  }
  return null;
}

function safeRedirect(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch { return null; }
}

function pendingSeconds(deposit, now) {
  let expiry = Date.parse(deposit.pending_expires_at || '');
  if (!Number.isFinite(expiry)) {
    const created = Date.parse(deposit.created_at || '');
    if (Number.isFinite(created)) expiry = created + MOMO_PENDING_MINUTES * 60_000;
  }
  return Number.isFinite(expiry)
    ? Math.max(0, Math.ceil((expiry - now) / 1000))
    : null;
}

function publicMomoDeposit(deposit, now = Date.now()) {
  const status = String(deposit.status || 'pending');
  const authMode = deposit.auth_mode || null;
  const instructions = publicInstructions(deposit.instructions);
  const paymentInstructions = publicInstructions(deposit.payment_instructions);
  const pendingInstructions = publicInstructions(deposit.pending_instructions);
  const rawFlow = deposit.payment_flow && typeof deposit.payment_flow === 'object'
    && !Array.isArray(deposit.payment_flow) ? deposit.payment_flow : {};
  const flowInstructions = publicInstructions(rawFlow.instructions);
  const flow = {
    ...(typeof rawFlow.kind === 'string' ? { kind: rawFlow.kind.slice(0, 64) } : {}),
    ...(flowInstructions ? { instructions: flowInstructions } : {}),
    ...(typeof rawFlow.before_submit === 'boolean'
      ? { before_submit: rawFlow.before_submit } : {}),
    ...(typeof rawFlow.otp_required === 'boolean'
      ? { otp_required: rawFlow.otp_required } : {}),
    ...(['ussd_code', 'ussd_template', 'action_label', 'otp_label'].reduce((result, key) => {
      const value = plainText(rawFlow[key]);
      if (value) result[key] = value.slice(0, 180);
      return result;
    }, {})),
    ...(Array.isArray(rawFlow.steps)
      ? { steps: rawFlow.steps.map(plainText).filter(Boolean).slice(0, 8) } : {}),
  };
  const redirectUrl = safeRedirect(deposit.redirect_url || deposit.checkout_url);
  const directPaydunya = deposit.provider === 'paydunya'
    && deposit.paydunya_flow === 'softpay_direct';
  const publicValue = {
    id: deposit.id,
    status,
    provider: ['paydunya', 'mbiyo', 'afribapay'].includes(deposit.provider)
      ? deposit.provider : null,
    created_at: deposit.created_at || null,
    pending_expires_at: deposit.pending_expires_at || null,
    pending_remaining_seconds: status === 'pending' ? pendingSeconds(deposit, now) : null,
    amount: deposit.amount ?? null,
    requested_amount: deposit.requested_amount ?? null,
    charged_amount: deposit.charged_amount ?? null,
    amount_net: deposit.amount_net ?? deposit.wallet_credit_amount ?? null,
    gateway_fee: deposit.gateway_fee ?? null,
    platform_fee: deposit.platform_fee ?? null,
    total_fee: deposit.total_fee ?? deposit.fee ?? null,
    fee_bearer: deposit.fee_bearer ?? null,
    currency: deposit.currency || null,
    operator: {
      code: deposit.operator || null,
      label: deposit.operator_name || null,
    },
    operator_name: deposit.operator_name || null,
    phone_number: deposit.phone_number || null,
    payment_flow: flow,
    auth_mode: authMode,
    otp_required: Boolean(deposit.otp_required || authMode === 'pin'),
    challenge_status: authMode === 'pin'
      ? 'required' : ['approved', 'paid'].includes(status) ? 'completed' : 'pending',
    instructions,
    payment_instructions: paymentInstructions,
    pending_instructions: pendingInstructions,
    redirect_url: redirectUrl,
    payment_kind: directPaydunya ? 'phone'
      : deposit.payment_kind === 'popup' ? 'popup'
        : deposit.payment_kind === 'redirect'
          || rawFlow.kind === 'redirect'
          || deposit.payment_fallback === 'hosted_checkout' || redirectUrl
          ? 'redirect' : 'phone',
    payment_fallback: directPaydunya ? null
      : deposit.payment_fallback === 'hosted_checkout' ? 'hosted_checkout' : null,
    submission_unknown: Boolean(deposit.submission_unknown),
    message: directPaydunya && deposit.submission_unknown
      ? 'La confirmation prend du temps. Ne relancez pas ce dépôt; son statut sera vérifié ici.'
      : null,
    prompt_sent: Boolean(deposit.prompt_sent),
    finalize_capability: typeof deposit.finalize_capability === 'string'
      ? deposit.finalize_capability.slice(0, 512) : null,
    failed_reason: status === 'failed'
      ? 'Le paiement n’a pas été confirmé. Contactez le support si le débit a été effectué.'
      : null,
  };
  return publicValue;
}

function publicCryptoDeposit(deposit) {
  const fields = [
    'id', 'status', 'created_at', 'amount', 'requested_amount', 'currency',
    'coin', 'network', 'deposit_address', 'amount_to_send', 'expires_at',
    'transaction_hash', 'tx_hash', 'confirmations', 'confirmations_required',
    'wallet_credit_amount', 'fee',
  ];
  const result = {};
  for (const field of fields) {
    if (deposit[field] !== undefined) result[field] = deposit[field];
  }
  return result;
}

function createDepositStatusRoutes({
  db, sessionService, reconcileMbiyoDepositById,
}) {
  async function handleRoute(req, res) {
    // Owner-check first; Mbiyo status reads are throttled by the reconciler.
    if (req.method !== 'GET') return false;
    const url = new URL(req.url || '/', 'http://localhost');
    const pendingMomo = url.pathname === '/api/deposits/mobile-money/pending';
    const psrTokenMatch = req.method === 'GET'
      ? /^\/api\/deposits\/paydunya\/psr\/([^/]+)\/token\/([^/]+)$/.exec(url.pathname)
      : null;
    const momoMatch = !pendingMomo
      ? /^\/api\/deposits\/mobile-money\/([^/]+)$/.exec(url.pathname) : null;
    const cryptoMatch = /^\/api\/deposits\/crypto\/([^/]+)$/.exec(url.pathname);
    if (!pendingMomo && !psrTokenMatch && !momoMatch && !cryptoMatch) return false;

    try {
      if (psrTokenMatch) {
        const depositId = decodeURIComponent(psrTokenMatch[1]);
        const capability = decodeURIComponent(psrTokenMatch[2]);
        if (!depositId || depositId.length > 160 || !capability || capability.length > 256) {
          reply(res, 404, { detail: 'Facture PSR introuvable ou indisponible.' });
          return true;
        }
        const providerConfig = await db.collection('settings').find_one(
          { id: 'payment_provider_paydunya' }, { _id: 0 },
        );
        if (!providerConfig?.enabled || providerConfig.modes?.psr?.enabled !== true) {
          reply(res, 503, { detail: 'Ce mode de paiement Mobile Money est désactivé.' });
          return true;
        }
        const capabilityHash = crypto.createHash('sha256')
          .update(capability, 'utf8').digest('hex');
        const now = new Date().toISOString();
        const query = {
          id: depositId,
          provider: 'paydunya',
          paydunya_flow: 'psr',
          status: 'pending',
          psr_capability_hash: capabilityHash,
          psr_capability_used: { $ne: true },
          psr_capability_expires_at: { $gt: now },
        };
        const deposits = db.collection('momo_deposits');
        const deposit = await deposits.find_one(query, { _id: 0 });
        if (!deposit || typeof deposit.paydunya_token !== 'string' || !deposit.paydunya_token) {
          reply(res, 404, { detail: 'Facture PSR introuvable ou indisponible.' });
          return true;
        }
        const claimed = await deposits.update_one(query, { $set: {
          psr_capability_used: true,
          psr_capability_used_at: now,
        } });
        if (claimed.modified_count !== 1) {
          reply(res, 404, { detail: 'Facture PSR introuvable ou indisponible.' });
          return true;
        }
        reply(res, 200, {
          success: true,
          token: deposit.paydunya_token,
          ...(providerConfig.mode !== 'live' ? { mode: 'test' } : {}),
        });
        return true;
      }
      const identity = await sessionService.authenticate(sessionToken(req));
      const userId = String(identity?.userId || '');
      if (!userId) {
        reply(res, 401, { detail: 'Session requise.' });
        return true;
      }
      if (cryptoMatch) {
        const depositId = decodeURIComponent(cryptoMatch[1]);
        if (!depositId || depositId.length > 160) {
          reply(res, 404, { detail: 'Dépôt introuvable.' });
          return true;
        }
        const deposit = await db.collection('crypto_deposits').find_one(
          { id: depositId, user_id: userId }, { _id: 0 },
        );
        if (!deposit) {
          reply(res, 404, { detail: 'Dépôt introuvable.' });
          return true;
        }
        reply(res, 200, publicCryptoDeposit(deposit));
        return true;
      }

      let deposit;
      if (pendingMomo) {
        const createdAfter = new Date(Date.now() - MOMO_RESTORE_WINDOW_MS).toISOString();
        const rows = await db.collection('momo_deposits').find({
          user_id: userId,
          provider: { $in: ['mbiyo', 'paydunya'] },
          status: 'pending',
          created_at: { $gt: createdAfter },
        }, { _id: 0 }).sort('created_at', -1).limit(1).to_list(1);
        deposit = rows[0] || null;
      } else {
        const depositId = decodeURIComponent(momoMatch[1]);
        if (!depositId || depositId.length > 160) {
          reply(res, 404, { detail: 'Dépôt introuvable.' });
          return true;
        }
        deposit = await db.collection('momo_deposits').find_one(
          { id: depositId, user_id: userId }, { _id: 0 },
        );
        if (!deposit) {
          reply(res, 404, { detail: 'Dépôt introuvable.' });
          return true;
        }
      }
      if (deposit?.provider === 'mbiyo' && deposit.status === 'pending'
          && typeof reconcileMbiyoDepositById === 'function') {
        try { await reconcileMbiyoDepositById(deposit.id); } catch { /* status snapshot stays available */ }
        deposit = await db.collection('momo_deposits').find_one(
          { id: deposit.id, user_id: userId }, { _id: 0 },
        ) || deposit;
      }
      reply(res, 200, deposit ? publicMomoDeposit(deposit) : null);
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      reply(res, status, {
        detail: status >= 500 ? 'Impossible de lire le statut du dépôt.' : error.message,
      });
    }
    return true;
  }

  return { handleRoute };
}

module.exports = {
  createDepositStatusRoutes,
  pendingSeconds,
  publicCryptoDeposit,
  publicMomoDeposit,
  safeRedirect,
};
