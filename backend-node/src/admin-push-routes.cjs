'use strict';

const { sessionToken } = require('./auth-session-routes.cjs');
const { authorizeAdmin } = require('./admin-authorization.cjs');
const { readJson, reply } = require('./auth-login.cjs');
const { escapeRegex } = require('./admin-user-routes.cjs');

const MAX_AUDIENCE_USERS = 50_000;
const MAX_CAMPAIGN_DEVICES = 20_000;
const ACTIVE_CUSTOMER_QUERY = {
  role: { $nin: ['admin', 'super_admin'] },
  is_blocked: { $ne: true },
  is_banned: { $ne: true },
};
const CAMPAIGN_FIELDS = [
  'id', 'title', 'body', 'audience', 'status', 'users', 'devices',
  'sent', 'failed', 'invalid_tokens', 'processed', 'created_at',
  'finished_at', 'error',
];

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function audienceQuery(body) {
  const audience = String(body.audience || 'all');
  if (!['all', 'group', 'user'].includes(audience)) {
    throw httpError(422, 'Ciblage de notification invalide.');
  }
  const query = structuredClone(ACTIVE_CUSTOMER_QUERY);
  if (audience === 'user') {
    const userId = String(body.user_id || '').trim();
    if (!userId || userId.length > 128) throw httpError(422, 'Utilisateur cible invalide.');
    query.id = userId;
  } else if (audience === 'group') {
    if (body.account_type !== undefined && body.account_type !== null && body.account_type !== '') {
      if (!['personal', 'merchant'].includes(body.account_type)) {
        throw httpError(422, 'Type de compte invalide.');
      }
      query.account_type = body.account_type;
    }
    if (body.country !== undefined && body.country !== null && body.country !== '') {
      const country = String(body.country).trim().toUpperCase();
      if (!/^[A-Z]{2,3}$/.test(country)) throw httpError(422, 'Pays invalide.');
      query.country = country;
    }
    if (body.kyc_status !== undefined && body.kyc_status !== null && body.kyc_status !== '') {
      const status = String(body.kyc_status).trim();
      if (status.length > 50) throw httpError(422, 'Statut KYC invalide.');
      query.kyc_status = status;
    }
  }
  return query;
}

function createAdminPushRoutes({ db, sessionService, env = process.env }) {
  return async function handleAdminPush(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    const options = req.method === 'GET' && path === '/api/admin/push/audience-options';
    const usersRoute = req.method === 'GET' && path === '/api/admin/push/users';
    const preview = req.method === 'POST' && path === '/api/admin/push/preview';
    const campaigns = req.method === 'GET' && path === '/api/admin/push/campaigns';
    if (!options && !usersRoute && !preview && !campaigns) return false;
    try {
      await authorizeAdmin(req, {
        db, sessionService, env,
        permission: 'notifications:send',
        action: options ? 'read_push_audience_options'
          : usersRoute ? 'search_push_users'
            : preview ? 'preview_push_campaign' : 'read_push_campaigns',
      });
      if (options) {
        const users = await db.collection('users').find(ACTIVE_CUSTOMER_QUERY, {
          _id: 0, country: 1, kyc_status: 1,
        }).to_list(MAX_AUDIENCE_USERS);
        reply(res, 200, {
          countries: [...new Set(users.map(user => String(user.country || '').trim().toUpperCase()).filter(Boolean))].sort(),
          account_types: ['personal', 'merchant'],
          kyc_statuses: [...new Set(users.map(user => String(user.kyc_status || '').trim()).filter(Boolean))].sort(),
        });
        return true;
      }
      if (usersRoute) {
        const rawQuery = String(url.searchParams.get('q') || '').trim();
        if (rawQuery.length > 80) throw httpError(422, 'Recherche trop longue.');
        const query = structuredClone(ACTIVE_CUSTOMER_QUERY);
        if (rawQuery) {
          const literal = escapeRegex(rawQuery);
          query.$or = [
            { full_name: { $regex: literal, $options: 'i' } },
            { username: { $regex: literal, $options: 'i' } },
          ];
        }
        const rows = await db.collection('users').find(query, {
          _id: 0, id: 1, full_name: 1, username: 1, account_type: 1, country: 1, kyc_status: 1,
        }).sort('created_at', -1).to_list(40);
        reply(res, 200, { users: rows });
        return true;
      }
      if (campaigns) {
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit == null ? 20 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw httpError(422, 'Limite invalide (1–100).');
        }
        const projection = { _id: 0, ...Object.fromEntries(CAMPAIGN_FIELDS.map(field => [field, 1])) };
        const rows = await db.collection('push_campaigns')
          .find({ source: { $ne: 'automatic' } }, projection)
          .sort('created_at', -1).to_list(limit);
        reply(res, 200, { campaigns: rows });
        return true;
      }

      const body = await readJson(req, 32 * 1024);
      const query = audienceQuery(body);
      const userCount = await db.collection('users').count_documents(query);
      if (userCount > MAX_AUDIENCE_USERS) {
        throw httpError(413, `Le ciblage dépasse la limite de ${MAX_AUDIENCE_USERS} utilisateurs.`);
      }
      const users = await db.collection('users').find(query, { _id: 0, id: 1 })
        .to_list(MAX_AUDIENCE_USERS + 1);
      if (users.length > MAX_AUDIENCE_USERS) {
        throw httpError(413, `Le ciblage dépasse la limite de ${MAX_AUDIENCE_USERS} utilisateurs.`);
      }
      const ids = users.map(user => String(user.id || '')).filter(Boolean);
      const devices = ids.length
        ? await db.collection('push_devices').count_documents({
          user_id: { $in: ids }, active: true,
        })
        : 0;
      if (devices > MAX_CAMPAIGN_DEVICES) {
        throw httpError(413, `Le ciblage dépasse la limite de ${MAX_CAMPAIGN_DEVICES} appareils.`);
      }
      reply(res, 200, { users: userCount, devices });
      return true;
    } catch (cause) {
      const status = Number.isInteger(cause.status) ? cause.status : 500;
      reply(res, status, {
        detail: status >= 500 ? 'Service de notifications indisponible.' : cause.message,
      });
      return true;
    }
  };
}

module.exports = { createAdminPushRoutes, audienceQuery };
