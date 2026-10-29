'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const security = require('./security.cjs');
const { sessionToken } = require('./auth-session-routes.cjs');
const { readJson, reply, fail } = require('./auth-login.cjs');
const { isAdminAccount } = require('./public-user.cjs');

const RECOVERY_CODE_COUNT = 8;
const REAUTH_MAX_AGE_SECONDS = 15 * 60;

async function authenticated(req, sessionService) {
  const token = sessionToken(req);
  if (!token) fail(401, 'Session requise', 'SESSION_REQUIRED');
  return sessionService.authenticate(token);
}

async function getUser(db, id) {
  const user = await db.collection('users').find_one({ id }, { _id: 0 });
  if (!user) fail(404, 'Utilisateur introuvable');
  return user;
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

function validCode(value) {
  return typeof value === 'string' && /^\d{6}$/.test(value);
}

function createAuthMfaRoutes({ db, sessionService, jwtSecret, sessionSecret }) {
  return async function handleMfa(req, res) {
    const path = new URL(req.url, 'http://localhost').pathname;
    const method = String(req.method || 'GET').toUpperCase();
    const routes = new Set([
      '/api/auth/2fa/setup', '/api/auth/2fa/confirm',
      '/api/auth/2fa/disable', '/api/auth/admin-pin', '/api/auth/reauth',
    ]);
    if (!routes.has(path) || method !== 'POST') return false;
    if (!db || !sessionService || !jwtSecret || !sessionSecret) {
      reply(res, 503, { detail: 'Routes de sécurité Node indisponibles.', code: 'MIGRATION_INCOMPLETE' });
      return true;
    }
    try {
      const body = path === '/api/auth/2fa/setup' ? {} : await readJson(req);
      if (path === '/api/auth/2fa/confirm' && !validCode(body.code)) fail(422, 'Code 2FA invalide');
      if (path === '/api/auth/admin-pin'
          && (!Object.hasOwn(body, 'pin') || !validCode(body.code)
              || typeof body.current_password !== 'string'
              || (body.pin != null && !validCode(body.pin)))) fail(422, 'Données PIN invalides');
      if (path === '/api/auth/2fa/disable'
          && (typeof body.current_password !== 'string' || !validCode(body.code))) {
        fail(422, 'Données de désactivation invalides');
      }
      if (path === '/api/auth/reauth' && typeof body.current_password !== 'string') {
        fail(422, 'Mot de passe actuel requis');
      }

      if (path === '/api/auth/2fa/confirm') {
        let userId = null;
        let enrollmentId = null;
        if (body.setup_token) {
          let setup;
          try { setup = security.decodeMfaToken(body.setup_token, jwtSecret, 'mfa_setup'); }
          catch { fail(401, 'Jeton de configuration 2FA invalide'); }
          userId = setup.sub;
          enrollmentId = setup.enrollment_id;
        } else {
          userId = (await authenticated(req, sessionService)).userId;
        }
        const user = await getUser(db, userId);
        if (!isAdminAccount(user)) fail(403, 'La double authentification est réservée aux administrateurs');
        const enrollment = await db.collection('mfa_enrollments').find_one({
          ...(enrollmentId ? { id: enrollmentId } : {}),
          user_id: userId,
          used: false,
          expires_at: { $gt: new Date() },
        }, { _id: 0 });
        if (!enrollment) fail(400, 'Session de configuration 2FA expirée');
        let secret;
        try {
          secret = security.decryptFernet(enrollment.secret_encrypted, security.fernetKey(sessionSecret));
        } catch { fail(500, 'Configuration 2FA indisponible'); }
        const counter = security.verifyTotp(secret, body.code);
        if (counter === null) fail(401, 'Code 2FA invalide');
        const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
          `${crypto.randomBytes(4).toString('hex')}-${crypto.randomBytes(4).toString('hex')}`);
        await db.collection('users').update_one({ id: userId }, { $set: {
          two_fa_enabled: true,
          two_fa_secret_encrypted: enrollment.secret_encrypted,
          two_fa_last_counter: counter,
          recovery_codes: await Promise.all(recoveryCodes.map(async code => ({
            id: crypto.randomUUID(),
            hash: await bcrypt.hash(code, 12),
            used: false,
          }))),
        } });
        await db.collection('mfa_enrollments').update_one(
          { id: enrollment.id, used: false },
          { $set: { used: true, used_at: new Date().toISOString() } },
        );
        reply(res, 200, { enabled: true, recovery_codes: recoveryCodes });
        return true;
      }

      const identity = await authenticated(req, sessionService);
      const user = await getUser(db, identity.userId);
      if (path === '/api/auth/2fa/setup') {
        if (!isAdminAccount(user)) fail(403, 'La double authentification est réservée aux administrateurs');
        if (user.two_fa_enabled) fail(409, 'La double authentification est déjà activée');
        const { beginMfaEnrollment } = require('./auth-login.cjs');
        reply(res, 200, await beginMfaEnrollment(db, user, jwtSecret, sessionSecret));
        return true;
      }
      if (path === '/api/auth/2fa/disable') {
        if (isAdminAccount(user)) fail(403, 'La 2FA est obligatoire pour les administrateurs');
        if (!await security.verifyPassword(body.current_password, user.password_hash || '')) {
          fail(401, 'Mot de passe actuel incorrect');
        }
        if (!await verifyTotp(db, user, body.code, sessionSecret)) fail(401, 'Code 2FA invalide');
        await db.collection('users').update_one({ id: user.id }, {
          $set: { two_fa_enabled: false },
          $unset: {
            two_fa_secret_encrypted: '', two_fa_last_counter: '',
            recovery_codes: '',
          },
        });
        reply(res, 200, { enabled: false });
        return true;
      }
      if (path === '/api/auth/admin-pin') {
        if (!isAdminAccount(user) || !user.two_fa_enabled) {
          fail(403, 'Le PIN est réservé aux administrateurs ayant activé la double authentification.');
        }
        if (!await security.verifyPassword(body.current_password, user.password_hash || '')) {
          fail(401, 'Mot de passe actuel incorrect');
        }
        if (!await verifyTotp(db, user, body.code, sessionSecret)) {
          fail(401, 'Code de l’authentificateur invalide');
        }
        const update = body.pin == null ? {
          $unset: {
            admin_pin_hash: '', admin_pin_version: '',
            admin_pin_failures: '', admin_pin_locked_until: '',
          },
        } : {
          $set: {
            admin_pin_hash: await security.hashPin(user.id, body.pin, 'admin', sessionSecret),
            admin_pin_version: crypto.randomUUID(),
            admin_pin_failures: 0,
          },
          $unset: { admin_pin_locked_until: '' },
        };
        await db.collection('users').update_one({ id: user.id }, update);
        await db.collection('sessions').update_many({
          user_id: user.id,
          id: { $ne: identity.sessionId },
          revoked_at: { $exists: false },
        }, { $set: {
          revoked_at: new Date(), revocation_reason: 'admin_pin_changed',
        } });
        await db.collection('admin_logs').insert_one({
          id: crypto.randomUUID(),
          admin_id: user.id,
          admin_username: user.username,
          action: 'admin_pin_updated',
          target_user_id: null,
          target_username: null,
          details: { enabled: body.pin != null },
          created_at: new Date().toISOString(),
        });
        reply(res, 200, { enabled: body.pin != null });
        return true;
      }

      if (!await security.verifyPassword(body.current_password, user.password_hash || '')) {
        fail(401, 'Mot de passe actuel incorrect');
      }
      if (isAdminAccount(user) && user.two_fa_enabled
          && !await verifyTotp(db, user, body.otp || '', sessionSecret)) {
        fail(401, 'Code 2FA invalide');
      }
      await db.collection('sessions').update_one({
        id: identity.sessionId, user_id: user.id, revoked_at: { $exists: false },
      }, { $set: { last_auth_at: new Date() } });
      if (isAdminAccount(user)) identity.session.admin_auth_method = 'totp';
      const rotated = await sessionService.rotate(identity);
      reply(res, 200, { ok: true, expires_in: REAUTH_MAX_AGE_SECONDS }, {
        'Set-Cookie': rotated.setCookie,
      });
      return true;
    } catch (error) {
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

module.exports = { createAuthMfaRoutes };
