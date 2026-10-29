'use strict';

const crypto = require('node:crypto');
const { URL } = require('node:url');
const security = require('./security.cjs');
const { verifyTurnstile, checkLoginSecurity, recordLoginFailure, clearAccountFailures,
  readJson, reply, fail } = require('./auth-login.cjs');
const { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } = require('./session-service.cjs');
const { isAdminAccount } = require('./public-user.cjs');

const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS = 3;
const TOKEN_TTL_MS = 30 * 60 * 1000;
function requestIp(req) {
  return String(req.socket?.remoteAddress || 'unknown').slice(0, 128);
}
const GENERIC_RESPONSE = {
  ok: true,
  message: 'Si cette adresse est liée à un compte, un lien de réinitialisation sera envoyé.',
};

function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  return Date.parse(value);
}

function validEmail(value) {
  return typeof value === 'string' && value.length <= 320
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function publicAppUrl(env) {
  for (const item of [
    env.PUBLIC_APP_URL,
    env.OFFICIAL_DOMAIN,
    ...(String(env.CORS_ORIGINS || '').split(',')),
  ]) {
    try {
      const url = new URL(String(item || '').trim().replace(/\/+$/, ''));
      if (url.protocol === 'https:' && url.host && !url.username && !url.password
          && url.pathname === '/' && !url.search && !url.hash) return url.origin;
    } catch { /* Continue through explicit configured origins. */ }
  }
  return '';
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;',
  })[char]);
}

function connectorConfig(env) {
  let host = String(env.REPLIT_CONNECTORS_HOSTNAME || '').trim();
  const identity = String(env.REPL_IDENTITY || '').trim();
  const renewal = String(env.WEB_REPL_RENEWAL || '').trim();
  if (!host || !(identity || renewal)) return null;
  if (!host.includes('://')) host = `${host.startsWith('localhost') ? 'http' : 'https'}://${host}`;
  try {
    const url = new URL(host);
    if (!['http:', 'https:'].includes(url.protocol) || !url.host
        || url.username || url.password || url.pathname !== '/'
        || url.search || url.hash
        || (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname))) {
      return null;
    }
    return {
      endpoint: `${url.origin}/api/v2/proxy/emails`,
      token: identity ? `repl ${identity}` : `depl ${renewal}`,
    };
  } catch { return null; }
}

async function sendResendEmail(env, { sender, recipient, subject, text, html, idempotencyKey }) {
  if (!sender || !recipient) throw new Error('Email sender not configured');
  const headers = {
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
    'User-Agent': 'Biz-transPay/Node',
  };
  const connector = connectorConfig(env);
  let endpoint = 'https://api.resend.com/emails';
  if (connector) {
    endpoint = connector.endpoint;
    headers['X-Replit-Token'] = connector.token;
    headers['Connector-Name'] = 'resend';
  } else {
    const apiKey = String(env.RESEND_API_KEY || '').trim();
    if (!apiKey) throw new Error('Resend is not configured');
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify({
      from: `Biz-transPay <${sender}>`,
      to: [recipient],
      subject,
      text,
      html,
    }),
  });
  if (!response.ok) throw new Error(`Resend returned ${response.status}`);
}

async function allowResetRequest(db, email, now = new Date()) {
  const key = crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  const collection = db.collection('password_reset_limits');
  await collection.delete_many({ expires_at: { $lte: now } });
  const current = await collection.find_one({ id: key }, { _id: 0 });
  if (!current) {
    try {
      await collection.insert_one({
        id: key, count: 1, window_started_at: now,
        expires_at: new Date(now.getTime() + RATE_WINDOW_MS),
      });
      return true;
    } catch { return false; }
  }
  const windowStart = timestamp(current.window_started_at);
  if (!Number.isFinite(windowStart)) return false;
  if (windowStart + RATE_WINDOW_MS <= now.getTime()) {
    return (await collection.update_one({ id: key, count: current.count }, {
      $set: {
        count: 1, window_started_at: now,
        expires_at: new Date(now.getTime() + RATE_WINDOW_MS),
      },
    })).modified_count === 1;
  }
  if (Number(current.count || 0) >= MAX_REQUESTS) return false;
  return (await collection.update_one({ id: key, count: current.count }, {
    $inc: { count: 1 },
  })).modified_count === 1;
}

