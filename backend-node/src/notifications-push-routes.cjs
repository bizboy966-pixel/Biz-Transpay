'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { URL } = require('node:url');
const { sessionToken } = require('./auth-session-routes.cjs');
const { readJson, reply } = require('./auth-login.cjs');

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const NOTIFICATION_TITLES = {
  deposit_success: 'Dépôt Biz-transPay confirmé',
  withdrawal_pending: 'Retrait Biz-transPay en cours',
  withdrawal_success: 'Retrait Biz-transPay confirmé',
  withdrawal_failed: 'Retrait Biz-transPay échoué',
  withdrawal_manual_review: 'Retrait Biz-transPay en attente',
  exchange_success: 'Échange Biz-transPay confirmé',
  transfer_success: 'Transfert Biz-transPay confirmé',
  payment_success: 'Paiement Biz-transPay confirmé',
  kyc_verified: 'Vérification Biz-transPay confirmée',
  kyc_rejected: 'Vérification Biz-transPay refusée',
  kyc_resubmit_requested: 'Documents Biz-transPay à compléter',
};
const AUTO_PUSH = {
  deposit_success: ['Dépôt validé', 'Votre dépôt a été validé.'],
  withdrawal_success: ['Retrait validé', 'Votre retrait a été validé.'],
  withdrawal_pending: ['Retrait en cours', 'Votre demande de retrait est en cours de traitement.'],
  withdrawal_failed: ['Retrait non abouti', 'Votre demande de retrait n’a pas abouti. Consultez votre espace.'],
  withdrawal_manual_review: ['Retrait en vérification', 'Votre demande de retrait est en cours de vérification.'],
  transfer_success: ['Transfert effectué', 'Votre transfert a été effectué.'],
  payment_success: ['Paiement reçu', 'Un paiement a été reçu sur votre compte.'],
  exchange_success: ['Échange validé', 'Votre échange a été effectué.'],
};
const MAX_NOTIFICATION_LIMIT = 200;

function routeError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function serviceAccountInfo(env) {
  const raw = String(env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) return null;
  try {
    const info = JSON.parse(raw);
    return info && typeof info === 'object' && !Array.isArray(info)
      && info.project_id && info.client_email && info.private_key
      ? info : null;
  } catch { return null; }
}

function firebaseClientConfig(env) {
  const serviceAccount = serviceAccountInfo(env);
  const projectId = String(env.FIREBASE_PROJECT_ID || '').trim()
    || String(serviceAccount?.project_id || '').trim();
  const config = {
    apiKey: String(env.FIREBASE_WEB_API_KEY || '').trim(),
    authDomain: String(env.FIREBASE_AUTH_DOMAIN || '').trim()
      || (projectId ? `${projectId}.firebaseapp.com` : ''),
    projectId,
    messagingSenderId: String(env.FIREBASE_MESSAGING_SENDER_ID || '').trim(),
    appId: String(env.FIREBASE_APP_ID || '').trim(),
    vapidKey: String(env.FIREBASE_VAPID_KEY || '').trim(),
  };
  return Object.values(config).every(Boolean) ? config : null;
}

function missingFirebaseClientConfig(env) {
  const missing = [];
  if (!String(env.FIREBASE_WEB_API_KEY || '').trim()) missing.push('FIREBASE_WEB_API_KEY');
  if (!String(env.FIREBASE_PROJECT_ID || '').trim() && !serviceAccountInfo(env)?.project_id) {
    missing.push('FIREBASE_PROJECT_ID or service-account project_id');
  }
  for (const [field, variable] of [
    ['messagingSenderId', 'FIREBASE_MESSAGING_SENDER_ID'],
    ['appId', 'FIREBASE_APP_ID'],
    ['vapidKey', 'FIREBASE_VAPID_KEY'],
  ]) {
    if (!String(env[variable] || '').trim()) missing.push(variable);
  }
  return missing;
}

