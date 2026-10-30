'use strict';

const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { sessionToken } = require('./auth-session-routes.cjs');

const INTERNAL_LINK_OWNER = Symbol('internalLinkOwner');
const INTERNAL_LINK_IDEMPOTENCY = Symbol('internalLinkIdempotency');

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function linkFingerprint(link) {
  const canonical = { ...link };
  for (const key of ['id', 'user_id', 'slug', 'created_at', 'active']) delete canonical[key];
  return crypto.createHash('sha256').update(stableJson(canonical), 'utf8').digest('hex');
}

const MAX_BODY_BYTES = 3 * 1024 * 1024;
const LINK_FIELDS = [
  'title', 'amount', 'crypto_amount', 'currency', 'description', 'expires_at',
  'single_use', 'active', 'amount_type', 'min_amount', 'max_amount',
  'crypto_min_amount', 'crypto_max_amount', 'fee_bearer', 'logo',
];

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function error(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw error(413, 'Requête trop volumineuse');
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw error(400, 'Corps JSON invalide');
  }
}

function numeric(value, label, { optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  const result = Number(value);
  if (!Number.isFinite(result)) throw error(422, `${label} invalide`);
  return result;
}

function validateLogo(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 2_500_000) {
    throw error(422, 'Logo invalide');
  }
  if (value.startsWith('data:')) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match || match[2].length > 2_400_000) throw error(422, 'Logo invalide');
    const bytes = Buffer.from(match[2], 'base64');
    const validMagic = match[1] === 'image/png'
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : match[1] === 'image/jpeg'
        ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : bytes.subarray(0, 4).toString() === 'RIFF'
          && bytes.subarray(8, 12).toString() === 'WEBP';
    if (!validMagic) throw error(422, 'Logo invalide');
    return value;
  }
  let url;
  try { url = new URL(value.trim()); } catch { throw error(422, 'Logo URL invalide'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname
      || url.username || url.password) {
    throw error(422, 'Logo URL invalide');
  }
  return url.toString();
}

function validateLinkAmounts(link) {
  if (!['fixed', 'free'].includes(link.amount_type)) {
    throw error(422, 'Type de montant invalide');
  }
  if (link.amount_type === 'fixed') {
    const amount = numeric(link.amount, 'Montant fixe');
    const cryptoAmount = link.crypto_amount == null
      ? amount : numeric(link.crypto_amount, 'Montant crypto fixe');
    if (amount <= 0) throw error(422, 'Le montant fixe doit être supérieur à zéro');
    if (cryptoAmount <= 0) throw error(422, 'Le montant crypto fixe doit être supérieur à zéro');
    return {
      amount,
      crypto_amount: cryptoAmount,
      min_amount: null,
      max_amount: null,
      crypto_min_amount: null,
      crypto_max_amount: null,
    };
  }
  const minimum = numeric(link.min_amount, 'Montant minimum');
  const maximum = numeric(link.max_amount, 'Montant maximum');
  const cryptoMinimum = link.crypto_min_amount == null
    ? minimum : numeric(link.crypto_min_amount, 'Minimum USDT');
  const cryptoMaximum = link.crypto_max_amount == null
    ? maximum : numeric(link.crypto_max_amount, 'Maximum USDT');
  if (minimum <= 0 || maximum <= minimum) {
    throw error(422, 'Montant maximum doit être supérieur au minimum');
  }
  if (cryptoMinimum <= 0 || cryptoMaximum <= cryptoMinimum) {
    throw error(422, 'Le maximum USDT doit être supérieur au minimum USDT');
  }
  return {
    amount: 0,
    crypto_amount: null,
    min_amount: minimum,
    max_amount: maximum,
    crypto_min_amount: cryptoMinimum,
    crypto_max_amount: cryptoMaximum,
  };
}

function publicLink(document) {
  return {
    slug: document.slug,
    title: document.title,
    amount: document.amount,
    crypto_amount: document.crypto_amount ?? document.amount,
    currency: document.currency,
    description: document.description || '',
    expires_at: document.expires_at ?? null,
    single_use: Boolean(document.single_use),
    active: Boolean(document.active),
    amount_type: document.amount_type || 'fixed',
    min_amount: document.min_amount ?? null,
    max_amount: document.max_amount ?? null,
    crypto_min_amount: document.crypto_min_amount ?? document.min_amount ?? null,
    crypto_max_amount: document.crypto_max_amount ?? document.max_amount ?? null,
    fee_bearer: document.fee_bearer || 'customer',
    logo: document.logo ?? null,
  };
}

