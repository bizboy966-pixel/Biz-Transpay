'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const { isIP } = require('node:net');
const { sessionToken } = require('./auth-session-routes.cjs');
const { readJson } = require('./auth-login.cjs');
const { getAppFeatures } = require('./public-config-routes.cjs');
const security = require('./security.cjs');

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

function isPublicAddress(value) {
  const address = String(value || '').split('%')[0].toLowerCase();
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && (b === 0 || b === 168)
          || (a === 192 && b === 0 && c === 2)
          || (a === 192 && b === 88 && c === 99)
          || (a === 198 && (b === 18 || b === 19))
          || (a === 198 && b === 51 && c === 100)
          || (a === 203 && b === 0 && c === 113))) return false;
    return true;
  }
  if (family !== 6 || address === '::' || address === '::1'
      || address.startsWith('::ffff:')
      || /^(fc|fd|fe[89ab]|ff)/.test(address)) return false;
  const [left, right = ''] = address.split('::');
  const leftParts = left ? left.split(':') : [];
  const rightParts = right ? right.split(':') : [];
  const groups = [...leftParts, ...Array(Math.max(0, 8 - leftParts.length - rightParts.length)).fill('0'),
    ...rightParts];
  const first = Number.parseInt(groups[0] || '0', 16);
  const second = Number.parseInt(groups[1] || '0', 16);
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2002 || (first === 0x2001
      && [0, 2, 0x0010, 0x0db8].includes(second))) return false;
  return true;
}

