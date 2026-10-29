'use strict';

const crypto = require('node:crypto');
const security = require('./security.cjs');
const {
  verifyTurnstile, beginMfaEnrollment, createUserPinSetupChallenge,
  readJson, reply, fail,
} = require('./auth-login.cjs');
const { publicUser } = require('./public-user.cjs');

function validEmail(value) {
  return typeof value === 'string' && value.length <= 320
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateRegistration(body) {
  if (typeof body.full_name !== 'string' || !body.full_name.trim()
      || body.full_name.length > 120) return 'Nom complet invalide.';
  if (typeof body.username !== 'string' || body.username.length < 6
      || body.username.length > 50) return "Nom d'utilisateur invalide.";
  if (!['personal', 'merchant'].includes(body.account_type)) return 'Type de compte invalide.';
  if (typeof body.country !== 'string' || body.country.length < 2
      || body.country.length > 3) return 'Pays invalide.';
  if (typeof body.phone !== 'string' || body.phone.length < 3
      || body.phone.length > 40) return 'Numéro de téléphone invalide.';
  if (!validEmail(body.email)) return 'Adresse e-mail invalide.';
  if (typeof body.password !== 'string' || Buffer.byteLength(body.password, 'utf8') > 72) {
    return 'Mot de passe invalide.';
  }
  if (body.referral_code != null
      && (typeof body.referral_code !== 'string' || body.referral_code.length < 6
          || body.referral_code.length > 50)) return 'Lien de parrainage invalide';
  return null;
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function isExpired(value, now) {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) && time <= now.getTime();
}

function createAuthRegisterRoute({
  db, jwtSecret, sessionSecret, env = process.env, verifyBot = verifyTurnstile,
}) {
  return async function handleRegister(req, res) {
    if (req.method !== 'POST'
        || new URL(req.url, 'http://localhost').pathname !== '/api/auth/register') return false;
    if (!db || !jwtSecret || !sessionSecret || typeof db.transaction !== 'function') {
      reply(res, 503, {
        detail: 'Inscription Node indisponible sans MySQL Preview et transaction sûre.',
        code: 'MIGRATION_INCOMPLETE',
      });
      return true;
    }
    let created;
    try {
      const body = await readJson(req);
      const validation = validateRegistration(body);
      if (validation) fail(422, validation);
      await verifyBot(body.turnstile_token, req, 'register', env);

      const email = body.email.trim().toLowerCase();
      const username = body.username.toLowerCase();
      const referralCode = body.referral_code?.trim();
      const phone = body.phone;
      const uid = crypto.randomUUID();
      const now = new Date();
      const createdAt = now.toISOString();

      created = await db.transaction(async tx => {
        // Serialize account creation so uniqueness and first-admin bootstrap
        // are evaluated against the latest committed user set.
        await tx.lockCollection('users');
        await tx.lockCollection('platform_bootstrap');
        if (await db.collection('users').find_one({ email }, { _id: 0, id: 1 })) {
          fail(400, 'Email déjà utilisé');
        }
        if (await db.collection('users').find_one({ username }, { _id: 0, id: 1 })) {
          fail(400, "Nom d'utilisateur déjà pris");
        }

        let sponsor = null;
        if (referralCode) {
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(referralCode)) {
            fail(400, 'Lien de parrainage invalide');
          }
          sponsor = await db.collection('users').find_one({
            id: referralCode.toLowerCase(),
            is_blocked: { $ne: true },
            is_banned: { $ne: true },
          }, { _id: 0, id: 1, username: 1, phone: 1, email: 1 });
          if (!sponsor) fail(400, 'Lien de parrainage invalide');
          if (sponsor.username === username || sponsor.email === email
              || digits(sponsor.phone) === digits(phone)) fail(400, 'Auto-parrainage interdit');
        }

        const firstUsers = await db.collection('users').find({}, { _id: 0, id: 1 }).to_list(1);
        const isFirst = firstUsers.length === 0;
        const passwordErrors = security.passwordPolicyErrors(body.password, isFirst);
        if (passwordErrors.length) fail(422, `Mot de passe insuffisant : ${passwordErrors.join(', ')}`);

        let bootstrapToken = null;
        if (isFirst) {
          bootstrapToken = crypto.randomBytes(24).toString('base64url');
          const prior = await tx.get('platform_bootstrap', 'first_super_admin');
          if (prior && !(prior.status === 'claiming' && isExpired(prior.expires_at, now))) {
            fail(409, 'Initialisation de la plateforme en cours. Réessayez dans quelques instants.');
          }
          const claim = {
            _id: 'first_super_admin',
            status: 'claiming',
            claim_token: bootstrapToken,
            claimed_at: createdAt,
            expires_at: new Date(now.getTime() + 5 * 60 * 1000),
          };
          if (prior) await tx.replace('platform_bootstrap', 'first_super_admin', claim);
          else await tx.insert('platform_bootstrap', 'first_super_admin', claim);
        }

        const user = {
          id: uid,
          full_name: body.full_name,
          username,
          // The public registration flow always creates a merchant profile.
          account_type: 'merchant',
          country: body.country,
          phone,
          email,
          password_hash: await require('bcryptjs').hash(body.password, 12),
          password_policy_version: 1,
          kyc_status: isFirst ? 'verified' : 'not_started',
          balance_xof: 0,
          balance_xaf: 0,
          balance_usdt: 0,
          created_at: createdAt,
          two_fa_enabled: false,
          language: 'fr',
          default_currency: 'XOF',
          role: isFirst ? 'super_admin' : 'user',
          platform_owner: isFirst,
          is_blocked: false,
          is_banned: false,
          withdrawals_blocked: false,
          ...(sponsor ? {
            referred_by_user_id: sponsor.id,
            referral_registered_at: createdAt,
          } : {}),
        };
        await tx.insert('users', uid, user);
        if (isFirst) {
          const bootstrapRecord = await tx.get('platform_bootstrap', 'first_super_admin') || {};
          delete bootstrapRecord.claim_token;
          delete bootstrapRecord.expires_at;
          await tx.replace('platform_bootstrap', 'first_super_admin', {
            ...bootstrapRecord,
            status: 'complete',
            user_id: uid,
            completed_at: createdAt,
          });
        }
        return { user, isFirst };
      });

      if (created.isFirst) {
        const mfaSetup = await beginMfaEnrollment(db, created.user, jwtSecret, sessionSecret);
        reply(res, 200, {
          mfa_setup_required: true,
          mfa_setup: mfaSetup,
          user: publicUser(created.user),
        });
      } else {
        reply(res, 200, {
          user_pin_setup_required: true,
          pin_setup_token: await createUserPinSetupChallenge(db, created.user, jwtSecret),
        });
      }
      return true;
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      const detail = error.code
        ? { code: error.code, message: error.message, ...error.extra }
        : status >= 500 ? 'Erreur interne.' : error.message;
      reply(res, status, { detail });
      return true;
    }
  };
}

module.exports = { createAuthRegisterRoute, validateRegistration };