function firebaseServerStatus(env) {
  const info = serviceAccountInfo(env);
  if (!info) {
    return { configured: false, missing: ['FIREBASE_SERVICE_ACCOUNT_JSON'] };
  }
  try {
    const privateKey = crypto.createPrivateKey(
      String(info.private_key).replace(/\\n/g, '\n'),
    );
    if (privateKey.asymmetricKeyType !== 'rsa') throw new Error('Unsupported key type');
  } catch {
    return {
      configured: false,
      missing: ['FIREBASE_SERVICE_ACCOUNT_JSON (private_key invalide)'],
    };
  }
  const configuredProject = String(env.FIREBASE_PROJECT_ID || '').trim();
  if (configuredProject && configuredProject !== info.project_id) {
    return {
      configured: false,
      missing: ['FIREBASE_PROJECT_ID (doit correspondre au project_id du compte de service)'],
    };
  }
  return { configured: true, missing: [] };
}

function safeFcmError(responseBody, httpStatus) {
  const error = responseBody?.error || {};
  const status = String(error.status || '').toUpperCase();
  let fcmCode = '';
  let tokenFieldError = false;
  if (Array.isArray(error.details)) {
    for (const detail of error.details) {
      if (String(detail?.['@type'] || '').includes('FcmError') && detail.errorCode) {
        fcmCode = String(detail.errorCode).toUpperCase();
      }
      if (String(detail?.['@type'] || '').includes('BadRequest')
          && Array.isArray(detail.fieldViolations)
          && detail.fieldViolations.some(item => /message\.token/i.test(String(item.field || '')))) {
        tokenFieldError = true;
      }
    }
  }
  const code = fcmCode || status || `HTTP_${httpStatus}`;
  const sanitized = code.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 48) || `HTTP_${httpStatus}`;
  return {
    code,
    sanitized,
    permanentlyInvalid: ['UNREGISTERED', 'SENDER_ID_MISMATCH'].includes(code)
      || (code === 'INVALID_ARGUMENT' && tokenFieldError),
  };
}

