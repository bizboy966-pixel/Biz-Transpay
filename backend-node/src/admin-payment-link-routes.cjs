'use strict';

const { authorizeAdmin } = require('./admin-authorization.cjs');
const { escapeRegex } = require('./admin-user-routes.cjs');

const LINK_ADMIN_FIELDS = [
  'id', 'user_id', 'slug', 'title', 'amount', 'crypto_amount', 'currency',
  'active', 'created_at', 'amount_type', 'min_amount', 'max_amount',
];

function reply(res, status, body) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function boundedLimit(value) {
  if (value === null || value === '') return 500;
  if (!/^\d+$/.test(value)) return null;
  const limit = Number(value);
  return limit >= 1 && limit <= 2000 ? limit : null;
}

function createAdminPaymentLinkRoutes({ db, sessionService, env = process.env }) {
  async function handleRoute(req, res) {
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); }
    catch { return false; }
    if (req.method !== 'GET' || url.pathname !== '/api/admin/links') return false;

    try {
      await authorizeAdmin(req, {
        db, sessionService, env,
        permission: 'links:read',
        action: 'admin_list_links',
      });
      const limit = boundedLimit(url.searchParams.get('limit'));
      if (limit === null) {
        reply(res, 422, { detail: 'Limite invalide' });
        return true;
      }
      const status = url.searchParams.get('status');
      const query = {};
      if (status === 'active') query.active = true;
      else if (['suspended', 'disabled', 'inactive'].includes(status)) query.active = false;

      const search = String(url.searchParams.get('q') || '').trim();
      if (search.length > 100) {
        reply(res, 422, { detail: 'Recherche trop longue' });
        return true;
      }
      if (search) {
        const regex = { $regex: escapeRegex(search), $options: 'i' };
        const users = await db.collection('users').find({
          $or: [{ email: regex }, { username: regex }, { full_name: regex }],
        }, { _id: 0, id: 1 }).to_list(1000);
        const ownerIds = users.map(user => user.id).filter(Boolean);
        query.$or = [
          ...['id', 'slug', 'title', 'description'].map(field => ({ [field]: regex })),
          ...(ownerIds.length ? [{ user_id: { $in: ownerIds } }] : []),
        ];
      }

      const documents = await db.collection('payment_links')
        .find(query, { _id: 0 })
        .sort('created_at', -1)
        .to_list(limit);
      const ownerIds = [...new Set(documents.map(link => link.user_id).filter(Boolean))];
      const owners = ownerIds.length
        ? await db.collection('users').find(
          { id: { $in: ownerIds } },
          { _id: 0, id: 1, username: 1, full_name: 1, email: 1, account_type: 1 },
        ).to_list(ownerIds.length)
        : [];
      const ownerById = new Map(owners.map(owner => [owner.id, owner]));
      reply(res, 200, documents.map(link => ({
        ...Object.fromEntries(LINK_ADMIN_FIELDS
          .filter(field => Object.hasOwn(link, field))
          .map(field => [field, link[field]])),
        owner: ownerById.get(link.user_id) || {},
      })));
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      reply(res, status, {
        detail: status >= 500 ? 'Erreur interne.' : error.message,
      });
    }
    return true;
  }

  return { handleRoute };
}

module.exports = { createAdminPaymentLinkRoutes };
