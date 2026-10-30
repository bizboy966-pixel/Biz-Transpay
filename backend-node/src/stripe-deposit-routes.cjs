'use strict';

const crypto = require('node:crypto');
const { sessionToken } = require('./auth-session-routes.cjs');
const { readJson } = require('./auth-login.cjs');
const { applyWalletOperation } = require('./wallet.cjs');

const MAX_WEBHOOK_BYTES = 256 * 1024;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function stripeError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left), 'hex');
  const b = Buffer.from(String(right), 'hex');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function allowedReturnOrigin(value, env) {
  let target;
  try { target = new URL(String(value || '')); } catch { return null; }
  if (target.protocol !== 'https:' || target.username || target.password) return null;
  const host = target.hostname.toLowerCase();
  const permitted = new Set(['biz-transpay.com', 'www.biz-transpay.com']);
  for (const item of String(env.REPLIT_DOMAINS || '').split(',')) {
    const candidate = item.trim().toLowerCase();
    if (candidate) permitted.add(candidate);
  }
  if (env.REPLIT_DEV_DOMAIN) permitted.add(String(env.REPLIT_DEV_DOMAIN).toLowerCase());
  if (!permitted.has(host) && !host.endsWith('.replit.dev')) return null;
  return target.origin;
}

function createStripeDepositRoutes({
  db, sessionService, env = process.env, fetchImpl = fetch,
}) {
  function apiKey() {
    const key = String(env.STRIPE_API_KEY || env.STRIPE_SECRET_KEY || '').trim();
    if (!key) throw stripeError(503, 'Stripe n’est pas configuré sur ce serveur.');
    return key;
  }

  async function stripeRequest(path, { method = 'GET', body, idempotencyKey } = {}) {
    const headers = { Authorization: `Bearer ${apiKey()}` };
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const response = await fetchImpl(`https://api.stripe.com/v1${path}`, {
      method, headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(12000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw stripeError(response.status === 429 ? 503 : 502,
        'Le prestataire de paiement n’a pas pu traiter la requête.');
    }
    return data;
  }

  async function authenticate(req, { recent = false } = {}) {
    const token = sessionToken(req);
    if (!token) throw stripeError(401, 'Authentification requise.');
    let session;
    try { session = await sessionService.authenticate(token); } catch {
      throw stripeError(401, 'Session invalide ou expirée.');
    }
    const userId = String(session?.userId || session?.user_id || session?.user?.id || '');
    if (!userId) throw stripeError(401, 'Authentification requise.');
    if (recent) {
      if (typeof sessionService.requireRecentAuth !== 'function') {
        throw stripeError(428, 'Réauthentification requise pour cette opération.');
      }
      try { sessionService.requireRecentAuth(session); } catch {
        throw stripeError(428, 'Réauthentification requise pour cette opération.');
      }
    }
    return userId;
  }

  async function settleStripeSession(sessionId) {
    const tx = await db.collection('transactions').find_one(
      { stripe_session_id: sessionId }, { _id: 0 },
    );
    if (!tx) throw stripeError(503, 'La session Stripe attend sa transaction locale.');
    if (tx.payment_status === 'paid' || tx.status === 'completed') return tx;
    const session = await stripeRequest(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
    const localAmount = Number(session.metadata?.amount_local);
    const localCurrency = String(session.metadata?.currency || '').toUpperCase();
    const expectedCents = Math.round(Number(tx.usd_amount) * 100);
    if (session.id !== sessionId
        || session.payment_status !== 'paid'
        || session.status !== 'complete'
        || String(session.metadata?.user_id || '') !== String(tx.user_id)
        || localCurrency !== String(tx.currency).toUpperCase()
        || localAmount !== Number(tx.amount)
        || String(session.currency || '').toLowerCase() !== 'usd'
        || Number(session.amount_total) !== expectedCents) {
      return tx;
    }
    const field = tx.currency === 'XOF' ? 'balance_xof' : 'balance_xaf';
    const operationId = `stripe:deposit:${sessionId}`;
    const settledAt = new Date().toISOString();
    const result = await applyWalletOperation(db, {
      userId: String(tx.user_id),
      operationId,
      direction: 'credit',
      primaryField: field,
      increments: { [field]: Number(tx.amount) },
      ledger: {
        id: `stripe-ledger:${sessionId}`,
        user_id: String(tx.user_id),
        type: 'deposit',
        direction: 'in',
        amount: Number(tx.amount),
        currency: String(tx.currency).toUpperCase(),
        status: 'completed',
        reference: tx.reference,
        description: 'Dépôt Stripe',
        created_at: tx.created_at || settledAt,
        completed_at: settledAt,
        metadata: {
          stripe_session_id: sessionId,
          payment_intent: session.payment_intent || null,
          operation_id: operationId,
          wallet_operation_id: operationId,
        },
      },
    });
    if (!['applied', 'already'].includes(result.state)) {
      throw stripeError(503, 'Paiement confirmé; crédit en cours de réconciliation.');
    }
    await db.collection('transactions').update_one(
      { id: tx.id },
      { $set: {
        status: 'completed',
        payment_status: 'paid',
        completed_at: settledAt,
        updated_at: settledAt,
        credit_operation_id: operationId,
        stripe_payment_intent: session.payment_intent || null,
        wallet_snapshot: result.snapshot,
        balance_before: result.snapshot?.balance_before,
        balance_after: result.snapshot?.balance_after,
      } },
    );
    return db.collection('transactions').find_one({ id: tx.id }, { _id: 0 });
  }

  async function handleRoute(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const checkoutPath = req.method === 'POST' && url.pathname === '/api/deposits/checkout';
    const webhookPath = req.method === 'POST' && url.pathname === '/api/webhook/stripe';
    const statusMatch = req.method === 'GET'
      ? /^\/api\/payments\/status\/([^/]+)$/.exec(url.pathname) : null;
    if (!checkoutPath && !webhookPath && !statusMatch) return false;

    try {
      if (checkoutPath) {
        const userId = await authenticate(req, { recent: true });
        const body = await readJson(req, 16 * 1024);
        const amount = Number(body.amount);
        const currency = String(body.currency || '').toUpperCase();
        if (!Number.isInteger(amount) || amount < 300 || !['XOF', 'XAF'].includes(currency)) {
          send(res, 422, { detail: 'Montant minimum : 300 XOF/XAF.' });
          return true;
        }
        const origin = allowedReturnOrigin(body.origin_url, env);
        if (!origin) {
          send(res, 400, { detail: 'URL de retour non autorisée.' });
          return true;
        }
        const suppliedKey = String(body.idempotency_key || '').trim();
        if (suppliedKey && !/^[A-Za-z0-9._:-]{8,128}$/.test(suppliedKey)) {
          send(res, 422, { detail: 'Clé d’idempotence invalide.' });
          return true;
        }
        const key = suppliedKey || crypto.randomUUID();
        const existing = suppliedKey
          ? await db.collection('transactions').find_one({
            user_id: userId,
            provider: 'stripe',
            idempotency_key: key,
          }, { _id: 0 })
          : null;
        if (existing) {
          if (Number(existing.amount) !== amount || existing.currency !== currency) {
            send(res, 409, { detail: 'Cette clé d’idempotence est déjà utilisée.' });
            return true;
          }
          send(res, 200, {
            checkout_url: existing.checkout_url,
            session_id: existing.stripe_session_id,
          });
          return true;
        }
        const usdAmount = Math.round((amount / 600) * 100) / 100;
        if (usdAmount < 0.5) {
          send(res, 422, { detail: 'Montant minimum de dépôt : 300 XOF/XAF.' });
          return true;
        }
        const form = new URLSearchParams({
          mode: 'payment',
          success_url: `${origin}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${origin}/payment/cancel`,
          'line_items[0][quantity]': '1',
          'line_items[0][price_data][currency]': 'usd',
          'line_items[0][price_data][unit_amount]': String(Math.round(usdAmount * 100)),
          'line_items[0][price_data][product_data][name]': `Dépôt Biz-transPay ${currency}`,
          'metadata[user_id]': userId,
          'metadata[currency]': currency,
          'metadata[amount_local]': String(amount),
        });
        const idemDigest = crypto.createHash('sha256')
          .update(`${userId}:${key}`).digest('hex');
        const session = await stripeRequest('/checkout/sessions', {
          method: 'POST',
          body: form.toString(),
          idempotencyKey: `biztranspay-deposit-${idemDigest}`,
        });
        if (!/^cs_(test|live)_/.test(String(session.id || ''))
            || !/^https:\/\/checkout\.stripe\.com\//.test(String(session.url || ''))) {
          throw stripeError(502, 'Réponse Stripe invalide.');
        }
        const createdAt = new Date().toISOString();
        const tx = {
          id: String(session.id),
          user_id: userId,
          type: 'deposit',
          direction: 'in',
          provider: 'stripe',
          stripe_session_id: String(session.id),
          idempotency_key: suppliedKey || null,
          reference: `BTP-STRIPE-${crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`,
          amount,
          currency,
          usd_amount: usdAmount,
          checkout_url: session.url,
          status: 'pending',
          payment_status: 'pending',
          created_at: createdAt,
          updated_at: createdAt,
          metadata: { stripe_session_id: String(session.id) },
        };
        try {
          await db.collection('transactions').insert_one(tx);
        } catch {
          const winner = await db.collection('transactions').find_one(
            { stripe_session_id: String(session.id), user_id: userId }, { _id: 0 },
          );
          if (!winner) throw stripeError(503, 'Impossible d’enregistrer la session Stripe.');
          send(res, 200, {
            checkout_url: winner.checkout_url,
            session_id: winner.stripe_session_id,
          });
          return true;
        }
        send(res, 200, { checkout_url: session.url, session_id: session.id });
        return true;
      }

      if (statusMatch) {
        const userId = await authenticate(req);
        const sessionId = decodeURIComponent(statusMatch[1]);
        let tx = await db.collection('transactions').find_one({
          stripe_session_id: sessionId,
          user_id: userId,
          provider: 'stripe',
        }, { _id: 0 });
        if (!tx) {
          send(res, 404, { detail: 'Transaction introuvable.' });
          return true;
        }
        if (tx.payment_status !== 'paid') {
          try { tx = await settleStripeSession(sessionId); } catch (error) {
            if (error.status !== 503) throw error;
          }
        }
        send(res, 200, {
          session_id: sessionId,
          status: tx.status,
          payment_status: tx.payment_status,
          amount: tx.amount,
          currency: tx.currency,
          reference: tx.reference,
        });
        return true;
      }

      const secret = String(env.STRIPE_WEBHOOK_SECRET || '').trim();
      if (!secret) {
        send(res, 503, { detail: 'Webhook Stripe non configuré.' });
        return true;
      }
      const signatureHeader = req.headers?.['stripe-signature'];
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += part.length;
        if (size > MAX_WEBHOOK_BYTES) {
          send(res, 413, { detail: 'Webhook trop volumineux.' });
          return true;
        }
        chunks.push(part);
      }
      const raw = Buffer.concat(chunks);
      const signatureParts = String(Array.isArray(signatureHeader)
        ? signatureHeader[0] : signatureHeader || '')
        .split(',').map(part => part.trim().split('=', 2));
      const timestamp = Number(signatureParts.find(([key]) => key === 't')?.[1]);
      const signatures = signatureParts.filter(([key]) => key === 'v1').map(([, value]) => value);
      if (!Number.isInteger(timestamp)
          || Math.abs(Date.now() / 1000 - timestamp) > 300
          || !signatures.some(signature => secureEqual(
            hmac(secret, Buffer.concat([Buffer.from(`${timestamp}.`), raw])),
            signature,
          ))) {
        send(res, 400, { detail: 'Signature Stripe invalide.' });
        return true;
      }
      let event;
      try { event = JSON.parse(raw.toString('utf8')); } catch {
        send(res, 400, { detail: 'Webhook Stripe invalide.' });
        return true;
      }
      if (event.type === 'checkout.session.completed'
          || event.type === 'checkout.session.async_payment_succeeded') {
        const sessionId = String(event.data?.object?.id || '');
        if (!/^cs_(test|live)_/.test(sessionId)) {
          send(res, 400, { detail: 'Session Stripe invalide.' });
          return true;
        }
        await settleStripeSession(sessionId);
      }
      send(res, 200, { received: true });
      return true;
    } catch (error) {
      send(res, Number.isInteger(error.status) ? error.status : 500, {
        detail: error.message || 'Erreur Stripe.',
      });
      return true;
    }
  }

  return { handleRoute };
}

module.exports = { createStripeDepositRoutes };
