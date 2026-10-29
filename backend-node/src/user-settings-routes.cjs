'use strict';

const bcrypt = require('bcryptjs');
const { URL } = require('node:url');
const { sessionToken } = require('./auth-session-routes.cjs');
const { publicUser, isAdminAccount } = require('./public-user.cjs');
const { verifyPassword, passwordPolicyErrors } = require('./security.cjs');
const { verifyTotp, readJson, reply } = require('./auth-login.cjs');
const { validateRasterImage } = require('./kyc-routes.cjs');

function routeError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function profileUpdates(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw routeError(422, 'Données de profil invalides.');
  }
  const updates = {};
  for (const [key, min, max] of [
    ['full_name', 1, 120], ['phone', 3, 40],
  ]) {
    if (body[key] !== undefined && body[key] !== null) {
      if (typeof body[key] !== 'string' || body[key].length < min || body[key].length > max) {
        throw routeError(422, `${key} invalide.`);
      }
      updates[key] = body[key];
    }
  }
  if (body.email !== undefined && body.email !== null) {
    if (typeof body.email !== 'string' || body.email.length > 320
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      throw routeError(422, 'Adresse e-mail invalide.');
    }
    updates.email = body.email.toLowerCase();
  }
  if (body.language !== undefined && body.language !== null) {
    if (typeof body.language !== 'string') throw routeError(422, 'Langue invalide.');
    updates.language = body.language;
  }
  if (body.default_currency !== undefined && body.default_currency !== null) {
    if (!['XOF', 'XAF'].includes(body.default_currency)) {
      throw routeError(422, 'Devise par défaut invalide.');
    }
    updates.default_currency = body.default_currency;
  }
  if (body.two_fa_enabled !== undefined && body.two_fa_enabled !== null) {
    throw routeError(400, 'Utilisez la procédure de configuration 2FA');
  }
  if (body.avatar_url !== undefined && body.avatar_url !== null) {
    if (typeof body.avatar_url !== 'string' || body.avatar_url.length > 3_000_000) {
      throw routeError(422, 'Photo invalide ou trop volumineuse.');
    }
    const value = body.avatar_url.trim();
    if (!value) updates.avatar_url = null;
    else if (value.toLowerCase().startsWith('data:')) {
      updates.avatar_url = validateRasterImage(value, 'Photo');
    } else {
      let parsed;
      try { parsed = new URL(value); } catch { throw routeError(422, 'Photo URL invalide.'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname
          || parsed.username || parsed.password
          || parsed.pathname.toLowerCase().endsWith('.svg')
          || parsed.pathname.toLowerCase().endsWith('.svgz')) {
        throw routeError(422, 'Photo URL invalide.');
      }
      updates.avatar_url = value;
    }
  }
  return updates;
}

function createUserSettingsRoutes({ db, sessionService, sessionSecret = '' } = {}) {
  return async function handleSettings(req, res) {
    const path = new URL(req.url, 'http://localhost').pathname;
    const isProfile = path === '/api/settings/profile' && req.method === 'PATCH';
    const isPassword = path === '/api/settings/password' && req.method === 'POST';
    if (!isProfile && !isPassword) return false;
    if (!db || !sessionService) {
      reply(res, 503, { detail: 'Paramètres indisponibles.', code: 'MIGRATION_INCOMPLETE' });
      return true;
    }
    try {
      const token = sessionToken(req);
      if (!token) {
        reply(res, 401, { detail: { code: 'SESSION_REQUIRED', message: 'Session requise' } });
        return true;
      }
      const identity = await sessionService.authenticate(token);
      const user = await db.collection('users').find_one({ id: identity.userId }, { _id: 0 });
      if (!user) {
        reply(res, 401, { detail: 'Utilisateur introuvable.' });
        return true;
      }
      const body = await readJson(req);
      if (isProfile) {
        const updates = profileUpdates(body);
        const protectedFields = ['full_name', 'phone', 'email'];
        if (protectedFields.some(field => Object.hasOwn(updates, field))
            && !isAdminAccount(user)) {
          reply(res, 403, { detail: "Seul un administrateur peut modifier les informations d'identité" });
          return true;
        }
        if (Object.keys(updates).length) {
          await db.collection('users').update_one(
            { id: identity.userId }, { $set: updates },
          );
        }
        const updated = await db.collection('users').find_one({ id: identity.userId }, { _id: 0 });
        reply(res, 200, publicUser(updated));
        return true;
      }
      if (typeof body.current_password !== 'string'
          || typeof body.new_password !== 'string') {
        reply(res, 422, { detail: 'Mot de passe actuel et nouveau mot de passe requis.' });
        return true;
      }
      if (!await verifyPassword(body.current_password, user.password_hash)) {
        reply(res, 400, { detail: 'Mot de passe actuel incorrect' });
        return true;
      }
      const admin = isAdminAccount(user);
      const errors = passwordPolicyErrors(body.new_password, admin);
      if (errors.length) {
        reply(res, 422, { detail: `Mot de passe insuffisant : ${errors.join(', ')}` });
        return true;
      }
      if (admin && await verifyPassword(body.new_password, user.password_hash)) {
        reply(res, 422, { detail: "Le mot de passe administrateur doit être différent de l'ancien." });
        return true;
      }
      if (admin && user.two_fa_enabled
          && !await verifyTotp(db, user, String(body.otp || ''), sessionSecret)) {
        reply(res, 401, { detail: 'Code 2FA requis pour changer le mot de passe' });
        return true;
      }
      await db.collection('users').update_one({ id: identity.userId }, {
        $set: {
          password_hash: await bcrypt.hash(body.new_password, 12),
          password_policy_version: 1,
        },
      });
      reply(res, 200, { ok: true });
      return true;
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      reply(res, status, {
        detail: status >= 500
          ? 'Erreur interne.'
          : error.code
            ? { code: error.code, message: error.message, ...error.extra }
            : error.message,
      });
      return true;
    }
  };
}

module.exports = { createUserSettingsRoutes, profileUpdates };