function createNotificationsPushRoutes({
  db, sessionService, env = process.env, fetchImpl = globalThis.fetch,
} = {}) {
  const subscribers = new Map();
  let cachedBearer = null;
  let bearerExpiresAt = 0;

  async function firebaseAccessToken() {
    const info = serviceAccountInfo(env);
    if (!info) throw new Error('FCM_NOT_CONFIGURED');
    const configuredProject = String(env.FIREBASE_PROJECT_ID || '').trim();
    if (configuredProject && configuredProject !== info.project_id) {
      throw new Error('FCM_PROJECT_MISMATCH');
    }
    if (cachedBearer && bearerExpiresAt > Date.now() + 60_000) return cachedBearer;
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign({
      iss: info.client_email,
      scope: FCM_SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }, String(info.private_key).replace(/\\n/g, '\n'), { algorithm: 'RS256' });
    const response = await fetchImpl(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(15000),
    });
    let body = {};
    try { body = await response.json(); } catch { /* sanitized below */ }
    if (!response.ok || typeof body.access_token !== 'string' || !body.access_token) {
      throw new Error('FCM_TOKEN_EXCHANGE_FAILED');
    }
    cachedBearer = body.access_token;
    bearerExpiresAt = Date.now() + Math.max(60, Number(body.expires_in) || 3600) * 1000;
    return cachedBearer;
  }

  function publish(userId, document) {
    for (const client of [...(subscribers.get(String(userId)) || [])]) {
      try {
        if (!client.res.write(`event: notification\ndata: ${JSON.stringify(document)}\n\n`)) {
          // Node will resume writes on drain; keep the authenticated stream open.
        }
      } catch {
        client.close();
      }
    }
  }

  async function sendOneFcm(projectId, bearer, device, push) {
    const endpoint = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;
    const payload = {
      message: {
        token: device.token,
        notification: { title: push.title, body: push.body },
        data: Object.fromEntries(Object.entries(push.data || {})
          .filter(([, value]) => value !== undefined && value !== null)
          .map(([key, value]) => [key, String(value)])),
      },
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bearer}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
          continue;
        }
        return 'failed:NETWORK';
      }
      if (response.status === 200) return 'sent';
      let body = {};
      try { body = await response.json(); } catch { /* keep errors sanitized */ }
      const error = safeFcmError(body, response.status);
      if (error.permanentlyInvalid) {
        const id = crypto.createHash('sha256').update(device.token).digest('hex');
        await db.collection('push_devices').delete_many({
          id, user_id: device.user_id,
        });
        return 'invalid';
      }
      if ([401, 403].includes(response.status)) return 'failed:FIREBASE_CREDENTIALS';
      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      return `failed:${error.sanitized}`;
    }
    return 'failed:UNKNOWN';
  }

  async function sendPushToUser(userId, push) {
    const account = serviceAccountInfo(env);
    if (!account || !firebaseClientConfig(env) || !db || !fetchImpl) return [];
    const configuredProject = String(env.FIREBASE_PROJECT_ID || '').trim();
    if (configuredProject && configuredProject !== account.project_id) return [];
    const devices = await db.collection('push_devices').find({
      user_id: String(userId), active: true,
    }, { _id: 0, id: 1, user_id: 1, token: 1 }).to_list(1000);
    if (!devices.length) return [];
    const bearer = await firebaseAccessToken();
    return Promise.all(devices.map(device => sendOneFcm(account.project_id, bearer, device, push)));
  }

  async function notify(userId, type, title, body, data = {}, options = {}) {
    const normalizedTitle = String(NOTIFICATION_TITLES[type] || title || '').trim();
    const document = {
      id: crypto.randomUUID(),
      user_id: String(userId),
      type: String(type || 'notification'),
      title: ['notification', 'biztranspay notification'].includes(normalizedTitle.toLowerCase())
        ? 'Biz-transPay' : (normalizedTitle || 'Biz-transPay'),
      body: String(body || ''),
      data: data && typeof data === 'object' && !Array.isArray(data) ? data : {},
      read: false,
      created_at: new Date().toISOString(),
    };
    if (options.requiresConfirmation === true) document.requires_confirmation = true;
    try { await db.collection('notifications').insert_one(document); }
    catch { /* notification delivery never blocks a financial or authentication flow */ }
    publish(userId, document);
    const pushMessage = AUTO_PUSH[type];
    if (pushMessage) {
      setImmediate(() => {
        sendPushToUser(userId, {
          title: pushMessage[0],
          body: pushMessage[1],
          data: { url: '/dashboard/transactions', notification_id: document.id, type },
        }).catch(() => {});
      });
    }
    return document;
  }

  async function authenticate(req, res) {
    if (!db || !sessionService) {
      reply(res, 503, { detail: 'Notifications indisponibles.', code: 'MIGRATION_INCOMPLETE' });
      return null;
    }
    const token = sessionToken(req);
    if (!token) {
      reply(res, 401, { detail: { code: 'SESSION_REQUIRED', message: 'Session requise' } });
      return null;
    }
    const identity = await sessionService.authenticate(token);
    return String(identity.userId);
  }

  async function handleRoute(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const deviceRoute = path === '/api/push/devices';
    const configRoute = path === '/api/push/config' && req.method === 'GET';
    const notificationRoot = path === '/api/notifications';
    const unreadCountRoute = path === '/api/notifications/unread-count' && req.method === 'GET';
    const pendingRoute = path === '/api/notifications/pending-confirmation' && req.method === 'GET';
    const readAllRoute = path === '/api/notifications/read-all' && req.method === 'POST';
    const deleteAllRoute = path === '/api/notifications/all' && req.method === 'DELETE';
    const streamRoute = path === '/api/notifications/stream' && req.method === 'GET';
    const readMatch = /^\/api\/notifications\/([^/]+)\/read$/.exec(path);
    if (!(deviceRoute || configRoute || notificationRoot || unreadCountRoute || pendingRoute
        || readAllRoute || deleteAllRoute || streamRoute || readMatch)) return false;
    if (deviceRoute && !['POST', 'DELETE'].includes(req.method)) return false;
    if (notificationRoot && req.method !== 'GET') return false;
    try {
      const userId = await authenticate(req, res);
      if (!userId) return true;
      if (configRoute) {
        const config = firebaseClientConfig(env);
        const serverStatus = firebaseServerStatus(env);
        reply(res, 200, {
          configured: Boolean(config),
          config,
          server_configured: serverStatus.configured,
          missing: config ? [] : missingFirebaseClientConfig(env),
          server_missing: serverStatus.missing,
        });
        return true;
      }
      if (deviceRoute) {
        const body = await readJson(req);
        if (typeof body.token !== 'string' || body.token.length < 20 || body.token.length > 4096) {
          reply(res, 422, { detail: 'Jeton push invalide.' });
          return true;
        }
        const serviceConfigured = firebaseServerStatus(env).configured;
        if (req.method === 'POST') {
          if (!firebaseClientConfig(env) || !serviceConfigured) {
            reply(res, 503, { detail: 'Les notifications push ne sont pas configurées.' });
            return true;
          }
          const id = crypto.createHash('sha256').update(body.token).digest('hex');
          const now = new Date().toISOString();
          await db.collection('push_devices').update_one({ id }, { $set: {
            id, user_id: userId, token: body.token, active: true,
            created_at: now, updated_at: now,
          } }, { upsert: true });
          reply(res, 200, { ok: true });
          return true;
        }
        const id = crypto.createHash('sha256').update(body.token).digest('hex');
        const result = await db.collection('push_devices').delete_many({ id, user_id: userId });
        reply(res, 200, { ok: true, deleted: result.deleted_count });
        return true;
      }
      if (streamRoute) {
        const clients = subscribers.get(userId) || new Set();
        const client = { res, timer: null, close: null };
        client.close = () => {
          clearInterval(client.timer);
          clients.delete(client);
          if (!clients.size) subscribers.delete(userId);
          if (!res.writableEnded && !res.destroyed) res.end();
        };
        clients.add(client);
        subscribers.set(userId, clients);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        client.timer = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) {
            try { res.write(': ping\n\n'); } catch { client.close(); }
          }
        }, 25000);
        client.timer.unref?.();
        res.on('close', client.close);
        req.on('aborted', client.close);
        return true;
      }
      if (configRoute) return true;
      if (notificationRoot) {
        const limit = Number(url.searchParams.get('limit') || 50);
        const unreadOnly = String(url.searchParams.get('unread_only') || '').toLowerCase() === 'true';
        if (!Number.isInteger(limit) || limit < 0 || limit > MAX_NOTIFICATION_LIMIT) {
          reply(res, 422, { detail: 'Limite de notifications invalide.' });
          return true;
        }
        const query = { user_id: userId };
        if (unreadOnly) query.read = false;
        const docs = await db.collection('notifications').find(query, { _id: 0 })
          .sort('created_at', -1).to_list(limit);
        reply(res, 200, docs);
        return true;
      }
      if (pendingRoute) {
        const limit = Number(url.searchParams.get('limit') || 50);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          reply(res, 422, { detail: 'Limite de notifications invalide.' });
          return true;
        }
        const docs = await db.collection('notifications').find({
          user_id: userId, read: false, requires_confirmation: true,
        }, { _id: 0 }).sort('created_at', -1).to_list(limit);
        reply(res, 200, docs);
        return true;
      }
      if (unreadCountRoute) {
        const count = await db.collection('notifications').count_documents({
          user_id: userId, read: false,
        });
        reply(res, 200, { count });
        return true;
      }
      if (readMatch) {
        let id;
        try { id = decodeURIComponent(readMatch[1]); }
        catch {
          reply(res, 400, { detail: 'Identifiant de notification invalide.' });
          return true;
        }
        const result = await db.collection('notifications').update_one({
          id, user_id: userId,
        }, { $set: { read: true } });
        if (!result.matched_count) {
          reply(res, 404, { detail: 'Notification introuvable' });
          return true;
        }
        reply(res, 200, { ok: true });
        return true;
      }
      if (readAllRoute) {
        const result = await db.collection('notifications').update_many({
          user_id: userId,
          read: false,
          requires_confirmation: { $ne: true },
        }, { $set: { read: true } });
        const unreadCount = await db.collection('notifications').count_documents({
          user_id: userId, read: false,
        });
        reply(res, 200, { ok: true, updated: result.modified_count, unread_count: unreadCount });
        return true;
      }
      if (deleteAllRoute) {
        const result = await db.collection('notifications').delete_many({
          user_id: userId,
          $or: [
            { requires_confirmation: { $ne: true } },
            { read: true },
          ],
        });
        const unreadCount = await db.collection('notifications').count_documents({
          user_id: userId, read: false,
        });
        reply(res, 200, { ok: true, deleted: result.deleted_count, unread_count: unreadCount });
        return true;
      }
      return false;
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      reply(res, status, {
        detail: error.code
          ? { code: error.code, message: error.message }
          : status >= 500 ? 'Erreur interne.' : error.message,
      });
      return true;
    }
  }

  return { handleRoute, notify, sendPushToUser };
}

module.exports = {
  createNotificationsPushRoutes,
  firebaseClientConfig,
  firebaseServerStatus,
  missingFirebaseClientConfig,
  serviceAccountInfo,
  safeFcmError,
};