function resetEmailContent(appUrl, token, purpose) {
  const pin = purpose === 'user_pin';
  const resetLink = pin
    ? `${appUrl}/reset-password#token=${encodeURIComponent(token)}&mode=pin`
    : `${appUrl}/reset-password#token=${encodeURIComponent(token)}`;
  const subject = pin
    ? 'Réinitialisation de votre code PIN Biz-transPay'
    : 'Réinitialisation de votre mot de passe Biz-transPay';
  const sentence = pin
    ? 'Une demande de réinitialisation du code PIN a été reçue. '
    : 'Une demande de réinitialisation du mot de passe a été reçue. ';
  const heading = pin ? 'Réinitialiser votre code PIN' : 'Réinitialiser votre mot de passe';
  const action = pin ? 'Choisir un nouveau code PIN' : 'Choisir un nouveau mot de passe';
  const safeLink = htmlEscape(resetLink);
  const logo = htmlEscape(`${appUrl}/logo-mark.png`);
  return {
    resetLink,
    subject,
    text: `${sentence}Utilisez ce lien dans les 30 minutes : ${resetLink}\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.`,
    html: '<div style="font-family:Arial,sans-serif;color:#0f172a">'
      + '<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>'
      + '<td><span style="color:#0f172a;font-size:18px;font-weight:700">Biz-transPay</span></td>'
      + '<td align="right" width="104"><img src="' + logo + '" width="62" height="62" alt="Logo Biz-transPay"></td>'
      + '</tr></table>'
      + `<h2>${heading}</h2><p>Ce lien à usage unique expire dans 30 minutes.</p>`
      + `<p><a href="${safeLink}">${action}</a></p>`
      + "<p>Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.</p></div>",
  };
}

