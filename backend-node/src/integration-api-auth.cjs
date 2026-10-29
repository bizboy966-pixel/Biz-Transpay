'use strict';

const crypto = require('node:crypto');
const { getAppFeatures } = require('./public-config-routes.cjs');

class IntegrationApiError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail ?? message;
  }
}

function hashIntegrationSecret(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

async function authenticateIntegrationApi({ db, req, now = Date.now }) {
  const features = await getAppFeatures(db);
  if (features.payment_api_enabled === false) {
    throw new IntegrationApiError(403, 'L’API de paiement est temporairement désactivée.', {
      code: 'PAYMENT_API_DISABLED',
      message: 'L’API de paiement est temporairement désactivée.',
    });
  }

  const headers = req.headers || {};
  const authorization = String(headers.authorization || headers.Authorization || '').trim();
  const publicKey = String(headers['x-public-key'] || headers['X-Public-Key'] || '').trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
  const secret = bearer?.[1]?.trim() || '';
  const secretEnvironment = secret.startsWith('sk_test_') ? 'test'
    : secret.startsWith('sk_live_') ? 'live' : '';
  const publicEnvironment = publicKey.startsWith('pk_test_') ? 'test'
    : publicKey.startsWith('pk_live_') ? 'live' : '';
  if (!secret || !publicKey || !secretEnvironment || secretEnvironment !== publicEnvironment
      || secret.length > 256 || publicKey.length > 256) {
    throw new IntegrationApiError(
      401, 'Invalid or mismatched integration credentials',
    );
  }

  const credential = await db.collection('integration_credentials').find_one({
    public_key: publicKey,
    secret_hash: hashIntegrationSecret(secret),
    environment: secretEnvironment,
  }, { _id: 0 });
  if (!credential) throw new IntegrationApiError(401, 'Invalid integration credentials');
  if (!credential.active) throw new IntegrationApiError(403, 'Integration credentials are disabled');

  const user = await db.collection('users').find_one(
    { id: String(credential.user_id || '') },
    { _id: 0, id: 1, account_type: 1, is_banned: 1, is_blocked: 1 },
  );
  if (!user || user.is_banned || user.is_blocked || user.account_type !== 'merchant') {
    throw new IntegrationApiError(403, 'Business account inactive');
  }

  const window = Math.floor(now() / 60_000);
  const limitId = crypto.createHash('sha256')
    .update(`${credential.id}:${window}`, 'utf8').digest('hex');
  await db.collection('integration_rate_limits').update_one({ id: limitId }, {
    $set: {
      user_id: credential.user_id,
      credential_id: credential.id,
      window,
      expires_at: new Date((window + 2) * 60_000).toISOString(),
    },
    $inc: { count: 1 },
  }, { upsert: true });
  const limitRecord = await db.collection('integration_rate_limits')
    .find_one({ id: limitId }, { _id: 0 });
  if (Number(limitRecord?.count || 0) > 120) {
    throw new IntegrationApiError(429, 'Integration API rate limit exceeded');
  }

  await db.collection('integration_credentials').update_one(
    { id: credential.id, user_id: credential.user_id },
    { $set: { last_used_at: new Date(now()).toISOString() } },
  );
  return { ...credential, user };
}

module.exports = { IntegrationApiError, authenticateIntegrationApi, hashIntegrationSecret };
