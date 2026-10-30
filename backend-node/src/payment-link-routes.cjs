'use strict';

const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { sessionToken } = require('./auth-session-routes.cjs');
const { selectOperator } = require('./paydunya-invoice-routes.cjs');

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
    'asset_code', 'coin',
    'deposit_address', 'memo', 'memo_type', 'expires_at', 'created_at',
    'pending_expires_at', 'charged_amount', 'amount_to_pay', 'fee',
    'gateway_fee', 'platform_fee', 'instructions', 'payment_flow',
    'otp_required', 'auth_mode', 'submission_unknown', 'challenge_status',
    'amount_net', 'balance_before', 'balance_after', 'provider_reference',
    'redirect_url', 'checkout_url',
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

async function releaseSingleUseClaim(db, payment) {
  if (!payment?.single_use_claim_id || !payment?.link_id) return;
  await db.collection('payment_links').update_one(
    { id: String(payment.link_id), single_use_claim_id: String(payment.single_use_claim_id) },
    { $unset: { single_use_claim_id: '' } },
  );
}

function createPaymentLinkRoutes({
  db, sessionService, createLinkMobileMoneyDeposit, createLinkCryptoPaymentIntent,
  refreshCryptoLinkPayment, verifyBot, settlePaydunyaDepositById,
  finalizeLinkMobileMoney, env = process.env,
}) {
  async function handlePaymentLinks(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    const list = req.method === 'GET' && path === '/api/links';
    const create = req.method === 'POST' && path === '/api/links';
    const publicMatch = req.method === 'GET' && /^\/api\/links\/public\/([^/]+)$/.exec(path);
    const paymentStatusMatch = req.method === 'GET'
      && /^\/api\/links\/payments\/([^/]+)$/.exec(path);
    const finalizeMatch = req.method === 'POST'
      && /^\/api\/links\/payments\/([^/]+)\/(?:mobile-money\/)?finalize$/.exec(path);
    const cryptoStart = req.method === 'POST' && path === '/api/links/pay';
    const mobileMoneyStart = req.method === 'POST' && path === '/api/links/pay/mobile-money';
    const itemMatch = /^\/api\/links\/([^/]+)$/.exec(path);
    const update = req.method === 'PATCH' && itemMatch;
    const remove = req.method === 'DELETE' && itemMatch;
    if (!list && !create && !publicMatch && !paymentStatusMatch && !finalizeMatch
        && !cryptoStart && !mobileMoneyStart && !update && !remove) return false;
    try {
      if (finalizeMatch) {
        const paymentId = decodeURIComponent(finalizeMatch[1]);
        const body = await readJson(req);
        const capability = String(body.finalize_capability || '').trim();
        const otp = String(body.otp || '').trim();
        const payment = await db.collection('link_payments').find_one(
          { id: paymentId, method: 'mobile_money', status: 'pending' }, { _id: 0 },
        );
        if (!payment || typeof finalizeLinkMobileMoney !== 'function') {
          throw error(404, 'Paiement introuvable ou non finalisable.');
        }
        const expected = String(payment.finalize_capability_hash || '');
        const expiresAt = Date.parse(payment.finalize_capability_expires_at || '');
        const suppliedHash = crypto.createHash('sha256').update(capability, 'utf8').digest('hex');
        const validHash = expected.length === suppliedHash.length
          && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(suppliedHash));
        if (capability.length < 20 || capability.length > 128 || !validHash
            || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
          throw error(403, 'Capacité de finalisation invalide ou expirée.');
        }
        if (otp.length < 1 || otp.length > 32) throw error(422, 'Code de confirmation invalide.');
        const claimed = await db.collection('link_payments').update_one(
          {
            id: paymentId, status: 'pending',
            finalize_capability_hash: expected,
            challenge_status: 'required',
          },
          { $set: { challenge_status: 'submitting', finalize_claim_id: crypto.randomUUID() } },
        );
        if (!claimed.matched_count) throw error(409, 'Une confirmation est déjà en cours.');
        const deposit = await db.collection('momo_deposits').find_one(
          { id: String(payment.momo_deposit_id) },
          { _id: 0 },
        );
        if (!deposit || String(deposit.link_payment_id || '') !== paymentId
            || deposit.status !== 'pending') {
          await db.collection('link_payments').update_one(
            { id: paymentId, challenge_status: 'submitting' },
            { $set: { challenge_status: 'required', finalize_claim_id: null } },
          );
          throw error(409, 'Le dépôt n’attend plus de code de confirmation.');
        }
        let finalized;
        try {
          finalized = await finalizeLinkMobileMoney(deposit, otp);
        } catch (cause) {
          const recoverable = Number(cause.status || 500) < 500;
          await db.collection('link_payments').update_one(
            { id: paymentId, challenge_status: 'submitting' },
            { $set: recoverable ? {
              challenge_status: 'required', finalize_claim_id: null,
            } : {
              challenge_status: 'submitted', finalize_capability_hash: null,
              finalize_capability_expires_at: null, finalize_claim_id: null,
            } },
          );
          throw cause;
        }
        const updatedAt = new Date().toISOString();
        const challengeUpdate = {
          auth_mode: null, challenge_status: 'submitted',
          instructions: finalized.instructions || [],
          ...(finalized.provider_reference
            ? { provider_reference: finalized.provider_reference } : {}),
          updated_at: updatedAt,
        };
        await db.collection('momo_deposits').update_one(
          { id: deposit.id, status: 'pending' }, { $set: challengeUpdate },
        );
        await db.collection('link_payments').update_one(
          { id: paymentId, status: 'pending', challenge_status: 'submitting' },
          { $set: {
            ...challengeUpdate, finalize_capability_hash: null,
            finalize_capability_expires_at: null, finalize_claim_id: null,
          } },
        );
        const fresh = await db.collection('link_payments').find_one(
          { id: paymentId }, { _id: 0 },
        );
        reply(res, 200, publicLinkPaymentStatus(fresh || payment));
        return true;
      }
      if (paymentStatusMatch) {
        const paymentId = decodeURIComponent(paymentStatusMatch[1]);
        if (!paymentId || paymentId.length > 160) throw error(404, 'Paiement introuvable');
        let payment = await db.collection('link_payments').find_one(
          { id: paymentId }, { _id: 0 },
        );
        if (!payment) throw error(404, 'Paiement introuvable');
        if (payment.method === 'crypto' && payment.status !== 'paid'
            && typeof refreshCryptoLinkPayment === 'function') {
          await refreshCryptoLinkPayment(paymentId);
          payment = await db.collection('link_payments').find_one(
            { id: paymentId }, { _id: 0 },
          ) || payment;
        }
        if (payment.method === 'mobile_money' && payment.status === 'pending'
            && payment.momo_deposit_id && typeof settlePaydunyaDepositById === 'function') {
          const deposit = await settlePaydunyaDepositById(payment.momo_deposit_id);
          if (deposit?.status === 'approved') {
            await db.collection('link_payments').update_one(
              { id: paymentId, status: 'pending' },
              { $set: {
                status: 'paid',
                amount_net: Number(deposit.wallet_credit_amount ?? deposit.amount_net ?? deposit.amount),
                charged_amount: Number(deposit.charged_amount ?? deposit.amount),
                fee: Number(deposit.total_fee ?? deposit.fee ?? 0),
                gateway_fee: Number(deposit.gateway_fee || 0),
                platform_fee: Number(deposit.platform_fee || 0),
                paid_at: deposit.approved_at || new Date().toISOString(),
                ...(deposit.wallet_snapshot ? {
                  balance_before: deposit.wallet_snapshot.balance_before,
                  balance_after: deposit.wallet_snapshot.balance_after,
                } : {}),
              } },
            );
          } else if (deposit?.status === 'failed') {
            await db.collection('link_payments').update_one(
              { id: paymentId, status: 'pending' },
              { $set: { status: 'failed', failed_at: new Date().toISOString() } },
            );
            await releaseSingleUseClaim(db, payment);
          }
          payment = await db.collection('link_payments').find_one({ id: paymentId }, { _id: 0 });
        }
        reply(res, 200, publicLinkPaymentStatus(payment));
        return true;
      }
      if (cryptoStart) {
        const body = await readJson(req);
        if (typeof createLinkCryptoPaymentIntent !== 'function') {
          throw error(503, 'Le paiement crypto par lien n’est pas disponible.');
        }
        if (typeof verifyBot !== 'function' || !body.turnstile_token) {
          throw error(403, 'La vérification anti-robot est requise.');
        }
        await verifyBot(body.turnstile_token, req, 'payment', env);
        const slug = String(body.slug || '').trim();
        const link = await db.collection('payment_links').find_one({ slug }, { _id: 0 });
        if (!link || link.active === false) throw error(404, 'Lien de paiement indisponible.');
        if (link.expires_at && Date.parse(link.expires_at) <= Date.now()) {
          throw error(410, 'Ce lien de paiement a expiré.');
        }
        if (!['USDT', 'UNIVERSAL'].includes(String(link.currency || '').toUpperCase())) {
          throw error(400, 'Ce lien n’accepte pas les paiements crypto.');
        }
        const assetCode = String(body.asset_code || '').trim().toUpperCase();
        const fullName = String(body.full_name || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const refundAddress = String(body.refund_address || '').trim();
        const key = String(body.idempotency_key || '').trim();
        if (!/^[A-Z0-9._-]{3,32}$/.test(assetCode)
            || fullName.length < 2 || fullName.length > 200
            || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
            || !refundAddress || refundAddress.length > 256
            || !/^[A-Za-z0-9._-]{8,128}$/.test(key)) {
          throw error(422, 'Informations de paiement crypto invalides.');
        }
        const isFree = String(link.amount_type || 'fixed') === 'free';
        const configuredCryptoAmount = Number(link.crypto_amount);
        const fixedCryptoAmount = Number.isFinite(configuredCryptoAmount)
          && configuredCryptoAmount > 0 ? configuredCryptoAmount : link.amount;
        const amount = isFree
          ? numeric(body.amount, 'Montant USDT')
          : numeric(fixedCryptoAmount, 'Montant USDT');
        const minimum = Number(link.crypto_min_amount ?? link.min_amount ?? 0);
        const maximum = Number(link.crypto_max_amount ?? link.max_amount ?? 0);
        if (amount <= 0 || amount > 1e12
            || (isFree && amount < minimum)
            || (isFree && maximum > 0 && amount > maximum)
            || Number(amount.toFixed(6)) !== amount) {
          throw error(422, 'Montant USDT en dehors des limites de ce lien.');
        }
        const fingerprint = crypto.createHash('sha256').update(stableJson({
          method: 'crypto',
          link_id: String(link.id),
          amount,
          asset_code: assetCode,
          full_name: fullName,
          email,
          refund_address: refundAddress,
        }), 'utf8').digest('hex');
        const paymentId = `lp_${crypto.createHash('sha256')
          .update(`crypto:${link.id}:${key}`, 'utf8').digest('hex').slice(0, 32)}`;
        let payment = await db.collection('link_payments').find_one(
          { id: paymentId }, { _id: 0 },
        );
        if (payment && payment.request_fingerprint !== fingerprint) {
          throw error(409, 'Cette clé d’idempotence est déjà utilisée pour un autre paiement.');
        }
        if (payment && (payment.deposit_address
            || ['paid', 'expired', 'failed', 'canceled'].includes(payment.status))) {
          reply(res, 200, publicLinkPaymentStatus(payment));
          return true;
        }
        if (!payment) {
          if (link.single_use) {
            const claim = await db.collection('payment_links').update_one(
              {
                id: String(link.id), active: { $ne: false },
                $or: [
                  { single_use_claim_id: null },
                  { single_use_claim_id: { $exists: false } },
                  { single_use_claim_id: '' },
                ],
              },
              { $set: { single_use_claim_id: paymentId } },
            );
            if (!claim.matched_count) {
              const latestLink = await db.collection('payment_links').find_one(
                { id: String(link.id) }, { _id: 0 },
              );
              if (latestLink?.single_use_claim_id !== paymentId) {
                throw error(409, 'Ce lien à usage unique a déjà été utilisé ou réservé.');
              }
            }
          }
          payment = {
            id: paymentId,
            link_id: String(link.id),
            user_id: String(link.user_id),
            slug: String(link.slug || slug),
            method: 'crypto',
            status: 'creating',
            amount,
            amount_currency: 'USDT',
            currency: 'USDT',
            asset_code: assetCode,
            customer_name: fullName,
            customer_email: email,
            refund_address: refundAddress,
            fee_bearer: link.fee_bearer || 'customer',
            idempotency_key: key,
            request_fingerprint: fingerprint,
            ...(link.single_use ? { single_use_claim_id: paymentId } : {}),
            created_at: new Date().toISOString(),
          };
          try {
            await db.collection('link_payments').insert_one(payment);
          } catch (cause) {
            const concurrent = await db.collection('link_payments').find_one(
              { id: paymentId }, { _id: 0 },
            );
            if (concurrent?.request_fingerprint === fingerprint) {
              payment = concurrent;
            } else {
              if (link.single_use) {
                await db.collection('payment_links').update_one(
                  { id: String(link.id), single_use_claim_id: paymentId },
                  { $unset: { single_use_claim_id: '' } },
                );
              }
              throw cause;
            }
          }
        }
        try {
          await createLinkCryptoPaymentIntent(paymentId);
        } catch (cause) {
          const latest = await db.collection('link_payments').find_one(
            { id: paymentId }, { _id: 0 },
          );
          const definitelyNotSubmitted = !latest?.provider_dispatch_started_at;
          if (definitelyNotSubmitted) {
            await db.collection('link_payments').delete_one({
              id: paymentId,
              provider_dispatch_started_at: { $exists: false },
            });
            if (link.single_use) {
              await db.collection('payment_links').update_one(
                { id: String(link.id), single_use_claim_id: paymentId },
                { $unset: { single_use_claim_id: '' } },
              );
            }
          } else if (Number(cause.status || 500) < 500) {
            await db.collection('link_payments').update_one(
              { id: paymentId, status: { $nin: ['paid', 'expired'] } },
              { $set: {
                status: 'failed',
                failed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              } },
            );
            if (link.single_use) {
              await db.collection('payment_links').update_one(
                { id: String(link.id), single_use_claim_id: paymentId },
                { $unset: { single_use_claim_id: '' } },
              );
            }
          } else {
            await db.collection('link_payments').update_one(
              { id: paymentId, status: 'creating' },
              { $set: { status: 'provider_unknown', updated_at: new Date().toISOString() } },
            );
          }
          throw cause;
        }
        const fresh = await db.collection('link_payments').find_one(
          { id: paymentId }, { _id: 0 },
        );
        reply(res, 200, publicLinkPaymentStatus(fresh || payment));
        return true;
      }
      if (mobileMoneyStart) {
        const body = await readJson(req);
        if (typeof createLinkMobileMoneyDeposit !== 'function') {
          throw error(503, 'Le paiement Mobile Money par lien n’est pas disponible.');
        }
        if (typeof verifyBot !== 'function' || !body.turnstile_token) {
          throw error(403, 'La vérification anti-robot est requise.');
        }
        await verifyBot(body.turnstile_token, req, 'payment', env);
        const slug = String(body.slug || '').trim();
        const link = await db.collection('payment_links').find_one({ slug }, { _id: 0 });
        if (!link || link.active === false) throw error(404, 'Lien de paiement indisponible.');
        if (link.expires_at && Date.parse(link.expires_at) <= Date.now()) {
          throw error(410, 'Ce lien de paiement a expiré.');
        }
        const country = String(body.country || '').trim().toUpperCase();
        const operatorCode = String(body.operator || '').trim();
        const fullName = String(body.full_name || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const phone = String(body.phone_number || '').trim();
        const key = String(body.idempotency_key || '').trim();
        if (!/^[A-Z]{2}$/.test(country) || !operatorCode || fullName.length < 2
            || fullName.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
            || phone.length < 7 || phone.length > 32
            || !/^[A-Za-z0-9._-]{8,128}$/.test(key)) {
          throw error(422, 'Informations de paiement invalides.');
        }
        const settings = await db.collection('settings').find_one(
          { id: 'payment_provider_paydunya' }, { _id: 0 },
        );
        const operator = selectOperator(settings?.catalog, country, operatorCode);
        if (!settings?.enabled || !operator) {
          throw error(422, 'Cet opérateur Mobile Money n’est pas disponible pour ce lien.');
        }
        const currency = String(operator.currency || 'XOF').toUpperCase();
        if (!['XOF', 'XAF'].includes(currency)
            || (link.currency !== 'UNIVERSAL'
              && String(link.currency || '').toUpperCase() !== currency)) {
          throw error(422, 'La devise de cet opérateur ne correspond pas au lien.');
        }
        const amount = link.amount_type === 'free'
          ? numeric(body.amount, 'Montant')
          : numeric(link.amount, 'Montant du lien');
        const min = Math.max(Number(link.min_amount || 0), Number(operator.min || 0));
        const maxValues = [Number(link.max_amount || 0), Number(operator.max || 0)]
          .filter(value => value > 0);
        const max = maxValues.length ? Math.min(...maxValues) : 0;
        if (amount <= 0 || amount < min || (max > 0 && amount > max)) {
          throw error(422, 'Montant en dehors des limites de ce lien ou de cet opérateur.');
        }
        const fingerprint = crypto.createHash('sha256').update(stableJson({
          link_id: String(link.id), amount, currency, country, operator: operatorCode,
          full_name: fullName, email, phone,
        }), 'utf8').digest('hex');
        const paymentId = `lp_${crypto.createHash('sha256')
          .update(`${link.id}:${key}`, 'utf8').digest('hex').slice(0, 32)}`;
        let payment = await db.collection('link_payments').find_one(
          { id: paymentId }, { _id: 0 },
        );
        if (payment) {
          if (payment.request_fingerprint !== fingerprint) {
            throw error(409, 'Cette clé d’idempotence est déjà utilisée pour un autre paiement.');
          }
          const result = publicLinkPaymentStatus(payment);
          if (payment.checkout_url) {
            result.payment_kind = 'redirect';
            result.redirect_url = payment.checkout_url;
          }
          reply(res, 200, result);
          return true;
        }
        if (link.single_use) {
          const claim = await db.collection('payment_links').update_one(
            {
              id: link.id, active: { $ne: false },
              $or: [
                { single_use_claim_id: null },
                { single_use_claim_id: { $exists: false } },
                { single_use_claim_id: '' },
              ],
            },
            { $set: { single_use_claim_id: paymentId } },
          );
          if (!claim.matched_count) {
            const latestLink = await db.collection('payment_links').find_one(
              { id: link.id }, { _id: 0 },
            );
            if (latestLink?.single_use_claim_id !== paymentId) {
              throw error(409, 'Ce lien à usage unique a déjà été utilisé ou réservé.');
            }
          }
        }
        const now = new Date().toISOString();
        payment = {
          id: paymentId, link_id: String(link.id), user_id: String(link.user_id),
          slug: link.slug,
          method: 'mobile_money', status: 'creating', amount, currency,
          country, operator: operatorCode, operator_name: operator.name || operatorCode,
          customer_name: fullName, customer_email: email, customer_phone: phone,
          request_fingerprint: fingerprint, idempotency_key: key,
          fee_bearer: link.fee_bearer || 'customer',
          ...(link.single_use ? { single_use_claim_id: paymentId } : {}),
          created_at: now,
        };
        try {
          await db.collection('link_payments').insert_one(payment);
        } catch (cause) {
          const concurrent = await db.collection('link_payments').find_one(
            { id: paymentId }, { _id: 0 },
          );
          if (concurrent?.request_fingerprint === fingerprint) {
            reply(res, 200, publicLinkPaymentStatus(concurrent));
            return true;
          }
          if (link.single_use) {
            await db.collection('payment_links').update_one(
              { id: link.id, single_use_claim_id: paymentId },
              { $unset: { single_use_claim_id: '' } },
            );
          }
          throw cause;
        }
        const feeBearer = link.fee_bearer === 'merchant' ? 'merchant' : 'client';
        let started;
        try {
          started = await createLinkMobileMoneyDeposit(String(link.user_id), {
            amount, currency, country, operator: operatorCode,
            full_name: fullName, email, phone_number: phone,
            fee_bearer: feeBearer, otp: body.otp,
          }, `link-${paymentId}`, paymentId);
        } catch (cause) {
          const depositId = `pd_${crypto.createHash('sha256')
            .update(`${link.user_id}:link-${paymentId}`, 'utf8').digest('hex')}`;
          const deposit = await db.collection('momo_deposits').find_one(
            { id: depositId, user_id: String(link.user_id) }, { _id: 0 },
          );
          if (deposit) {
            const uncertain = ['pending', 'initiating', 'provider_unknown'].includes(
              String(deposit.status || ''),
            );
            await db.collection('link_payments').update_one(
              { id: paymentId, status: 'creating' },
              { $set: {
                status: uncertain ? 'pending' : 'failed',
                momo_deposit_id: depositId,
                submission_unknown: uncertain,
                failed_at: uncertain ? null : new Date().toISOString(),
              } },
            );
          } else {
            await db.collection('link_payments').update_one(
              { id: paymentId, status: 'creating' },
              { $set: { status: 'failed', failed_at: new Date().toISOString() } },
            );
            if (link.single_use) {
              await db.collection('payment_links').update_one(
                { id: link.id, single_use_claim_id: paymentId },
                { $unset: { single_use_claim_id: '' } },
              );
            }
          }
          throw cause;
        }
        if (!started?.handled || started.status < 200 || started.status >= 300
            || !started.body?.id) {
          const depositId = `pd_${crypto.createHash('sha256')
            .update(`${link.user_id}:link-${paymentId}`, 'utf8').digest('hex')}`;
          const deposit = await db.collection('momo_deposits').find_one(
            { id: depositId, user_id: String(link.user_id) }, { _id: 0 },
          );
          const uncertain = started?.status >= 500
            && ['pending', 'initiating', 'provider_unknown'].includes(String(deposit?.status || ''));
          await db.collection('link_payments').update_one(
            { id: paymentId, status: 'creating' },
            { $set: {
              status: uncertain ? 'pending' : 'failed',
              ...(deposit ? { momo_deposit_id: depositId } : {}),
              submission_unknown: uncertain,
              failed_at: uncertain ? null : new Date().toISOString(),
            } },
          );
          if (!uncertain && link.single_use) {
            await db.collection('payment_links').update_one(
              { id: link.id, single_use_claim_id: paymentId },
              { $unset: { single_use_claim_id: '' } },
            );
          }
          throw error(started?.status || 502, started?.body?.detail || 'Impossible de démarrer le paiement.');
        }
        const deposit = await db.collection('momo_deposits').find_one(
          { id: String(started.body.id) }, { _id: 0 },
        );
        let finalizeCapability = null;
        let finalizeCapabilityHash = null;
        let finalizeCapabilityExpiresAt = null;
        const requiresFinalization = deposit
          && (deposit.auth_mode === 'pin'
            || String(deposit.endpoint_slug || '').toLowerCase() === 'wizall-money-senegal')
          && deposit.status === 'pending';
        if (requiresFinalization) {
          finalizeCapability = crypto.randomBytes(32).toString('hex');
          finalizeCapabilityHash = crypto.createHash('sha256')
            .update(finalizeCapability, 'utf8').digest('hex');
          finalizeCapabilityExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        }
        await db.collection('link_payments').update_one(
          { id: paymentId, status: 'creating' },
          { $set: {
            status: 'pending',
            momo_deposit_id: String(started.body.id),
            charged_amount: Number(started.body.charged_amount || amount),
            amount_to_pay: Number(started.body.charged_amount || amount),
            fee: Number(started.body.total_fee || 0),
            gateway_fee: Number(started.body.gateway_fee || 0),
            platform_fee: Number(started.body.platform_fee || 0),
            pending_expires_at: started.body.pending_expires_at || null,
            ...(deposit ? {
              provider: deposit.provider,
              payment_flow: deposit.payment_flow || null,
              instructions: deposit.instructions || [],
              auth_mode: deposit.auth_mode || null,
              otp_required: Boolean(deposit.otp_required),
              challenge_status: requiresFinalization ? 'required' : (deposit.challenge_status || null),
            } : {}),
            ...(finalizeCapabilityHash ? {
              finalize_capability_hash: finalizeCapabilityHash,
              finalize_capability_expires_at: finalizeCapabilityExpiresAt,
            } : {}),
            ...(started.body.checkout_url ? { checkout_url: started.body.checkout_url } : {}),
            updated_at: new Date().toISOString(),
          } },
        );
        const fresh = await db.collection('link_payments').find_one(
          { id: paymentId }, { _id: 0 },
        );
        const result = publicLinkPaymentStatus(fresh || payment);
        if (fresh?.checkout_url) {
          result.payment_kind = 'redirect';
          result.redirect_url = fresh.checkout_url;
        }
        if (finalizeCapability) result.finalize_capability = finalizeCapability;
        reply(res, 200, result);
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
