'use strict';

const crypto = require('node:crypto');
const { applyInternalTransfer, operationIdentity } = require('./wallet.cjs');
const { getAppFeatures } = require('./public-config-routes.cjs');
const { sessionToken } = require('./auth-session-routes.cjs');
const { sendResendEmail } = require('./auth-recovery-routes.cjs');
const {
  verifyTurnstile, verifyPin,
} = require('./auth-login.cjs');

const MAX_BODY_BYTES = 16 * 1024;
const TRANSFER_WINDOW_MS = 60_000;
const MAX_TRANSFERS_PER_WINDOW = 12;
const EMAIL_OTP_TTL_MS = 10 * 60 * 1000;
const EMAIL_OTP_WINDOW_MS = 15 * 60 * 1000;
const EMAIL_OTP_MAX_REQUESTS = 3;
const EMAIL_OTP_MAX_ATTEMPTS = 5;
const FIAT_WALLETS = new Set([
  'XOF', 'XAF', 'CDF', 'USD', 'GMD', 'GNF', 'UGX', 'TZS',
  'KES', 'RWF', 'GHS', 'NGN', 'ZAR', 'ZMW', 'EGP',
]);

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Requête trop volumineuse');
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid body');
    return value;
  } catch {
    throw httpError(400, 'Corps JSON invalide');
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fingerprintRequest(userId, body) {
  const excluded = new Set([
    'turnstile_token', 'pin', 'withdrawal_otp_challenge_id', 'withdrawal_otp_code',
  ]);
  const payload = Object.fromEntries(Object.entries(body)
    .filter(([key]) => !excluded.has(key))
    .sort(([left], [right]) => left.localeCompare(right)));
  return crypto.createHash('sha256')
    .update(JSON.stringify({ user_id: String(userId), payload }))
    .digest('hex');
}

function maskEmail(email) {
  const [local, domain, ...rest] = String(email || '').split('@');
  if (!local || !domain || rest.length) return '';
  return `${local.slice(0, 1)}***@${domain}`;
}

function emailOtpHash(secret, userId, challengeId, code) {
  return crypto.createHmac('sha256', secret)
    .update(`${userId}:${challengeId}:${code}`)
    .digest('hex');
}

function timingSafeHexEqual(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(String(left || ''))
      || !/^[a-f0-9]{64}$/i.test(String(right || ''))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function isAdmin(user) {
  return user?.is_admin === true || user?.role === 'admin'
    || user?.account_type === 'admin';
}

function configuredProvider(providerConfig, env, provider) {
  if (!providerConfig?.enabled) return false;
  const credentialFields = new Set([
    'api_key_encrypted', 'secret_key_encrypted', 'client_secret_encrypted',
    'master_key_encrypted', 'public_key_encrypted', 'private_key_encrypted',
    'token_encrypted',
  ]);
  const encryptedCredential = Object.entries(providerConfig).some(([key, value]) => (
    credentialFields.has(key.toLowerCase())
      && typeof value === 'string' && value.length > 0
  ));
  const envCredentialNames = {
    paydunya: ['PAYDUNYA_MASTER_KEY', 'PAYDUNYA_PUBLIC_KEY', 'PAYDUNYA_PRIVATE_KEY', 'PAYDUNYA_TOKEN'],
    mbiyo: ['MBIYO_SECRET_KEY', 'MBIYO_API_KEY'],
    afribapay: ['AFRIBAPAY_API_KEY', 'AFRIBAPAY_SECRET_KEY', 'AFRIBAPAY_CLIENT_ID'],
  };
  return encryptedCredential
    || (envCredentialNames[provider] || []).some(name => Boolean(String(env[name] || '').trim()));
}

function createTransferRoutes({
  db, sessionService, sessionSecret = '', env = process.env,
  verifyBot = verifyTurnstile, verifyPinFn = verifyPin,
  cryptoCatalog, notify = async () => {}, sendEmailFn = sendResendEmail,
} = {}) {
  const rateBuckets = new Map();

  function enforceRateLimit(userId) {
    const now = Date.now();
    const recent = (rateBuckets.get(userId) || []).filter(time => time > now - TRANSFER_WINDOW_MS);
    if (recent.length >= MAX_TRANSFERS_PER_WINDOW) {
      rateBuckets.set(userId, recent);
      throw httpError(429, 'Trop de transferts. Réessayez dans une minute.', 'RATE_LIMITED');
    }
    recent.push(now);
    rateBuckets.set(userId, recent);
  }

  async function authenticate(req) {
    const authenticated = await sessionService.authenticate(sessionToken(req));
    return {
      authenticated,
      userId: sessionService.requireRecentAuth(authenticated),
    };
  }

  async function startEmailOtp(user, requestFingerprint, senderEmail) {
    const email = String(user.email || '').trim();
    const sender = String(senderEmail || '').trim();
    if (!sessionSecret || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
        || !sender || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sender)) {
      throw httpError(503, 'La confirmation par e-mail est indisponible. Aucun transfert n’a été exécuté.');
    }
    if (typeof db.transaction !== 'function') {
      throw httpError(503, 'La confirmation par e-mail est indisponible. Aucun transfert n’a été exécuté.');
    }
    const userId = String(user.id);
    const challengeId = crypto.randomUUID();
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + EMAIL_OTP_TTL_MS).toISOString();
    const codeHash = emailOtpHash(sessionSecret, userId, challengeId, code);

    const allowed = await db.transaction(async repo => {
      await repo.lockCollection('withdrawal_email_otp_limits');
      await repo.lockCollection('withdrawal_email_otps');
      const limit = await repo.get('withdrawal_email_otp_limits', userId);
      const started = Date.parse(limit?.window_started_at);
      const sameWindow = Number.isFinite(started) && started + EMAIL_OTP_WINDOW_MS > now;
      if (sameWindow && Number(limit.count || 0) >= EMAIL_OTP_MAX_REQUESTS) return false;
      const nextLimit = {
        id: userId,
        count: sameWindow ? Number(limit.count || 0) + 1 : 1,
        window_started_at: sameWindow ? limit.window_started_at : createdAt,
        expires_at: new Date(now + EMAIL_OTP_WINDOW_MS).toISOString(),
      };
      if (limit) await repo.replace('withdrawal_email_otp_limits', userId, nextLimit);
      else await repo.insert('withdrawal_email_otp_limits', userId, nextLimit);

      const challenge = {
        id: userId,
        user_id: userId,
        challenge_id: challengeId,
        request_fingerprint: requestFingerprint,
        code_hash: codeHash,
        attempts: 0,
        status: 'sending',
        created_at: createdAt,
        expires_at: expiresAt,
      };
      const existing = await repo.get('withdrawal_email_otps', userId);
      if (existing) await repo.replace('withdrawal_email_otps', userId, challenge);
      else await repo.insert('withdrawal_email_otps', userId, challenge);
      return true;
    });
    if (!allowed) throw httpError(429, 'Trop de demandes de code. Réessayez dans quelques minutes.');

    const text = `Votre code de confirmation de transfert Biz-transPay est : ${code}\n`
      + 'Ce code expire dans 10 minutes et ne peut être utilisé qu’une fois. Ne le partagez avec personne.';
    const html = '<div style="font-family:Arial,sans-serif;color:#0f172a">'
      + '<h2>Confirmer votre transfert</h2>'
      + `<p>Code de confirmation : <strong>${code}</strong></p>`
      + '<p>Ce code expire dans 10 minutes et ne peut être utilisé qu’une fois. Ne le partagez avec personne.</p>'
      + '</div>';
    try {
      await sendEmailFn(env, {
        sender, recipient: email,
        subject: 'Code de confirmation de transfert Biz-transPay',
        text, html,
        idempotencyKey: `withdrawal-email-otp-${challengeId}`,
      });
    } catch {
      await db.collection('withdrawal_email_otps').update_one(
        { id: userId, challenge_id: challengeId, status: 'sending' },
        { $set: { status: 'delivery_failed' } },
      );
      throw httpError(503, 'Le code de confirmation n’a pas pu être envoyé. Aucun transfert n’a été exécuté.');
    }
    const activated = await db.collection('withdrawal_email_otps').update_one(
      { id: userId, challenge_id: challengeId, status: 'sending' },
      { $set: { status: 'active', sent_at: new Date().toISOString() } },
    );
    if (activated.matched_count !== 1) {
      throw httpError(503, 'La confirmation par e-mail n’a pas pu être activée. Aucun transfert n’a été exécuté.');
    }
    return {
      withdrawal_otp_required: true,
      challenge_id: challengeId,
      email_hint: maskEmail(email),
      expires_in: Math.floor(EMAIL_OTP_TTL_MS / 1000),
    };
  }

  async function consumeEmailOtp(userId, challengeId, code, requestFingerprint) {
    const collection = db.collection('withdrawal_email_otps');
    const challenge = await collection.find_one({
      id: String(userId), challenge_id: challengeId, status: 'active',
    }, { _id: 0 });
    if (!challenge) throw httpError(400, 'Code invalide ou expiré.');
    if (challenge.request_fingerprint !== requestFingerprint) {
      throw httpError(409, 'Ce code ne correspond pas à ce transfert.');
    }
    const expiresAt = Date.parse(challenge.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      await collection.update_one(
        { id: String(userId), challenge_id: challengeId, status: 'active' },
        { $set: { status: 'expired' } },
      );
      throw httpError(400, 'Code invalide ou expiré.');
    }
    const attempts = Number(challenge.attempts || 0);
    if (attempts >= EMAIL_OTP_MAX_ATTEMPTS) {
      throw httpError(429, 'Trop de tentatives. Demandez un nouveau code.');
    }
    const expected = emailOtpHash(sessionSecret, String(userId), challengeId, String(code || ''));
    if (!timingSafeHexEqual(challenge.code_hash, expected)) {
      const nextAttempts = attempts + 1;
      const update = await collection.update_one({
        id: String(userId), challenge_id: challengeId, status: 'active', attempts,
      }, { $set: {
        attempts: nextAttempts,
        ...(nextAttempts >= EMAIL_OTP_MAX_ATTEMPTS ? { status: 'locked' } : {}),
      } });
      if (update.matched_count !== 1) throw httpError(409, 'Code déjà utilisé. Demandez-en un nouveau.');
      throw httpError(nextAttempts >= EMAIL_OTP_MAX_ATTEMPTS ? 429 : 400,
        nextAttempts >= EMAIL_OTP_MAX_ATTEMPTS
          ? 'Trop de tentatives. Demandez un nouveau code.' : 'Code invalide ou expiré.');
    }
    const consumed = await collection.update_one({
      id: String(userId), challenge_id: challengeId, status: 'active', attempts,
    }, { $set: { status: 'used', used_at: new Date().toISOString() } });
    if (consumed.matched_count !== 1) throw httpError(409, 'Code déjà utilisé. Demandez-en un nouveau.');
  }

  async function handleCancelOtp(req, res) {
    if (!db || !sessionService) {
      reply(res, 503, { detail: 'Service indisponible.', code: 'MIGRATION_INCOMPLETE' });
      return true;
    }
    let auth;
    try {
      auth = await authenticate(req);
    } catch (error) {
      reply(res, error.status || 401, { detail: error.code
        ? { code: error.code, message: error.message } : error.message || 'Session requise' });
      return true;
    }
    try {
      const body = await readJson(req);
      const challengeId = typeof body.challenge_id === 'string' ? body.challenge_id.trim() : '';
      if (!challengeId || challengeId.length > 128) throw httpError(422, 'Identifiant de confirmation invalide');
      await db.collection('withdrawal_email_otps').update_one({
        id: String(auth.userId), challenge_id: challengeId, status: 'active',
      }, { $set: { status: 'cancelled', cancelled_at: new Date().toISOString() } });
      reply(res, 200, { ok: true });
    } catch (error) {
      reply(res, error.status || 400, { detail: error.message || 'Impossible d’annuler la demande.' });
    }
    return true;
  }

  async function handleInternalTransfer(req, res, body, userId) {
    if (body.transfer_type === 'biz_to_bank') {
      throw httpError(410, 'Le transfert bancaire n’est plus disponible sur Biz-transPay.');
    }
    if (body.transfer_type !== 'biz_to_biz') {
      throw httpError(503, 'Ce type de transfert n’est pas encore migré vers Node.js.',
        'MIGRATION_INCOMPLETE');
    }

    const user = await db.collection('users').find_one({ id: String(userId) }, { _id: 0 });
    if (!user || String(user.id) !== String(userId)) throw httpError(404, 'Utilisateur introuvable');
    if (user.kyc_status !== 'verified') throw httpError(403, 'La vérification KYC est requise.');
    if (user.is_banned || user.is_blocked) throw httpError(403, 'Compte suspendu');

    const transferType = String(body.transfer_type || '');
    const recipient = typeof body.recipient === 'string' ? body.recipient.trim() : '';
    const recipientPhone = typeof body.recipient_phone === 'string' ? body.recipient_phone.trim() : '';
    const currency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : '';
    const amount = Number(body.amount);
    const idempotencyKey = typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim().slice(0, 500) : '';

    if (!recipient || recipient.length > 180) throw httpError(422, 'Bénéficiaire invalide');
    if (recipientPhone.length > 40) throw httpError(422, 'Téléphone du bénéficiaire invalide');
    if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, 'Montant invalide');
    if (idempotencyKey.length < 8 || idempotencyKey.length > 120) {
      throw httpError(400, 'Une clé d’idempotence est requise pour ce transfert.');
    }
    if (!currency || currency.length > 32) throw httpError(400, 'Devise de transfert invalide');

    enforceRateLimit(String(userId));
    await verifyBot(body.turnstile_token, req, 'withdrawal', env);
    if (!isAdmin(user)) {
      if (!user.user_pin_hash) {
        throw httpError(428,
          'Activez votre code PIN avant de confirmer un transfert.', 'USER_PIN_SETUP_REQUIRED');
      }
      const validPin = await verifyPinFn(db, user, body.pin || '', 'user_pin', sessionSecret);
      if (!validPin) throw httpError(401, 'Code PIN incorrect. Vérifiez-le avant de confirmer.', 'USER_PIN_INVALID');
    }

    const needle = recipient.toLowerCase();
    const phoneTerm = recipientPhone || needle;
    const recipientUser = await db.collection('users').find_one({
      $or: [
        { username: needle },
        { email: needle },
        ...(phoneTerm ? [{
          phone: { $regex: escapeRegex(phoneTerm), $options: 'i' },
        }] : []),
      ],
    }, { _id: 0 });
    if (!recipientUser) throw httpError(404, 'Bénéficiaire Biz-transPay introuvable');
    if (String(recipientUser.id) === String(userId)) {
      throw httpError(400, 'Impossible de vous transférer à vous-même');
    }

    let walletField = '';
    let cryptoAsset = null;
    if (currency.includes('.')) {
      const features = await getAppFeatures(db);
      if (features.wallet_crypto_enabled === false) {
        throw httpError(400, 'Les portefeuilles crypto sont désactivés');
      }
      const activeAssets = await cryptoCatalog.activeExchangeAssets();
      cryptoAsset = activeAssets.get(currency);
      if (!cryptoAsset?.wallet_field) {
        throw httpError(400, 'Cet actif crypto/réseau n’est pas disponible pour le transfert');
      }
      walletField = cryptoAsset.wallet_field;
    } else if (FIAT_WALLETS.has(currency)) {
      walletField = `balance_${currency.toLowerCase()}`;
    } else {
      throw httpError(400, 'Devise de transfert non prise en charge');
    }

    const operationId = `biz-to-biz:${String(userId)}:${idempotencyKey}`;
    const txOutId = operationIdentity('internal_transfer_transaction', `${operationId}:out`);
    const txInId = operationIdentity('internal_transfer_transaction', `${operationId}:in`);
    const requestFingerprint = fingerprintRequest(String(userId), body);
    const existingOut = await db.collection('transactions').find_one(
      { id: txOutId, user_id: String(userId) }, { _id: 0 },
    );
    if (existingOut) {
      if (existingOut.metadata?.request_fingerprint !== requestFingerprint) {
        throw httpError(409, 'Cette clé d’idempotence est déjà associée à un autre transfert.');
      }
      reply(res, 200, {
        transaction: existingOut,
        fee: 0,
        recipient: {
          username: recipientUser.username,
          full_name: recipientUser.full_name || '',
        },
        idempotent_replay: true,
      });
      return true;
    }

    const emailSettings = await db.collection('settings').find_one(
      { id: 'transaction_email_settings' }, { _id: 0 },
    );
    if (emailSettings?.withdrawal_otp_enabled) {
      const challengeId = typeof body.withdrawal_otp_challenge_id === 'string'
        ? body.withdrawal_otp_challenge_id.trim() : '';
      const code = typeof body.withdrawal_otp_code === 'string'
        ? body.withdrawal_otp_code.trim() : '';
      if (!challengeId && !code) {
        reply(res, 200, await startEmailOtp(user, requestFingerprint, emailSettings.sender_email));
        return true;
      }
      if (!challengeId || !/^\d{6}$/.test(code)) {
        throw httpError(400, 'Code de confirmation invalide.');
      }
      await consumeEmailOtp(String(userId), challengeId, code, requestFingerprint);
    }

    const timestamp = new Date().toISOString();
    const reference = `BTP-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const commonMetadata = {
      transfer_type: transferType,
      transfer_operation_id: operationId,
      wallet_field: walletField,
      catalog_asset_id: cryptoAsset ? currency : null,
      request_fingerprint: requestFingerprint,
    };
    const transactionOut = {
      id: txOutId,
      user_id: String(userId),
      type: 'transfer',
      direction: 'out',
      amount,
      currency,
      status: 'completed',
      counterparty: recipientUser.username,
      reference,
      description,
      created_at: timestamp,
      metadata: {
        ...commonMetadata,
        fee: 0,
        recipient_name: recipientUser.full_name || recipientUser.username,
        operation_id: `${operationId}:out`,
      },
    };
    const transactionIn = {
      id: txInId,
      user_id: String(recipientUser.id),
      type: 'transfer',
      direction: 'in',
      amount,
      currency,
      status: 'completed',
      counterparty: user.username,
      reference,
      description,
      created_at: timestamp,
      metadata: {
        ...commonMetadata,
        operation_id: `${operationId}:in`,
        sender_name: user.full_name || user.username,
      },
    };

    const mutation = await applyInternalTransfer(db, {
      fromUserId: String(userId),
      toUserId: String(recipientUser.id),
      operationId,
      walletField,
      currency,
      amount,
      requestFingerprint,
      transactionOut,
      transactionIn,
    });
    if (mutation.state === 'insufficient') throw httpError(400, 'Solde insuffisant');
    if (mutation.state === 'missing_user') throw httpError(404, 'Utilisateur introuvable');
    if (mutation.state === 'idempotency_conflict') {
      throw httpError(409, 'Cette clé d’idempotence est déjà associée à un autre transfert.');
    }
    if (!['applied', 'already'].includes(mutation.state)) {
      throw httpError(400, 'Transfert invalide');
    }

    const savedOut = await db.collection('transactions').find_one(
      { id: txOutId, user_id: String(userId) }, { _id: 0 },
    );
    if (!savedOut) {
      throw httpError(409, 'Le transfert est enregistré mais son historique doit être réconcilié.');
    }
    if (savedOut.metadata?.request_fingerprint !== requestFingerprint) {
      throw httpError(409, 'Cette clé d’idempotence est déjà associée à un autre transfert.');
    }
    if (mutation.state === 'applied') {
      try {
        await notify(
          String(userId),
          'transfer_success',
          'Transfert Biz-transPay confirmé',
          `Votre transfert de ${amount.toLocaleString('fr-FR')} ${currency} vers `
            + `${recipientUser.full_name || recipientUser.username} est confirmé.`,
          {
            transaction_id: savedOut.id,
            status: 'completed',
            amount,
            currency,
            transfer_type: 'biz_to_biz',
          },
        );
      } catch { /* Wallet and ledger already committed; notification is best effort. */ }
    }
    reply(res, 200, {
      transaction: savedOut,
      fee: 0,
      recipient: {
        username: recipientUser.username,
        full_name: recipientUser.full_name || '',
      },
      idempotent_replay: mutation.state === 'already',
    });
    return true;
  }

  async function handleRoute(req, res) {
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/api/transfer/config') {
      if (!db || !sessionService) {
        reply(res, 503, { detail: 'Service indisponible.', code: 'MIGRATION_INCOMPLETE' });
        return true;
      }
      try {
        await sessionService.authenticate(sessionToken(req));
        const settings = db.collection('settings');
        const [saved, paydunya, mbiyo, afribapay] = await Promise.all([
          settings.find_one({ id: 'transfer_config' }, { _id: 0 }),
          settings.find_one({ id: 'payment_provider_paydunya' }, { _id: 0 }),
          settings.find_one({ id: 'payment_provider_mbiyo' }, { _id: 0 }),
          settings.find_one({ id: 'payment_provider_afribapay' }, { _id: 0 }),
        ]);
        const mm = saved?.mobile_money || {};
        const providerReady = {
          paydunya: configuredProvider(paydunya, env, 'paydunya'),
          mbiyo: configuredProvider(mbiyo, env, 'mbiyo'),
          afribapay: configuredProvider(afribapay, env, 'afribapay'),
        };
        const seen = new Set();
        const operators = (Array.isArray(mm.operators) ? mm.operators : [])
          .filter(operator => {
            const provider = String(operator.provider || 'paydunya').toLowerCase();
            if (!mm.enabled || !providerReady[provider]
                || operator.active === false || operator.archived || operator.hidden
                || !['paydunya', 'mbiyo', 'afribapay'].includes(provider)) return false;
            const identity = [
              String(operator.country || '').toUpperCase(),
              String(operator.code || '').toLowerCase().replace(/^mbiyo_/, ''),
              String(operator.currency || '').toUpperCase(),
            ].join(':');
            if (seen.has(identity)) return false;
            seen.add(identity);
            return true;
          })
          .map(operator => {
            const gatewayPct = Number(operator.gateway_fee_pct || 0);
            const platformPct = Number(operator.platform_fee_pct || 0);
            const gatewayFixed = Number(operator.gateway_fee_fixed || 0);
            const platformFixed = Number(operator.platform_fee_fixed || 0);
            return {
              country: operator.country,
              country_label: operator.country_label || operator.country,
              code: String(operator.public_code || operator.code || '').toLowerCase().replace(/^mbiyo_/, ''),
              name: operator.name || operator.code,
              currency: operator.currency || 'XOF',
              min: Number(operator.min || 0),
              max: Number(operator.max || 0) || null,
              fee_pct: (gatewayPct || platformPct)
                ? gatewayPct + platformPct : Number(operator.fee_pct || 0),
              fee_fixed: (gatewayFixed || platformFixed)
                ? gatewayFixed + platformFixed : Number(operator.fee_fixed || 0),
              active: true,
            };
          });
        reply(res, 200, { mobile_money: { enabled: Boolean(mm.enabled && operators.length), operators } });
      } catch (error) {
        reply(res, error.status || 500, {
          detail: error.code ? { code: error.code, message: error.message }
            : error.status ? error.message : 'Erreur interne.',
        });
      }
      return true;
    }
    if (req.method === 'POST' && path === '/api/transfers/email-otp/cancel') {
      return handleCancelOtp(req, res);
    }
    if (req.method !== 'POST' || path !== '/api/transfers') return false;
    if (!db || !sessionService) {
      reply(res, 503, { detail: 'Service indisponible.', code: 'MIGRATION_INCOMPLETE' });
      return true;
    }

    let authenticated;
    let userId;
    try {
      ({ authenticated, userId } = await authenticate(req));
    } catch (error) {
      reply(res, error.status || 401, {
        detail: error.code ? { code: error.code, message: error.message }
          : error.message || 'Session requise',
      });
      return true;
    }
    void authenticated;

    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      reply(res, error.status || 400, { detail: error.message });
      return true;
    }
    try {
      await handleInternalTransfer(req, res, body, userId);
    } catch (error) {
      reply(res, error.status || 500, {
        detail: error.code ? { code: error.code, message: error.message } : error.message || 'Erreur interne.',
      });
    }
    return true;
  }

  return { handleRoute };
}

module.exports = { createTransferRoutes };
