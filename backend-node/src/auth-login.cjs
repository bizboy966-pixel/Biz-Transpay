'use strict';

const crypto = require('node:crypto');
const security = require('./security.cjs');
const { publicUser, isAdminAccount, ensurePlatformOwnerRole } = require('./public-user.cjs');

const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const CHALLENGE_AFTER = 5;
const PIN_MAX_FAILURES = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;

class AuthRouteError extends Error {
  constructor(status, message, code, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function authHash(value) {
  return crypto.createHash('sha256').update(String(value || '').trim().toLowerCase()).digest('hex');
}

function requestIp(req) {
  return String(req.socket?.remoteAddress || 'unknown').slice(0, 128);
}

function reply(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function fail(status, message, code, extra = {}) {
  throw new AuthRouteError(status, message, code, extra);
}

async function readJson(req, maxBytes = 16_384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) fail(413, 'Requête trop volumineuse.');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    fail(422, 'Corps JSON invalide.');
  }
}

function base32Encode(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let buffer = 0;
  let bits = 0;
  let result = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(buffer >>> bits) & 31];
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits) result += alphabet[(buffer << (5 - bits)) & 31];
  return result;
}

function totpUri(secret, account) {
  const label = `Biz-transPay:${account}`;
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=Biz-transPay&algorithm=SHA1&digits=6&period=30`;
}

function turnstileConfig(env) {
  return {
    secret: String(env.CLOUDFLARE_TURNSTILE_SECRET_KEY || '').trim(),
    allowedHostnames: new Set(String(env.CLOUDFLARE_TURNSTILE_ALLOWED_HOSTNAMES || '')
      .split(',').map(value => value.trim().toLowerCase()).filter(Boolean)),
  };
}

async function verifyTurnstile(token, req, action, env) {
  const { secret, allowedHostnames } = turnstileConfig(env);
  if (!secret) fail(503, "La vérification anti-bot n'est pas configurée.", 'ANTI_BOT_NOT_CONFIGURED');
  if (typeof token !== 'string' || !token) fail(400, 'La vérification anti-bot est obligatoire.', 'TURNSTILE_REQUIRED');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const form = new URLSearchParams({ secret, response: token });
    const ip = requestIp(req);
    if (ip && ip !== 'unknown') form.set('remoteip', ip);
    const response = await fetch(TURNSTILE_URL, {
      method: 'POST', body: form, signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const result = await response.json();
    if (response.status !== 200) fail(503, 'La vérification anti-bot est temporairement indisponible.', 'ANTI_BOT_UNAVAILABLE');
    if (!result.success || result.action !== action
        || (allowedHostnames.size && !allowedHostnames.has(String(result.hostname || '').toLowerCase()))) {
      fail(403, 'Vérification anti-bot refusée.', 'TURNSTILE_REJECTED');
    }
  } catch (error) {
    if (error instanceof AuthRouteError) throw error;
    fail(503, 'La vérification anti-bot est temporairement indisponible.', 'ANTI_BOT_UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
  }
}

async function getRateState(db, scope, value) {
  const key = { scope, value_hash: authHash(value) };
  const stored = await db.collection('auth_rate_limits').find_one(key, { _id: 0 });
  if (!stored) return {};
  const state = { ...stored, _found: true };
  const expiration = state.expires_at instanceof Date ? state.expires_at.getTime() : Date.parse(state.expires_at);
  if (state.expires_at && Number.isFinite(expiration) && expiration <= Date.now()) {
    await db.collection('auth_rate_limits').delete_one(key);
    return {};
  }
  return state;
}

async function recordLoginFailure(db, identifier, ip) {
  const now = new Date();
  for (const [scope, value] of [['account', identifier], ['ip', ip]]) {
    const valueHash = authHash(value);
    const key = { scope, value_hash: valueHash };
    const current = await getRateState(db, scope, value);
    const failures = Number(current.failures || 0) + 1;
    const lockFailures = scope === 'account' ? failures : Math.floor(failures / 2);
    const lockMs = lockFailures >= 12 ? 3_600_000
      : lockFailures >= 10 ? 900_000 : lockFailures >= 8 ? 300_000
        : lockFailures >= 6 ? 60_000 : 0;
    const update = {
      $set: {
        last_failed_at: now, expires_at: new Date(now.getTime() + AUTH_WINDOW_MS),
        ...(lockMs ? { lock_until: new Date(now.getTime() + lockMs) } : {}),
      },
      $inc: { failures: 1 },
    };
    const result = current._found
      ? await db.collection('auth_rate_limits').update_one(key, update)
      : null;
    if (!result?.matched_count) {
      try {
        await db.collection('auth_rate_limits').insert_one({
          id: `${scope}:${valueHash}`,
          ...key,
          failures: 1,
          last_failed_at: now,
          expires_at: new Date(now.getTime() + AUTH_WINDOW_MS),
          ...(lockMs ? { lock_until: new Date(now.getTime() + lockMs) } : {}),
          created_at: now,
        });
      } catch {
        // The deterministic document ID serializes the concurrent first failure.
        await db.collection('auth_rate_limits').update_one(key, update);
      }
    }
  }
}

async function clearAccountFailures(db, identifier) {
  await db.collection('auth_rate_limits').delete_one({
    scope: 'account', value_hash: authHash(identifier),
  });
}

async function issueLoginChallenge(db, identifier, ip) {
  const nonce = crypto.randomBytes(24).toString('base64url');
  const id = crypto.randomUUID();
  await db.collection('auth_challenges').insert_one({
    id, nonce,
    identifier_hash: authHash(identifier),
    ip_hash: authHash(ip),
    difficulty: 4,
    used: false,
    expires_at: new Date(Date.now() + 5 * 60 * 1000),
    created_at: new Date(),
  });
  return { id, nonce, difficulty: 4 };
}

async function verifyLoginChallenge(db, identifier, ip, challengeId, solution) {
  if (typeof solution !== 'string' || !/^\d{1,128}$/.test(solution || '')) return false;
  const now = new Date();
  const challenge = await db.collection('auth_challenges').find_one({
    id: challengeId,
    identifier_hash: authHash(identifier),
    ip_hash: authHash(ip),
    used: false,
    expires_at: { $gt: now },
  }, { _id: 0 });
  if (!challenge) return false;
  const digest = crypto.createHash('sha256').update(`${challenge.nonce}${solution}`).digest('hex');
  if (!digest.startsWith('0'.repeat(Number(challenge.difficulty)))) return false;
  const claimed = await db.collection('auth_challenges').update_one(
    { id: challengeId, used: false },
    { $set: { used: true, used_at: now } },
  );
  return claimed.modified_count === 1;
}

async function checkLoginSecurity(db, identifier, ip, challengeId, challengeSolution) {
  const [account, ipState] = await Promise.all([
    getRateState(db, 'account', identifier), getRateState(db, 'ip', ip),
  ]);
  const now = Date.now();
  for (const state of [account, ipState]) {
    const lockUntil = state.lock_until instanceof Date ? state.lock_until.getTime() : Date.parse(state.lock_until);
    if (state.lock_until && Number.isFinite(lockUntil) && lockUntil > now) {
      const retry = Math.max(1, Math.floor((lockUntil - now) / 1000));
      fail(429, 'Trop de tentatives. Réessayez plus tard.', 'AUTH_TEMPORARILY_LOCKED', { retry_after: retry });
    }
  }
  const failures = Math.max(Number(account.failures || 0), Math.floor(Number(ipState.failures || 0) / 2));
  if (failures >= CHALLENGE_AFTER) {
    const valid = challengeId && challengeSolution
      && await verifyLoginChallenge(db, identifier, ip, challengeId, challengeSolution);
    if (!valid) {
      const challenge = await issueLoginChallenge(db, identifier, ip);
      fail(429, 'Vérification de sécurité requise.', 'AUTH_CHALLENGE_REQUIRED', { challenge });
    }
  }
}

async function verifyPin(db, user, pin, prefix, sessionSecret) {
  const hashKey = `${prefix}_hash`;
  const failuresKey = `${prefix}_failures`;
  const lockKey = `${prefix}_locked_until`;
  const hashed = user[hashKey];
  if (!hashed) return false;
  const now = new Date();
  const lockedUntil = user[lockKey] instanceof Date ? user[lockKey].getTime() : Date.parse(user[lockKey]);
  if (user[lockKey] && Number.isFinite(lockedUntil) && lockedUntil > now.getTime()) {
    const retry = Math.max(1, Math.floor((lockedUntil - now.getTime()) / 1000));
    fail(429, 'PIN temporairement bloqué. Réessayez plus tard.',
      prefix === 'admin_pin' ? 'ADMIN_PIN_LOCKED' : 'USER_PIN_LOCKED', { retry_after: retry });
  }
  if (user[lockKey]) {
    await db.collection('users').update_one(
      { id: user.id, [hashKey]: hashed, [lockKey]: user[lockKey] },
      { $set: { [failuresKey]: 0 }, $unset: { [lockKey]: '' } },
    );
  }
  const purpose = prefix === 'user_pin' ? 'user' : 'admin';
  const valid = await security.verifyPin(user.id, pin || '', purpose, hashed, sessionSecret);
  if (valid) {
    const claimed = await db.collection('users').update_one({
      id: user.id, [hashKey]: hashed, [failuresKey]: { $lt: PIN_MAX_FAILURES },
    }, { $set: { [failuresKey]: 0 }, $unset: { [lockKey]: '' } });
    return claimed.matched_count === 1;
  }
  await db.collection('users').update_one(
    { id: user.id, [hashKey]: hashed }, { $inc: { [failuresKey]: 1 } },
  );
  const latest = await db.collection('users').find_one({ id: user.id }, { _id: 0 });
  if (latest && latest[hashKey] === hashed && Number(latest[failuresKey] || 0) >= PIN_MAX_FAILURES) {
    await db.collection('users').update_one({
      id: user.id, [hashKey]: hashed, [failuresKey]: { $gte: PIN_MAX_FAILURES },
    }, { $set: { [lockKey]: new Date(now.getTime() + PIN_LOCK_MS) } });
  }
  return false;
}

async function verifyTotp(db, user, code, sessionSecret) {
  if (!user.two_fa_secret_encrypted) return false;
  let secret;
  try {
    secret = security.decryptFernet(user.two_fa_secret_encrypted, security.fernetKey(sessionSecret));
  } catch { return false; }
  const counter = security.verifyTotp(secret, code, user.two_fa_last_counter ?? null);
  if (counter === null) return false;
  const claimed = await db.collection('users').update_one({
    id: user.id,
    $or: [
      { two_fa_last_counter: { $lt: counter } },
      { two_fa_last_counter: { $exists: false } },
    ],
  }, { $set: { two_fa_last_counter: counter } });
  return claimed.modified_count === 1;
}

async function beginMfaEnrollment(db, user, jwtSecret, sessionSecret) {
  const secret = base32Encode(crypto.randomBytes(20));
  const enrollmentId = crypto.randomUUID();
  await db.collection('mfa_enrollments').insert_one({
    id: enrollmentId, user_id: user.id,
    secret_encrypted: security.encryptFernet(secret, security.fernetKey(sessionSecret)),
    used: false,
    expires_at: new Date(Date.now() + 10 * 60 * 1000),
    created_at: new Date().toISOString(),
  });
  const setupToken = security.createMfaToken(
    user.id, 'mfa_setup', { enrollment_id: enrollmentId }, jwtSecret);
  return {
    setup_token: setupToken, secret,
    otpauth_uri: totpUri(secret, user.email || user.username || user.id),
    expires_in: 600,
  };
}

async function createUserPinSetupChallenge(db, user, jwtSecret) {
  if (isAdminAccount(user)) fail(403, 'La configuration du PIN administrateur suit le parcours de sécurité des administrateurs.');
  const setupId = crypto.randomUUID();
  const token = security.createMfaToken(user.id, 'user_pin_setup', {
    setup_id: setupId, pin_version: user.user_pin_version ?? null,
  }, jwtSecret);
  const expires = new Date(Date.now() + 5 * 60 * 1000);
  const result = await db.collection('users').update_one({
    id: user.id, user_pin_hash: { $exists: false },
  }, { $set: {
    user_pin_setup_id: setupId,
    user_pin_setup_token_hash: crypto.createHash('sha256').update(token).digest('hex'),
    user_pin_setup_expires_at: expires,
  } });
  if (!result.matched_count) {
    fail(409, 'Le code PIN vient d’être activé. Reconnectez-vous.', 'USER_PIN_ALREADY_ENABLED');
  }
  return token;
}

async function completeLogin(db, user, ip, userAgent, onAdminLogin) {
  const now = new Date().toISOString();
  const unusual = Boolean(
    (user.last_login_ip && user.last_login_ip !== ip)
    || (user.last_login_user_agent && user.last_login_user_agent !== userAgent)
  );
  await Promise.all([
    db.collection('users').update_one({ id: user.id }, { $set: {
      last_login_ip: ip, last_login_user_agent: userAgent, last_login_at: now,
    } }),
    db.collection('auth_events').insert_one({
      id: crypto.randomUUID(), user_id: user.id, type: 'login',
      ip, user_agent: userAgent, unusual, created_at: now,
    }),
  ]);
  if (isAdminAccount(user) && typeof onAdminLogin === 'function') {
    try {
      onAdminLogin({
        type: 'admin_login', userId: user.id, ip, unusual, detectedAt: now,
      });
    } catch {
      // Authentication must not depend on an external notification channel.
    }
  }
}

function validationError(body) {
  if (!body || typeof body !== 'object' || typeof body.email !== 'string' || typeof body.password !== 'string') {
    return 'Adresse e-mail/nom d’utilisateur et mot de passe requis.';
  }
  for (const key of ['pin', 'pin_confirmation']) {
    if (body[key] !== undefined && body[key] !== null && !/^\d{6}$/.test(body[key])) {
      return 'Le code PIN doit contenir six chiffres.';
    }
  }
  for (const key of ['turnstile_token', 'pin_setup_token', 'user_pin_token', 'mfa_token', 'challenge_id', 'challenge_solution']) {
    if (body[key] !== undefined && body[key] !== null
        && (typeof body[key] !== 'string' || body[key].length > 2048)) return 'Données de connexion invalides.';
  }
  if (body.security_method !== undefined && !['totp', 'pin'].includes(body.security_method)) {
    return 'Méthode de sécurité invalide.';
  }
  return null;
}

function createAuthLoginRoute({
  db, sessionService, jwtSecret, sessionSecret, env = process.env,
  verifyBot = verifyTurnstile, onAdminLogin,
}) {
  return async function handleLogin(req, res) {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/api/security/turnstile-config') {
      const config = turnstileConfig(env);
      reply(res, 200, {
        enabled: Boolean(config.secret && env.CLOUDFLARE_TURNSTILE_SITE_KEY),
        site_key: env.CLOUDFLARE_TURNSTILE_SITE_KEY || null,
      });
      return true;
    }
    if (req.method !== 'POST' || path !== '/api/auth/login') return false;
    if (!db || !sessionService || !jwtSecret || !sessionSecret) {
      reply(res, 503, {
        detail: 'La route de connexion Node sera disponible après configuration de MySQL Preview.',
        code: 'MIGRATION_INCOMPLETE',
      });
      return true;
    }
    try {
      const body = await readJson(req);
      const invalid = validationError(body);
      if (invalid) fail(422, invalid);
      const identifier = body.email.toLowerCase().trim();
      const ip = requestIp(req);
      if (!body.mfa_token && !body.user_pin_token && !body.pin_setup_token
          && !(body.challenge_id && body.challenge_solution)) {
        await verifyBot(body.turnstile_token, req, 'login', env);
      }
      await checkLoginSecurity(db, identifier, ip, body.challenge_id, body.challenge_solution);
      let user = await db.collection('users').find_one({
        $or: [{ email: identifier }, { username: identifier }],
      }, { _id: 0 });
      if (!user || !await security.verifyPassword(body.password, user.password_hash || '')) {
        await recordLoginFailure(db, identifier, ip);
        fail(401, 'Identifiants invalides');
      }
      user = await ensurePlatformOwnerRole(db, user, {
        platformOwnerEmail: env.PLATFORM_OWNER_EMAIL || '',
        claimBefore: env.PLATFORM_OWNER_CLAIM_BEFORE || '',
      });
      const admin = isAdminAccount(user);
      if (admin && !user.two_fa_enabled) {
        const setup = await beginMfaEnrollment(db, user, jwtSecret, sessionSecret);
        reply(res, 200, { mfa_setup_required: true, mfa_setup: setup });
        return true;
      }
      if (admin) {
        if (!body.mfa_token) {
          reply(res, 200, {
            mfa_required: true,
            mfa_token: security.createMfaToken(user.id, 'login_mfa', {
              pin_version: user.admin_pin_version ?? null,
            }, jwtSecret),
            security_methods: user.admin_pin_hash ? ['pin'] : ['totp'],
          });
          return true;
        }
        let mfa;
        try { mfa = security.decodeMfaToken(body.mfa_token, jwtSecret, 'login_mfa'); }
        catch { await recordLoginFailure(db, identifier, ip); fail(401, 'Jeton de sécurité invalide'); }
        if (mfa.sub !== user.id) {
          await recordLoginFailure(db, identifier, ip);
          fail(401, 'Jeton de sécurité invalide');
        }
        if (user.admin_pin_hash && body.security_method !== 'pin') {
          await recordLoginFailure(db, identifier, ip);
          fail(401, 'Utilisez votre code PIN pour vous connecter.');
        }
        if (body.security_method === 'pin') {
          const valid = Boolean(user.admin_pin_version)
            && mfa.pin_version === user.admin_pin_version
            && await verifyPin(db, user, body.pin, 'admin_pin', sessionSecret);
          if (!valid) {
            await recordLoginFailure(db, identifier, ip);
            fail(401, 'PIN invalide ou non configuré. Utilisez l’authentificateur si nécessaire.');
          }
        } else if (!await verifyTotp(db, user, body.otp || '', sessionSecret)) {
          await recordLoginFailure(db, identifier, ip);
          fail(401, 'Code 2FA invalide ou expiré. Utilisez le code à 6 chiffres actuellement affiché dans votre application d’authentification.');
        }
      }

      let userPinVerified = false;
      if (!admin) {
        if (body.pin_setup_token) {
          let setup;
          try { setup = security.decodeMfaToken(body.pin_setup_token, jwtSecret, 'user_pin_setup'); }
          catch { await recordLoginFailure(db, identifier, ip); fail(401, 'Jeton de sécurité invalide'); }
          if (setup.sub !== user.id || setup.pin_version !== (user.user_pin_version ?? null)
              || !body.pin || body.pin !== body.pin_confirmation) {
            await recordLoginFailure(db, identifier, ip);
            fail(401, 'Jeton d’activation ou confirmation du PIN invalide.');
          }
          const proofHash = crypto.createHash('sha256').update(body.pin_setup_token).digest('hex');
          const now = new Date();
          const claimed = await db.collection('users').update_one({
            id: user.id, user_pin_hash: { $exists: false },
            user_pin_setup_id: setup.setup_id,
            user_pin_setup_token_hash: proofHash,
            user_pin_setup_expires_at: { $gt: now },
          }, { $set: {
            user_pin_hash: await security.hashPin(user.id, body.pin, 'user', sessionSecret),
            user_pin_version: crypto.randomUUID(),
            user_pin_failures: 0,
            user_pin_enabled_at: now,
          }, $unset: {
            user_pin_setup_id: '', user_pin_setup_token_hash: '',
            user_pin_setup_expires_at: '',
          } });
          if (claimed.matched_count !== 1) {
            fail(409, 'Cette activation a expiré. Reconnectez-vous pour en commencer une nouvelle.', 'USER_PIN_SETUP_EXPIRED');
          }
          user = await db.collection('users').find_one({ id: user.id }, { _id: 0 });
          userPinVerified = true;
        } else if (!user.user_pin_hash) {
          reply(res, 200, {
            user_pin_setup_required: true,
            pin_setup_token: await createUserPinSetupChallenge(db, user, jwtSecret),
          });
          return true;
        } else {
          if (!body.user_pin_token) {
            reply(res, 200, {
              user_pin_required: true,
              user_pin_token: security.createMfaToken(user.id, 'user_login_pin', {
                pin_version: user.user_pin_version ?? null,
              }, jwtSecret),
            });
            return true;
          }
          let pinPayload;
          try { pinPayload = security.decodeMfaToken(body.user_pin_token, jwtSecret, 'user_login_pin'); }
          catch { await recordLoginFailure(db, identifier, ip); fail(401, 'Jeton de sécurité invalide'); }
          userPinVerified = pinPayload.sub === user.id
            && pinPayload.pin_version === (user.user_pin_version ?? null)
            && await verifyPin(db, user, body.pin, 'user_pin', sessionSecret);
          if (!userPinVerified) {
            await recordLoginFailure(db, identifier, ip);
            fail(401, 'Code PIN incorrect ou non configuré.');
          }
        }
      }

      await Promise.all([
        clearAccountFailures(db, identifier),
        completeLogin(
          db, user, ip, String(req.headers['user-agent'] || '').slice(0, 300),
          onAdminLogin,
        ),
      ]);
      const issued = await sessionService.issue(user.id, {
        ip,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
        adminAuthMethod: admin ? (body.security_method || 'totp') : 'password',
        userPinRequired: !admin,
        userPinAuthenticated: userPinVerified,
      });
      reply(res, 200, { token: null, user: publicUser(user) }, { 'Set-Cookie': issued.setCookie });
      return true;
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      const detail = error instanceof AuthRouteError && error.extra.code
        ? { code: error.code, message: error.message, ...error.extra }
        : error instanceof AuthRouteError && error.code
          ? { code: error.code, message: error.message, ...error.extra }
          : status >= 500 ? 'Erreur interne.' : error.message;
      const headers = error.extra?.retry_after
        ? { 'Retry-After': String(error.extra.retry_after) } : {};
      reply(res, status, { detail }, headers);
      return true;
    }
  };
}

module.exports = {
  createAuthLoginRoute, verifyTurnstile, checkLoginSecurity,
  recordLoginFailure, clearAccountFailures, verifyLoginChallenge, verifyPin, verifyTotp,
  beginMfaEnrollment, createUserPinSetupChallenge, readJson, reply, fail,
  AuthRouteError,
};
