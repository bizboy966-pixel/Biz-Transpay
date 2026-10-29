'use strict';

const { sessionToken } = require('./auth-session-routes.cjs');
const { getAppFeatures } = require('./public-config-routes.cjs');

function reply(res, status, body) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function publicCredential(document) {
  if (!document) return null;
  const publicKey = String(document.public_key || '');
  return {
    public_key: publicKey,
    public_key_masked: publicKey ? `${publicKey.slice(0, 8)}…` : '',
    active: Boolean(document.active),
    scopes: Array.isArray(document.scopes) ? document.scopes : [],
    created_at: document.created_at || null,
  };
}

function publicWebhook(document, userId, environment) {
  const webhookId = String(document.id || `${userId}:${environment}`);
  const isDefault = Boolean(document.is_default || webhookId === `${userId}:${environment}`);
  return {
    id: webhookId,
    name: document.name || (isDefault ? 'Site principal' : 'Webhook'),
    url: document.url || '',
    active: Boolean(document.active),
    secret_configured: Boolean(document.secret_encrypted),
    is_default: isDefault,
    created_at: document.created_at || null,
    updated_at: document.updated_at || null,
  };
}

function createIntegrationSettingsRoutes({ db, sessionService }) {
  async function handleRoute(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const isSettings = req.method === 'GET' && url.pathname === '/api/integration/settings';
    const webhookMatch = req.method === 'GET'
      ? /^\/api\/integration\/webhooks\/([^/]+)(\/deliveries)?$/.exec(url.pathname)
      : null;
    if (!isSettings && !webhookMatch) return false;
    try {
      const environment = isSettings
        ? String(url.searchParams.get('environment') || '').trim().toLowerCase()
        : String(webhookMatch[1]).trim().toLowerCase();
      if (!['test', 'live'].includes(environment)) {
        reply(res, 422, { detail: 'Environnement invalide.' });
        return true;
      }
      const identity = await sessionService.authenticate(sessionToken(req));
      const userId = String(identity?.userId || '');
      const user = await db.collection('users').find_one(
        { id: userId }, { _id: 0, account_type: 1 },
      );
      if (!user || user.account_type !== 'merchant') {
        reply(res, 403, { detail: 'API integration is reserved for business accounts' });
        return true;
      }
      const features = await getAppFeatures(db);
      if (features.payment_api_enabled === false) {
        reply(res, 403, {
          detail: {
            code: 'PAYMENT_API_DISABLED',
            message: 'L’API de paiement est temporairement désactivée.',
          },
        });
        return true;
      }
      if (!isSettings) {
        if (webhookMatch[2]) {
          const requestedLimit = url.searchParams.has('limit')
            ? Number(url.searchParams.get('limit')) : 50;
          const webhookId = String(url.searchParams.get('webhook_id') || '').trim();
          if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 200
              || webhookId.length > 160) {
            reply(res, 422, { detail: 'Filtre invalide.' });
            return true;
          }
          const query = { user_id: userId, environment };
          if (webhookId) query.destination_id = webhookId;
          const deliveries = await db.collection('integration_webhook_deliveries')
            .find(query, { _id: 0, payload: 0 })
            .sort('created_at', -1).to_list(requestedLimit);
          reply(res, 200, deliveries);
          return true;
        }
        const webhooks = await db.collection('integration_webhooks')
          .find({ user_id: userId, environment }, { _id: 0 })
          .sort('created_at', 1).to_list(20);
        reply(res, 200, {
          environment,
          webhooks: webhooks.map(document => publicWebhook(document, userId, environment)),
        });
        return true;
      }
      const [credential, webhook] = await Promise.all([
        db.collection('integration_credentials').find_one({
          user_id: userId, environment,
        }, { _id: 0 }),
        db.collection('integration_webhooks').find_one({
          id: `${userId}:${environment}`, user_id: userId, environment,
        }, { _id: 0 }),
      ]);
      reply(res, 200, {
        environment,
        credentials: publicCredential(credential),
        available: environment === 'live',
        message: environment === 'test'
          ? 'Les opérations financières Sandbox sont indisponibles sans environnement de test officiel isolé ; aucun fonds réel ne sera déplacé.'
          : null,
        webhook: webhook ? {
          url: webhook.url || null,
          active: Boolean(webhook.active),
          secret_configured: Boolean(webhook.secret_encrypted),
        } : null,
        warning: 'Secrets are displayed only once when generated.',
      });
      return true;
    } catch (error) {
      reply(res, error.status || 500, {
        detail: error.status ? error.message : 'Configuration API indisponible.',
      });
      return true;
    }
  }
  return { handleRoute };
}

module.exports = { createIntegrationSettingsRoutes };