function publicLinkPaymentStatus(payment) {
  const result = {};
  for (const key of [
    'id', 'method', 'status', 'amount', 'currency', 'network', 'amount_to_send',
    'deposit_address', 'memo', 'memo_type', 'expires_at', 'created_at',
    'pending_expires_at',
  ]) {
    if (payment[key] !== undefined && payment[key] !== null) result[key] = payment[key];
  }
  if (payment.method === 'mobile_money') {
    result.country = payment.country || '';
    result.operator = {
      code: String(payment.operator || ''),
      label: String(payment.operator_name || ''),
    };
    result.operator_name = String(payment.operator_name || '');
    result.customer_phone = String(payment.customer_phone || '');
  }
  return result;
}

function createPaymentLinkRoutes({ db, sessionService }) {
  async function handlePaymentLinks(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    const list = req.method === 'GET' && path === '/api/links';
    const create = req.method === 'POST' && path === '/api/links';
    const publicMatch = req.method === 'GET' && /^\/api\/links\/public\/([^/]+)$/.exec(path);
    const paymentStatusMatch = req.method === 'GET'
      && /^\/api\/links\/payments\/([^/]+)$/.exec(path);
    const itemMatch = /^\/api\/links\/([^/]+)$/.exec(path);
    const update = req.method === 'PATCH' && itemMatch;
    const remove = req.method === 'DELETE' && itemMatch;
    if (!list && !create && !publicMatch && !paymentStatusMatch && !update && !remove) return false;
    try {
      if (paymentStatusMatch) {
        const paymentId = decodeURIComponent(paymentStatusMatch[1]);
        if (!paymentId || paymentId.length > 160) throw error(404, 'Paiement introuvable');
        const payment = await db.collection('link_payments').find_one(
          { id: paymentId }, { _id: 0 },
        );
        if (!payment) throw error(404, 'Paiement introuvable');
        reply(res, 200, publicLinkPaymentStatus(payment));
        return true;
      }
      if (publicMatch) {
        const slug = decodeURIComponent(publicMatch[1]);
        const document = await db.collection('payment_links').find_one({ slug }, { _id: 0 });
        if (!document) throw error(404, 'Lien introuvable');
        reply(res, 200, publicLink(document));
        return true;
      }
      let userId;
      if (req[INTERNAL_LINK_OWNER]) {
        userId = String(req[INTERNAL_LINK_OWNER]);
      } else {
        const token = sessionToken(req);
        if (!token) throw error(401, 'Session requise');
        const identity = await sessionService.authenticate(token);
        userId = String(identity.userId);
      }
      const links = db.collection('payment_links');
      if (list) {
        const documents = await links.find({ user_id: userId }, { _id: 0 })
          .sort('created_at', -1).to_list(500);
        reply(res, 200, documents);
        return true;
      }
      if (remove) {
        const id = decodeURIComponent(itemMatch[1]);
        const result = await links.delete_one({ id, user_id: userId });
        if (!result.deleted_count) throw error(404, 'Lien introuvable');
        reply(res, 200, { ok: true });
        return true;
      }
      const body = await readJson(req);
      const supplied = Object.fromEntries(
        Object.entries(body).filter(([key]) => LINK_FIELDS.includes(key)),
      );
      if (create) {
        const title = typeof supplied.title === 'string' ? supplied.title.trim() : '';
        if (!title) throw error(400, 'Le nom du lien est requis');
        if (supplied.description !== undefined
            && (typeof supplied.description !== 'string' || supplied.description.length > 2000)) {
          throw error(422, 'Description invalide');
        }
        if (supplied.single_use !== undefined && typeof supplied.single_use !== 'boolean') {
          throw error(422, 'single_use invalide');
        }
        if (supplied.expires_at !== undefined && supplied.expires_at !== null
            && supplied.expires_at !== ''
            && (typeof supplied.expires_at !== 'string' || Number.isNaN(Date.parse(supplied.expires_at)))) {
          throw error(422, 'Date d’expiration invalide');
        }
        const amountType = supplied.amount_type || 'fixed';
        const amounts = validateLinkAmounts({ ...supplied, amount_type: amountType });
        const currency = String(supplied.currency || 'UNIVERSAL').trim().toUpperCase();
        if (!/^[A-Z0-9_-]{3,16}$/.test(currency)) throw error(422, 'Devise invalide');
        if (supplied.fee_bearer !== undefined
            && !['customer', 'merchant'].includes(supplied.fee_bearer)) {
          throw error(422, 'Prise en charge des frais invalide');
        }
        const idempotencyKey = String(req[INTERNAL_LINK_IDEMPOTENCY] || '');
        const deterministicId = idempotencyKey
          ? `api_link_${crypto.createHash('sha256')
            .update(`${userId}:${idempotencyKey}`, 'utf8').digest('hex')}`
          : null;
        const document = {
          id: deterministicId || crypto.randomUUID(),
          user_id: userId,
          slug: crypto.randomBytes(8).toString('base64url'),
          title,
          ...amounts,
          currency,
          description: supplied.description || '',
          expires_at: supplied.expires_at || null,
          single_use: supplied.single_use === true,
          active: true,
          created_at: new Date().toISOString(),
          amount_type: amountType,
          fee_bearer: supplied.fee_bearer || 'customer',
          logo: validateLogo(supplied.logo),
        };
        if (idempotencyKey) {
          const existing = await links.find_one({
            id: document.id, user_id: userId,
          }, { _id: 0 });
          if (existing) {
            if (linkFingerprint(existing) !== linkFingerprint(document)) {
              throw error(409, 'Cette clé d’idempotence est déjà associée à un autre lien');
            }
            reply(res, 200, existing);
            return true;
          }
        }
        try {
          await links.insert_one(document);
        } catch (cause) {
          if (!idempotencyKey || !['ER_DUP_ENTRY', 11000].includes(cause.code)) throw cause;
          const existing = await links.find_one({ id: document.id, user_id: userId }, { _id: 0 });
          if (!existing || linkFingerprint(existing) !== linkFingerprint(document)) {
            throw error(409, 'Conflit de clé d’idempotence');
          }
          reply(res, 200, existing);
          return true;
        }
        reply(res, 200, document);
        return true;
      }

      const id = decodeURIComponent(itemMatch[1]);
      const current = await links.find_one({ id, user_id: userId }, { _id: 0 });
      if (!current) throw error(404, 'Lien introuvable');
      if (!Object.keys(supplied).length) throw error(400, 'Aucune modification');
      if (Object.hasOwn(supplied, 'title') && typeof supplied.title !== 'string') {
        throw error(422, 'Nom de lien invalide');
      }
      const candidate = { ...current, ...supplied };
      if (!String(candidate.title || '').trim()) throw error(400, 'Le nom du lien est requis');
      const amountType = candidate.amount_type || 'fixed';
      const amounts = validateLinkAmounts({ ...candidate, amount_type: amountType });
      const updates = { ...supplied, ...amounts, title: String(candidate.title).trim() };
      if (Object.hasOwn(supplied, 'currency')) {
        updates.currency = String(supplied.currency || '').trim().toUpperCase();
        if (!/^[A-Z0-9_-]{3,16}$/.test(updates.currency)) throw error(422, 'Devise invalide');
      }
      if (Object.hasOwn(supplied, 'logo')) updates.logo = validateLogo(supplied.logo);
      if (Object.hasOwn(supplied, 'description')) {
        if (typeof supplied.description !== 'string' || supplied.description.length > 2000) {
          throw error(422, 'Description invalide');
        }
      }
      for (const field of ['active', 'single_use']) {
        if (Object.hasOwn(supplied, field) && typeof supplied[field] !== 'boolean') {
          throw error(422, `${field} invalide`);
        }
      }
      if (Object.hasOwn(supplied, 'fee_bearer')
          && !['customer', 'merchant'].includes(supplied.fee_bearer)) {
        throw error(422, 'Prise en charge des frais invalide');
      }
      if (Object.hasOwn(supplied, 'expires_at')
          && supplied.expires_at !== null && supplied.expires_at !== '') {
        if (typeof supplied.expires_at !== 'string' || Number.isNaN(Date.parse(supplied.expires_at))) {
          throw error(422, 'Date d’expiration invalide');
        }
      }
      if (updates.expires_at === '') updates.expires_at = null;
      const result = await links.update_one({ id, user_id: userId }, { $set: updates });
      if (!result.matched_count) throw error(404, 'Lien introuvable');
      const updated = await links.find_one({ id, user_id: userId }, { _id: 0 });
      reply(res, 200, updated);
      return true;
    } catch (cause) {
      const status = Number.isInteger(cause.status) ? cause.status : 500;
      reply(res, status, { detail: status >= 500 ? 'Erreur interne.' : cause.message });
      return true;
    }
  }

  async function handleIntegration(userId, body, idempotencyKey) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = 'POST';
    req.url = '/api/links';
    req.headers = {};
    req[INTERNAL_LINK_OWNER] = String(userId || '');
    req[INTERNAL_LINK_IDEMPOTENCY] = String(idempotencyKey || '');
    const res = {
      status: 500,
      writeHead(status) { this.status = status; },
      end(text) {
        try { this.body = JSON.parse(String(text || '{}')); } catch { this.body = {}; }
      },
    };
    const handled = await handlePaymentLinks(req, res);
    return { handled, status: res.status, body: res.body || {} };
  }

  handlePaymentLinks.handleIntegration = handleIntegration;
  return handlePaymentLinks;
}

module.exports = {
  createPaymentLinkRoutes, publicLink, publicLinkPaymentStatus, validateLinkAmounts,
};
