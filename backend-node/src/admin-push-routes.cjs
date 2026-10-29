'use strict';

const { authorizeAdmin } = require('./admin-authorization.cjs');
const { readJson, reply } = require('./auth-login.cjs');
const { escapeRegex } = require('./admin-user-routes.cjs');
const {
  firebaseClientConfig,
  serviceAccountInfo,
} = require('./notifications-push-routes.cjs');

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

function safeClickPath(value) {
  const path = String(value || '/dashboard').trim();
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')
      || /[\u0000-\u001f]/.test(path)) {
    throw httpError(422, 'Le lien de notification doit être un chemin interne.');
  }
  let parsed;
  try { parsed = new URL(path, 'https://biz-transpay.invalid'); }
  catch { throw httpError(422, 'Le lien de notification doit être un chemin interne.'); }
  if (parsed.origin !== 'https://biz-transpay.invalid') {
    throw httpError(422, 'Le lien de notification doit être un chemin interne.');
  }
  return path;
}

function createAdminPushRoutes({
  db, sessionService, env = process.env, sendPushToUser,
  notify = async () => null, schedule = callback => setImmediate(callback),
}) {
  const runningCampaigns = new Set();

  async function deliverCampaign(campaignId) {
    if (runningCampaigns.has(campaignId)) return;
    runningCampaigns.add(campaignId);
    try {
      const campaignsCollection = db.collection('push_campaigns');
      const campaign = await campaignsCollection.find_one({ id: campaignId }, { _id: 0 });
      if (!campaign || campaign.status !== 'queued') return;
      const claimed = await campaignsCollection.update_one({ id: campaignId, status: 'queued' }, {
        $set: { status: 'sending' },
      });
      if (!claimed?.matched_count) return;
      const audience = campaign.audience || {};
      const query = audienceQuery(audience);
      const users = await db.collection('users').find(query, { _id: 0, id: 1 })
        .to_list(MAX_AUDIENCE_USERS);
      let sent = 0;
      let failed = 0;
      let invalidTokens = 0;
      let processed = 0;
      for (const user of users) {
        const notification = await notify(
          user.id, 'admin_campaign', campaign.title, campaign.body,
          { url: campaign.url, campaign_id: campaignId },
        );
        let outcomes = [];
        try {
          outcomes = typeof sendPushToUser === 'function'
            ? await sendPushToUser(user.id, {
              title: campaign.title,
              body: campaign.body,
              data: {
                url: campaign.url,
                notification_id: notification?.id || '',
                campaign_id: campaignId,
              },
            })
            : [];
        } catch { outcomes = ['failed:DELIVERY']; }
        for (const outcome of Array.isArray(outcomes) ? outcomes : []) {
          processed += 1;
          if (outcome === 'sent') sent += 1;
          else if (outcome === 'invalid') invalidTokens += 1;
          else failed += 1;
        }
      }
      const status = failed === 0 && invalidTokens === 0
        ? 'sent' : (sent > 0 ? 'partial' : 'failed');
      await campaignsCollection.update_one({ id: campaignId }, {
        $set: {
          status, users: users.length, sent, failed, invalid_tokens: invalidTokens,
          processed, finished_at: new Date().toISOString(), error: null,
        },
      });
    } catch {
      await db.collection('push_campaigns').update_one({ id: campaignId }, {
        $set: {
          status: 'failed',
          finished_at: new Date().toISOString(),
          error: 'DELIVERY_UNAVAILABLE',
        },
      });
    } finally {
      runningCampaigns.delete(campaignId);
    }
  }

  return async function handleAdminPush(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    const options = req.method === 'GET' && path === '/api/admin/push/audience-options';
    const usersRoute = req.method === 'GET' && path === '/api/admin/push/users';
    const preview = req.method === 'POST' && path === '/api/admin/push/preview';
    const sendCampaign = req.method === 'POST' && path === '/api/admin/push/send';
    const campaigns = req.method === 'GET' && path === '/api/admin/push/campaigns';
    if (!options && !usersRoute && !preview && !sendCampaign && !campaigns) return false;
    try {
      const authorization = await authorizeAdmin(req, {
        db, sessionService, env,
        permission: 'notifications:send',
        action: options ? 'read_push_audience_options'
          : usersRoute ? 'search_push_users'
            : sendCampaign ? 'send_push_campaign'
              : preview ? 'preview_push_campaign' : 'read_push_campaigns',
        sensitive: sendCampaign,
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
      if (sendCampaign) {
        if (String(body.confirmation || '').trim().toUpperCase() !== 'CONFIRMER') {
          throw httpError(428, 'Une confirmation explicite est requise. Saisissez CONFIRMER.');
        }
        if (!firebaseClientConfig(env) || !serviceAccountInfo(env)) {
          throw httpError(503, 'La configuration Firebase Web et le compte de service sont requis.');
        }
        const title = String(body.title || '').trim();
        const message = String(body.body || '').trim();
        if (!title || title.length > 120 || !message || message.length > 1000) {
          throw httpError(422, 'Le titre ou le message est invalide.');
        }
        const campaignId = String(body.request_id || '').trim();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(campaignId)) {
          throw httpError(422, 'Identifiant de campagne invalide.');
        }
        const clickPath = safeClickPath(body.url);
        const existing = await db.collection('push_campaigns')
          .find_one({ id: campaignId }, { _id: 0 });
        if (existing) {
          if (existing.status === 'queued') {
            schedule(() => deliverCampaign(campaignId).catch(() => {}));
          }
          reply(res, 200, {
            id: existing.id,
            status: existing.status,
            users: existing.users || 0,
            devices: existing.devices || 0,
          });
          return true;
        }
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
        const userIds = users.map(user => String(user.id || '')).filter(Boolean);
        const devices = userIds.length
          ? await db.collection('push_devices').count_documents({
            user_id: { $in: userIds }, active: true,
          })
          : 0;
        if (devices === 0) {
          throw httpError(409, 'Aucun navigateur inscrit aux notifications ne correspond à ce ciblage.');
        }
        if (devices > MAX_CAMPAIGN_DEVICES) {
          throw httpError(413, `Le ciblage dépasse la limite de ${MAX_CAMPAIGN_DEVICES} appareils.`);
        }
        const campaign = {
          id: campaignId,
          source: 'manual',
          admin_user_id: 'unknown',
          title,
          body: message,
          url: clickPath,
          persistent_notification: true,
          audience: {
            audience: String(body.audience || 'all'),
            ...(body.user_id ? { user_id: String(body.user_id) } : {}),
            ...(body.account_type ? { account_type: String(body.account_type) } : {}),
            ...(body.country ? { country: String(body.country).toUpperCase() } : {}),
            ...(body.kyc_status ? { kyc_status: String(body.kyc_status) } : {}),
          },
          status: 'queued',
          users: userCount,
          devices,
          sent: 0,
          failed: 0,
          invalid_tokens: 0,
          processed: 0,
          created_at: new Date().toISOString(),
          finished_at: null,
          error: null,
        };
        const admin = authorization.admin;
        campaign.admin_user_id = admin?.id || null;
        campaign.admin_username = admin?.username || null;
        try {
          await db.collection('push_campaigns').insert_one(campaign);
        } catch {
          const duplicate = await db.collection('push_campaigns')
            .find_one({ id: campaignId }, { _id: 0 });
          if (!duplicate) throw httpError(503, 'Impossible de créer la campagne.');
          reply(res, 200, {
            id: duplicate.id,
            status: duplicate.status,
            users: duplicate.users || 0,
            devices: duplicate.devices || 0,
          });
          return true;
        }
        schedule(() => deliverCampaign(campaignId).catch(() => {}));
        reply(res, 200, { id: campaignId, status: 'queued', users: userCount, devices });
        return true;
      }
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