function setClearCookies(res) {
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`,
    `${CSRF_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; SameSite=Strict`,
  ]);
}

async function prepareResetEmail(db, env, email, purpose, sendEmail) {
  try {
    const appUrl = publicAppUrl(env);
    const settings = await db.collection('settings').find_one(
      { id: 'transaction_email_settings' }, { _id: 0 },
    );
    const sender = String(settings?.sender_email || '').trim();
    if (!appUrl || !sender || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sender)
        || (!String(env.RESEND_API_KEY || '').trim() && !connectorConfig(env))) return;
    const user = await db.collection('users').find_one(
      { email: email.trim().toLowerCase() },
      { _id: 0, id: 1, email: 1, role: 1, user_pin_hash: 1 },
    );
    if (!user?.id || !user.email
        || (purpose === 'user_pin' && (isAdminAccount(user) || !user.user_pin_hash))) return;
    const now = new Date();
    const tokens = db.collection('password_reset_tokens');
    await tokens.delete_many({ expires_at: { $lte: now } });
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await tokens.insert_one({
      id: crypto.randomUUID(),
      user_id: user.id,
      token_hash: tokenHash,
      purpose,
      used: false,
      created_at: now,
      expires_at: new Date(now.getTime() + TOKEN_TTL_MS),
    });
    const content = resetEmailContent(appUrl, token, purpose);
    await sendEmail(env, {
      sender,
      recipient: user.email,
      subject: content.subject,
      text: content.text,
      html: content.html,
      idempotencyKey: crypto.createHash('sha256')
        .update(`${purpose}:${tokenHash}`).digest('hex'),
    });
  } catch (error) {
    // Keep account state and provider response out of logs.
    console.warn(`Password recovery email failed (${error?.name || 'Error'}).`);
  }
}

function validResetToken(token) {
  return typeof token === 'string' && token.length >= 32 && token.length <= 128;
}

function isNotExpired(value, now) {
  const expires = timestamp(value);
  return Number.isFinite(expires) && expires > now.getTime();
}

function createAuthRecoveryRoutes({
  db, sessionService, jwtSecret, sessionSecret, env = process.env,
  verifyBot = verifyTurnstile, sendEmail = sendResendEmail,
  onError = error => console.warn(`Password recovery route failed (${error?.name || 'Error'}).`),
}) {
  return async function handleRecovery(req, res) {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method !== 'POST') return false;
    const routes = new Set([
      '/api/auth/recover',
      '/api/auth/password-reset/request',
      '/api/auth/password-reset/confirm',
      '/api/auth/user-pin/reset/request',
      '/api/auth/user-pin/reset/confirm',
    ]);
    if (!routes.has(path)) return false;
    if (!db || !sessionService || !jwtSecret || !sessionSecret) {
      reply(res, 503, { detail: 'Réinitialisation Node indisponible.', code: 'MIGRATION_INCOMPLETE' });
      return true;
    }
    try {
      const body = await readJson(req);
      if (body.turnstile_token != null
          && (typeof body.turnstile_token !== 'string' || body.turnstile_token.length > 2048)) {
        fail(422, 'Vérification anti-bot invalide.');
      }

      if (path.endsWith('/request')) {
        if (!validEmail(body.email)) fail(422, 'Adresse e-mail invalide.');
        await verifyBot(body.turnstile_token, req, 'password_reset', env);
        const email = body.email.trim().toLowerCase();
        if (await allowResetRequest(db, email)) {
          const purpose = path === '/api/auth/user-pin/reset/request' ? 'user_pin' : 'password';
          res.writeHead(200, {
            'Cache-Control': 'no-store',
            'Content-Type': 'application/json; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(JSON.stringify(GENERIC_RESPONSE));
          setImmediate(() => { void prepareResetEmail(db, env, email, purpose, sendEmail); });
          return true;
        }
        reply(res, 200, GENERIC_RESPONSE);
        return true;
      }

      if (path === '/api/auth/recover') {
        if (typeof body.identifier !== 'string' || !body.identifier.trim()
            || typeof body.recovery_code !== 'string' || !body.recovery_code
            || typeof body.new_password !== 'string') fail(422, 'Informations de récupération invalides.');
        await verifyBot(body.turnstile_token, req, 'recover', env);
        const identifier = body.identifier.trim().toLowerCase();
        const ip = requestIp(req);
        await checkLoginSecurity(db, identifier, ip, null, null);
        const errors = security.passwordPolicyErrors(body.new_password);
        if (errors.length) fail(422, `Mot de passe insuffisant : ${errors.join(', ')}`);
        const user = await db.collection('users').find_one({
          $or: [{ email: identifier }, { username: identifier }],
        }, { _id: 0 });
        if (!user) {
          await recordLoginFailure(db, identifier, ip);
          fail(401, 'Informations de récupération invalides');
        }
        let match = null;
        for (const item of user.recovery_codes || []) {
          if (!item.used && await security.verifyPassword(body.recovery_code, item.hash || '')) {
            match = item;
            break;
          }
        }
        if (!match) {
          await recordLoginFailure(db, identifier, ip);
          fail(401, 'Informations de récupération invalides');
        }
        const claimed = await db.collection('users').update_one({
          id: user.id,
          recovery_codes: { $elemMatch: { id: match.id, used: false } },
        }, { $set: {
          'recovery_codes.$.used': true,
          password_hash: await require('bcryptjs').hash(body.new_password, 12),
          password_policy_version: 1,
        } });
        if (claimed.modified_count !== 1) fail(401, 'Informations de récupération invalides');
        await db.collection('sessions').update_many({
          user_id: user.id, revoked_at: { $exists: false },
        }, { $set: {
          revoked_at: new Date(), revocation_reason: 'account_recovery',
        } });
        await db.collection('password_reset_tokens').update_many({
          user_id: user.id, used: false,
        }, { $set: { used: true, invalidated_at: new Date().toISOString() } });
        setClearCookies(res);
        await clearAccountFailures(db, identifier);
        reply(res, 200, {
          ok: true,
          message: 'Mot de passe réinitialisé. Connectez-vous de nouveau.',
        });
        return true;
      }

      if (path === '/api/auth/password-reset/confirm'
          || path === '/api/auth/user-pin/reset/confirm') {
        await verifyBot(body.turnstile_token, req, 'password_reset_confirm', env);
        const pinReset = path === '/api/auth/user-pin/reset/confirm';
        if (!validResetToken(body.token)) fail(422, 'Lien de réinitialisation invalide ou expiré.');
        const tokenHash = crypto.createHash('sha256').update(body.token).digest('hex');
        const tokens = db.collection('password_reset_tokens');
        const now = new Date();
        const tokenDoc = await tokens.find_one({
          token_hash: tokenHash,
          used: false,
          ...(pinReset ? { purpose: 'user_pin' } : {}),
        }, { _id: 0 });
        if (!tokenDoc?.user_id || (!pinReset && (tokenDoc.purpose || 'password') !== 'password')
            || !isNotExpired(tokenDoc.expires_at, now)) {
          fail(400, 'Lien de réinitialisation invalide ou expiré.');
        }
        const user = await db.collection('users').find_one({ id: tokenDoc.user_id }, { _id: 0 });
        if (!user) fail(400, 'Lien de réinitialisation invalide ou expiré.');
        if (!pinReset) {
          if (typeof body.new_password !== 'string' || !body.new_password
              || Buffer.byteLength(body.new_password, 'utf8') > 72) {
            fail(422, 'Mot de passe invalide.');
          }
          const errors = security.passwordPolicyErrors(
            body.new_password, isAdminAccount(user),
          );
          if (errors.length) fail(422, `Mot de passe insuffisant : ${errors.join(', ')}`);
          if (isAdminAccount(user)
              && await security.verifyPassword(body.new_password, user.password_hash || '')) {
            fail(422, "Le mot de passe administrateur doit être différent de l'ancien.");
          }
        } else {
          if (isAdminAccount(user) || !user.user_pin_hash) {
            fail(400, 'Lien de réinitialisation invalide ou expiré.');
          }
          if (typeof body.current_password !== 'string' || !body.current_password
              || Buffer.byteLength(body.current_password, 'utf8') > 72
              || typeof body.pin !== 'string' || !/^\d{6}$/.test(body.pin)) {
            fail(422, 'Données de réinitialisation PIN invalides.');
          }
          if (!await security.verifyPassword(body.current_password, user.password_hash || '')) {
            await recordLoginFailure(db, String(user.email || '').toLowerCase(), requestIp(req));
            fail(401, 'Mot de passe incorrect.');
          }
        }
        const claim = await tokens.update_one({
          id: tokenDoc.id,
          user_id: user.id,
          token_hash: tokenHash,
          used: false,
          expires_at: { $gt: now },
        }, { $set: { used: true, used_at: now } });
        if (claim.modified_count !== 1) fail(400, 'Lien de réinitialisation invalide ou expiré.');
        await db.collection('sessions').update_many({
          user_id: user.id, revoked_at: { $exists: false },
        }, { $set: {
          revoked_at: new Date(),
          revocation_reason: pinReset ? 'user_pin_reset' : 'password_reset',
        } });
        if (!pinReset) {
          const updated = await db.collection('users').update_one({ id: user.id }, {
            $set: {
              password_hash: await require('bcryptjs').hash(body.new_password, 12),
              password_policy_version: 1,
            },
          });
          if (updated.modified_count !== 1) fail(400, 'Lien de réinitialisation invalide ou expiré.');
          await clearAccountFailures(db, String(user.email || ''));
        } else {
          const versionQuery = user.user_pin_version === undefined
            ? { $exists: false } : user.user_pin_version;
          const updated = await db.collection('users').update_one({
            id: user.id,
            user_pin_hash: user.user_pin_hash,
            user_pin_version: versionQuery,
          }, {
            $set: {
              user_pin_hash: await security.hashPin(user.id, body.pin, 'user', sessionSecret),
              user_pin_version: crypto.randomUUID(),
              user_pin_failures: 0,
              user_pin_enabled_at: now,
            },
            $unset: {
              user_pin_locked_until: '',
              user_pin_setup_id: '',
              user_pin_setup_token_hash: '',
              user_pin_setup_expires_at: '',
            },
          });
          if (updated.modified_count !== 1) {
            fail(400, 'Le code PIN a changé. Demandez un nouveau lien.');
          }
        }
        await tokens.update_many({
          user_id: user.id, used: false,
        }, { $set: { used: true, invalidated_at: now } });
        setClearCookies(res);
        reply(res, 200, {
          ok: true,
          message: pinReset
            ? 'Code PIN réinitialisé. Connectez-vous avec le nouveau code.'
            : 'Mot de passe réinitialisé. Connectez-vous de nouveau.',
        });
        return true;
      }
      return false;
    } catch (error) {
      onError(error, path);
      const status = Number.isInteger(error.status) ? error.status : 500;
      const detail = error.code
        ? { code: error.code, message: error.message, ...(error.extra || {}) }
        : status >= 500 ? 'Erreur interne.' : error.message;
      reply(res, status, { detail }, error.extra?.retry_after
        ? { 'Retry-After': String(error.extra.retry_after) } : {});
      return true;
    }
  };
}

module.exports = {
  createAuthRecoveryRoutes,
  allowResetRequest,
  publicAppUrl,
  resetEmailContent,
};