async function validateOutboundUrl(value, resolveHostname = dns.lookup) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw Object.assign(new Error('Webhook URL invalide.'), { status: 422 });
  }
  let parsed;
  try { parsed = new URL(value.trim()); } catch {
    throw Object.assign(new Error('Webhook URL invalide.'), { status: 422 });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname
      || parsed.username || parsed.password) {
    throw Object.assign(new Error('Webhook URL invalide.'), { status: 422 });
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname.endsWith('.localhost') || hostname.endsWith('.local')
      || hostname.endsWith('.internal')) {
    throw Object.assign(new Error('Webhook URL doit viser un hôte public.'), { status: 422 });
  }
  let addresses;
  try {
    if (isIP(hostname)) addresses = [{ address: hostname }];
    else {
      const resolved = await resolveHostname(hostname, { all: true, verbatim: true });
      addresses = Array.isArray(resolved) ? resolved : [resolved];
    }
  } catch {
    addresses = [];
  }
  if (!addresses.length || addresses.some(record => !isPublicAddress(record.address))) {
    throw Object.assign(new Error('Webhook URL doit viser un hôte public.'), { status: 422 });
  }
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function createIntegrationSettingsRoutes({
  db, sessionService, env = process.env, resolveHostname = dns.lookup,
  fetchImpl = globalThis.fetch, waitImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  async function deliverTestWebhook(userId, environment, destination, event) {
    const url = await validateOutboundUrl(destination.url, resolveHostname);
    if (!destination.secret_encrypted) {
      throw Object.assign(new Error('Webhook configuration is incomplete.'), { status: 503 });
    }
    const encryptionKey = security.integrationEncryptionKey(
      env.SESSION_SECRET || env.JWT_SECRET,
      env.SECRETS_ENCRYPTION_KEY,
    );
    const secret = security.decryptFernet(destination.secret_encrypted, encryptionKey);
    if (!secret) {
      throw Object.assign(new Error('Webhook secret unavailable.'), { status: 503 });
    }
    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = JSON.stringify(event);
    const signature = `sha256=${crypto.createHmac('sha256', secret)
      .update(`${timestamp}.${payload}`, 'utf8').digest('hex')}`;
    const deliveryId = crypto.randomUUID();
    const now = new Date().toISOString();
    const delivery = {
      id: deliveryId,
      event_id: event.id,
      user_id: userId,
      environment,
      destination_id: destination.id,
      destination_name: destination.name || 'Webhook',
      event_type: event.type,
      url,
      payload: event,
      attempts: 0,
      status: 'pending',
      created_at: now,
    };
    await db.collection('integration_webhook_deliveries').insert_one(delivery);

    let status = 'failed';
    let statusCode = null;
    let error = 'Network error';
    let attempts = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      attempts += 1;
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(8000),
          headers: {
            'Content-Type': 'application/json',
            'X-BizTransPay-Timestamp': timestamp,
            'X-BizTransPay-Signature': signature,
            'X-BizTransPay-Event-Id': event.id,
            'X-BizTransPay-Event-Type': event.type,
          },
          body: payload,
        });
        statusCode = Number(response.status) || null;
        if (statusCode >= 200 && statusCode < 300) {
          status = 'delivered';
          error = null;
          break;
        }
        error = `HTTP ${statusCode || 'error'}`;
      } catch (caught) {
        error = caught?.name === 'TimeoutError' || caught?.name === 'AbortError'
          ? 'timeout' : 'network_error';
      }
      if (attempt < 2) await waitImpl(200 * (attempt + 1));
    }
    await db.collection('integration_webhook_deliveries').update_one(
      { id: deliveryId, user_id: userId, environment },
      { $set: {
        status, status_code: statusCode, error, attempts,
        completed_at: new Date().toISOString(),
      } },
    );
    return {
      id: deliveryId,
      event_id: event.id,
      destination_id: destination.id,
      destination_name: destination.name || 'Webhook',
      status,
      status_code: statusCode,
      error,
    };
  }

  async function handleRoute(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const isSettings = req.method === 'GET' && url.pathname === '/api/integration/settings';
    const createCredential = req.method === 'POST'
      && url.pathname === '/api/integration/credentials';
    const regenerateCredential = req.method === 'POST'
      ? /^\/api\/integration\/credentials\/([^/]+)\/regenerate$/.exec(url.pathname)
      : null;
    const credentialMutation = ['PATCH', 'DELETE'].includes(req.method)
      ? /^\/api\/integration\/credentials\/([^/]+)$/.exec(url.pathname)
      : null;
    const credentialRoute = createCredential || regenerateCredential || credentialMutation;
    const createWebhook = req.method === 'POST'
      ? /^\/api\/integration\/webhooks\/([^/]+)$/.exec(url.pathname) : null;
    const configureDefaultWebhook = req.method === 'PUT'
      ? /^\/api\/integration\/webhooks\/([^/]+)$/.exec(url.pathname) : null;
    const rotateDefaultWebhook = req.method === 'POST'
      ? /^\/api\/integration\/webhooks\/([^/]+)\/regenerate-secret$/.exec(url.pathname) : null;
    const rotateSingleWebhook = req.method === 'POST'
      ? /^\/api\/integration\/webhooks\/([^/]+)\/([^/]+)\/regenerate-secret$/.exec(url.pathname)
      : null;
    const updateWebhook = req.method === 'PATCH'
      ? /^\/api\/integration\/webhooks\/([^/]+)\/([^/]+)$/.exec(url.pathname) : null;
    const deleteWebhook = req.method === 'DELETE'
      ? /^\/api\/integration\/webhooks\/([^/]+)\/([^/]+)$/.exec(url.pathname) : null;
    const testAllWebhooks = req.method === 'POST'
      ? /^\/api\/integration\/webhooks\/([^/]+)\/test$/.exec(url.pathname) : null;
    const testSingleWebhook = req.method === 'POST'
      ? /^\/api\/integration\/webhooks\/([^/]+)\/([^/]+)\/test$/.exec(url.pathname) : null;
    const webhookTest = testAllWebhooks || testSingleWebhook;
    const webhookMutation = createWebhook || configureDefaultWebhook || rotateDefaultWebhook
      || rotateSingleWebhook || updateWebhook || deleteWebhook;
    const webhookBodyRoute = createWebhook || configureDefaultWebhook || updateWebhook;
    const webhookMatch = req.method === 'GET'
      ? /^\/api\/integration\/webhooks\/([^/]+)(\/deliveries)?$/.exec(url.pathname)
      : null;
    if (!isSettings && !webhookMatch && !credentialRoute && !webhookMutation && !webhookTest) return false;
    try {
      const body = createCredential || credentialMutation || webhookBodyRoute
        ? await readJson(req, 16 * 1024) : {};
      const webhookPath = createWebhook || configureDefaultWebhook || rotateDefaultWebhook
        || rotateSingleWebhook || updateWebhook || deleteWebhook;
      const environment = createCredential
        ? String(body.environment || '').trim().toLowerCase()
        : (regenerateCredential || credentialMutation)
          ? String((regenerateCredential || credentialMutation)[1] || '').trim().toLowerCase()
          : webhookMutation
            ? String(webhookPath[1] || '').trim().toLowerCase()
            : testAllWebhooks || testSingleWebhook
              ? String((testAllWebhooks || testSingleWebhook)[1] || '').trim().toLowerCase()
          : isSettings
            ? String(url.searchParams.get('environment') || '').trim().toLowerCase()
            : String(webhookMatch[1]).trim().toLowerCase();
      if (!['test', 'live'].includes(environment)) {
        reply(res, 422, { detail: 'Environnement invalide.' });
        return true;
      }
      if ((credentialRoute || webhookMutation)
          && typeof sessionService.requireRecentAuth !== 'function') {
        reply(res, 503, { detail: 'Réauthentification récente indisponible.' });
        return true;
      }
      const identity = await sessionService.authenticate(sessionToken(req));
      const userId = String(identity?.userId || '');
      if (credentialRoute || webhookMutation) sessionService.requireRecentAuth(identity);
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

      if (webhookTest) {
        let destinations;
        if (testSingleWebhook) {
          const webhookId = decodeURIComponent(testSingleWebhook[2]);
          if (!webhookId || webhookId.length > 160) {
            reply(res, 422, { detail: 'Identifiant de webhook invalide.' });
            return true;
          }
          const destination = await db.collection('integration_webhooks').find_one({
            id: webhookId, user_id: userId, environment, active: true,
          }, { _id: 0 });
          destinations = destination ? [destination] : [];
        } else {
          destinations = await db.collection('integration_webhooks')
            .find({ user_id: userId, environment, active: true }, { _id: 0 })
            .sort('created_at', 1).to_list(20);
        }
        if (!destinations.length) {
          reply(res, 409, { detail: 'Aucun webhook actif à tester.' });
          return true;
        }
        const event = {
          id: crypto.randomUUID(),
          type: 'webhook.test',
          data: { environment, test: true },
          created_at: new Date().toISOString(),
        };
        const results = [];
        for (const destination of destinations) {
          results.push(await deliverTestWebhook(userId, environment, destination, event));
        }
        const failed = results.find(result => result.status !== 'delivered');
        if (failed) {
          reply(res, 502, {
            detail: {
              message: 'Échec de la livraison du webhook de test.',
              delivery_id: failed.id,
            },
          });
          return true;
        }
        reply(res, 200, {
          sent: true,
          event: 'webhook.test',
          delivery_id: results[0].id,
          deliveries: results,
          ...(testSingleWebhook ? { webhook_id: results[0].destination_id } : {}),
        });
        return true;
      }

      if (credentialRoute) {
        const credentials = db.collection('integration_credentials');
        const credentialQuery = { user_id: userId, environment };
        const issueCredentials = async ({ force = false, payoutOptIn } = {}) => {
          const existing = await credentials.find_one(credentialQuery, { _id: 0 });
          if (existing?.active && !force) {
            reply(res, 200, {
              credentials: publicCredential(existing),
              secret_key: null,
              secret_returned_once: false,
            });
            return;
          }
          const optIn = environment === 'live'
            && (payoutOptIn === undefined
              ? Boolean(existing?.payout_opt_in) : Boolean(payoutOptIn));
          const publicKey = `pk_${environment}_${crypto.randomBytes(24).toString('base64url')}`;
          const secretKey = `sk_${environment}_${crypto.randomBytes(32).toString('base64url')}`;
          const scopes = ['deposits:write', 'exchanges:write', 'links:write', 'transactions:read'];
          if (optIn) scopes.push('payouts:write');
          const document = {
            id: `${userId}:${environment}`,
            user_id: userId,
            environment,
            public_key: publicKey,
            secret_hash: crypto.createHash('sha256').update(secretKey, 'utf8').digest('hex'),
            active: true,
            scopes,
            payout_opt_in: optIn,
            created_at: new Date().toISOString(),
          };
          await credentials.replace_one(credentialQuery, document, true);
          reply(res, 200, {
            credentials: publicCredential(document),
            secret_key: secretKey,
            secret_returned_once: true,
          });
        };

        if (createCredential) {
          if (body.payout_opt_in !== undefined && typeof body.payout_opt_in !== 'boolean') {
            reply(res, 422, { detail: 'Option de retrait invalide.' });
            return true;
          }
          await issueCredentials({ payoutOptIn: body.payout_opt_in });
          return true;
        }
        if (regenerateCredential) {
          await issueCredentials({ force: true });
          return true;
        }
        if (req.method === 'PATCH') {
          if (typeof body.active !== 'boolean'
              || (body.payout_opt_in !== undefined && typeof body.payout_opt_in !== 'boolean')) {
            reply(res, 422, { detail: 'Paramètres d’accès invalides.' });
            return true;
          }
          const current = await credentials.find_one(credentialQuery, { _id: 0 });
          if (!current) {
            reply(res, 404, { detail: 'Integration credentials not found' });
            return true;
          }
          const updates = { active: body.active };
          if (body.payout_opt_in !== undefined) {
            const scopes = Array.isArray(current.scopes) ? [...current.scopes] : [];
            const payoutOptIn = environment === 'live' && body.payout_opt_in;
            const nextScopes = payoutOptIn
              ? [...new Set([...scopes, 'payouts:write'])]
              : scopes.filter(scope => scope !== 'payouts:write');
            updates.scopes = nextScopes;
            updates.payout_opt_in = payoutOptIn;
          }
          await credentials.update_one(credentialQuery, { $set: updates });
          reply(res, 200, { environment, active: body.active });
          return true;
        }
        if (body.confirmation !== 'SUPPRIMER') {
          reply(res, 422, { detail: 'Confirmation de suppression invalide.' });
          return true;
        }
        const existing = await credentials.find_one(credentialQuery, { _id: 0 });
        if (!existing) {
          reply(res, 404, { detail: 'Integration credentials not found' });
          return true;
        }
        // Revoke first, so a later cleanup failure cannot leave a usable key.
        await credentials.update_one(credentialQuery, { $set: { active: false } });
        await db.collection('integration_webhooks').delete_many({
          user_id: userId, environment,
        });
        await credentials.delete_one(credentialQuery);
        reply(res, 200, { environment, deleted: true });
        return true;
      }

      if (webhookMutation) {
        const webhooks = db.collection('integration_webhooks');
        const now = new Date().toISOString();
        const baseQuery = { user_id: userId, environment };
        const webhookId = String(
          rotateSingleWebhook?.[2] || updateWebhook?.[2] || deleteWebhook?.[2] || '',
        );
        if (webhookId.length > 160) {
          reply(res, 422, { detail: 'Identifiant de webhook invalide.' });
          return true;
        }
        const withWebhookId = id => ({ ...baseQuery, id });
        const newSecret = () => `whsec_${crypto.randomBytes(32).toString('base64url')}`;
        const encryptSecret = secret => {
          try {
            const encryptionKey = security.integrationEncryptionKey(
              env.SESSION_SECRET || env.JWT_SECRET,
              env.SECRETS_ENCRYPTION_KEY,
            );
            return security.encryptFernet(secret, encryptionKey);
          } catch {
            throw Object.assign(new Error('Configuration de chiffrement indisponible.'), {
              status: 503,
            });
          }
        };

        if (createWebhook) {
          const name = typeof body.name === 'string' ? body.name.trim() : '';
          if (!name || name.length > 80 || typeof body.url !== 'string'
              || body.url.length < 8 || body.url.length > 2048
              || (body.active !== undefined && typeof body.active !== 'boolean')) {
            reply(res, 422, { detail: 'Paramètres de webhook invalides.' });
            return true;
          }
          const existing = await webhooks.find(baseQuery, { _id: 0 })
            .to_list(20);
          if (existing.length >= 20) {
            reply(res, 409, { detail: 'Webhook destination limit reached' });
            return true;
          }
          const secret = newSecret();
          const document = {
            id: `wh_${crypto.randomBytes(18).toString('base64url')}`,
            user_id: userId,
            environment,
            name,
            url: await validateOutboundUrl(body.url, resolveHostname),
            active: body.active ?? true,
            is_default: false,
            secret_encrypted: encryptSecret(secret),
            created_at: now,
            updated_at: now,
          };
          await webhooks.insert_one(document);
          reply(res, 200, {
            environment,
            webhook: publicWebhook(document, userId, environment),
            webhook_secret: secret,
            secret_returned_once: true,
          });
          return true;
        }

        if (configureDefaultWebhook) {
          if (typeof body.url !== 'string' || body.url.length < 8 || body.url.length > 2048
              || (body.active !== undefined && typeof body.active !== 'boolean')) {
            reply(res, 422, { detail: 'Paramètres de webhook invalides.' });
            return true;
          }
          const query = withWebhookId(`${userId}:${environment}`);
          const old = await webhooks.find_one(query, { _id: 0 });
          const newlyGenerated = !old?.secret_encrypted;
          const secret = newlyGenerated ? newSecret() : null;
          const document = {
            id: `${userId}:${environment}`,
            user_id: userId,
            environment,
            name: old?.name || 'Site principal',
            is_default: true,
            url: await validateOutboundUrl(body.url, resolveHostname),
            active: body.active ?? true,
            secret_encrypted: newlyGenerated ? encryptSecret(secret) : old.secret_encrypted,
            created_at: old?.created_at || now,
            updated_at: now,
          };
          await webhooks.replace_one(query, document, true);
          reply(res, 200, {
            environment,
            url: document.url,
            active: document.active,
            webhook_secret: secret,
            secret_returned_once: newlyGenerated,
          });
          return true;
        }

        if (updateWebhook) {
          const query = withWebhookId(webhookId);
          const old = await webhooks.find_one(query, { _id: 0 });
          if (!old) {
            reply(res, 404, { detail: 'Webhook configuration not found' });
            return true;
          }
          const updates = {};
          if (body.name !== undefined && body.name !== null) {
            if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) {
              reply(res, 422, { detail: 'Webhook name cannot be empty' });
              return true;
            }
            updates.name = body.name.trim();
          }
          if (body.url !== undefined && body.url !== null) {
            if (typeof body.url !== 'string' || body.url.length < 8 || body.url.length > 2048) {
              reply(res, 422, { detail: 'Webhook URL invalide.' });
              return true;
            }
            updates.url = await validateOutboundUrl(body.url, resolveHostname);
          }
          if (body.active !== undefined && body.active !== null) {
            if (typeof body.active !== 'boolean') {
              reply(res, 422, { detail: 'État du webhook invalide.' });
              return true;
            }
            updates.active = body.active;
          }
          if (!Object.keys(updates).length) {
            reply(res, 400, { detail: 'Aucune modification' });
            return true;
          }
          updates.updated_at = now;
          await webhooks.update_one(query, { $set: updates });
          reply(res, 200, {
            environment,
            webhook: publicWebhook({ ...old, ...updates }, userId, environment),
          });
          return true;
        }

        if (deleteWebhook) {
          const query = withWebhookId(webhookId);
          const existing = await webhooks.find_one(query, { _id: 0 });
          if (!existing) {
            reply(res, 404, { detail: 'Webhook configuration not found' });
            return true;
          }
          await webhooks.delete_one(query);
          reply(res, 200, { environment, webhook_id: webhookId, deleted: true });
          return true;
        }

        const query = withWebhookId(rotateDefaultWebhook
          ? `${userId}:${environment}` : webhookId);
        const existing = await webhooks.find_one(query, { _id: 0 });
        if (!existing) {
          reply(res, 404, { detail: 'Webhook configuration not found' });
          return true;
        }
        const secret = newSecret();
        await webhooks.update_one(query, {
          $set: { secret_encrypted: encryptSecret(secret), updated_at: now },
        });
        reply(res, 200, {
          environment,
          ...(rotateSingleWebhook ? { webhook_id: webhookId } : {}),
          webhook_secret: secret,
          secret_returned_once: true,
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
