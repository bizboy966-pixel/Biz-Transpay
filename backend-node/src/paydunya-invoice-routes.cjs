'use strict';

const crypto = require('node:crypto');
const { sessionToken } = require('./auth-session-routes.cjs');
const { readJson } = require('./auth-login.cjs');
const security = require('./security.cjs');

const ROUTES = new Map([
  ['/api/deposits/mobile-money/par', 'par_redirect'],
  ['/api/deposits/mobile-money/par-redirect', 'par_redirect'],
  ['/api/deposits/paydunya/par', 'par_redirect'],
  ['/api/deposits/paydunya/par-redirect', 'par_redirect'],
  ['/api/deposits/mobile-money/psr', 'psr'],
  ['/api/deposits/paydunya/psr', 'psr'],
]);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function canonicalOperator(value) {
  const code = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (code.includes('orange')) return 'orange';
  if (code.includes('moov')) return 'moov';
  if (code.includes('mtn')) return 'mtn';
  if (code.includes('wave')) return 'wave';
  if (code.includes('tmoney') || code.includes('togo-tel')) return 'tmoney';
  if (code.includes('flooz')) return 'flooz';
  if (code.includes('celtiis')) return 'celtiis';
  if (code.includes('togocel')) return 'togocel';
  return code;
}

function selectOperator(catalog, country, requestedCode) {
  const countryCode = String(country || '').trim().toUpperCase();
  const requested = String(requestedCode || '').trim();
  if (!countryCode || !requested) return null;
  const eligible = (Array.isArray(catalog) ? catalog : []).filter(row => (
    row && String(row.country || '').toUpperCase() === countryCode
      && String(row.provider || 'paydunya').toLowerCase() === 'paydunya'
      && row.active !== false && row.enabled !== false
      && row.visible !== false && row.archived !== true
  ));
  const exact = eligible.find(row => (
    [row.code, row.operator, row.endpoint_slug].some(value => (
      String(value || '').toLowerCase() === requested.toLowerCase()
    ))
  ));
  if (exact) return exact;
  const canonical = canonicalOperator(requested);
  return eligible.find(row => (
    [row.code, row.operator, row.endpoint_slug]
      .some(value => canonicalOperator(value) === canonical)
  )) || null;
}

function calculateFees(amount, operator, feeBearer) {
  const currency = String(operator.currency || 'XOF').toUpperCase();
  const round = value => Math.round(Number(value) + Number.EPSILON);
  const requested = round(amount);
  let gatewayPct = operator.gateway_fee_pct;
  if (gatewayPct == null
      || (Number(gatewayPct || 0) === 0
        && Number(operator.platform_fee_pct || 0) === 0
        && operator.fee_pct != null)) {
    gatewayPct = operator.fee_pct || 0;
  }
  let gatewayFixed = Number(operator.gateway_fee_fixed || 0);
  const platformFixed = Number(operator.platform_fee_fixed || 0);
  if (!gatewayFixed && !platformFixed && operator.fee_fixed != null) {
    gatewayFixed = Number(operator.fee_fixed || 0);
  }
  const gatewayFee = round((requested * Number(gatewayPct || 0)) / 100 + gatewayFixed);
  const platformFee = round(
    (requested * Number(operator.platform_fee_pct || 0)) / 100 + platformFixed,
  );
  const totalFee = gatewayFee + platformFee;
  const merchantBearsFees = ['merchant', 'receiver'].includes(String(feeBearer || '').toLowerCase());
  const chargedAmount = merchantBearsFees ? requested : requested + totalFee;
  const walletCredit = merchantBearsFees ? requested - totalFee : requested;
  if (!Number.isSafeInteger(requested) || requested <= 0 || walletCredit <= 0) {
    throw httpError(422, 'Montant invalide après application des frais.');
  }
  return {
    requested_amount: requested,
    charged_amount: chargedAmount,
    gateway_fee: gatewayFee,
    platform_fee: platformFee,
    total_fee: totalFee,
    wallet_credit_amount: walletCredit,
    fee_bearer: merchantBearsFees ? 'merchant' : 'client',
    currency,
  };
}

function requestFingerprint(body, flow, fees, phone) {
  const canonical = JSON.stringify({
    flow,
    amount: fees.requested_amount,
    currency: fees.currency,
    country: String(body.country || '').toUpperCase(),
    operator: canonicalOperator(body.operator),
    phone,
    email: String(body.email || '').trim().toLowerCase(),
    fee_bearer: fees.fee_bearer,
    description: String(body.description || ''),
    return_url: String(body.return_url || ''),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function getInvoiceToken(payload) {
  return String(
    payload?.token
      || payload?.invoice_token
      || payload?.invoice?.token
      || '',
  ).trim();
}

function getCheckoutUrl(payload) {
  return String(
    payload?.response_url
      || payload?.checkout_url
      || payload?.url
      || payload?.payment_url
      || payload?.redirect_url
      || '',
  ).trim();
}

function safeCheckoutUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  return parsed.protocol === 'https:'
    && !parsed.username && !parsed.password
    && (parsed.hostname.toLowerCase() === 'app.paydunya.com'
      || parsed.hostname.toLowerCase().endsWith('.paydunya.com'));
}

function callbackOrigin(env) {
  const configured = String(
    env.OFFICIAL_DOMAIN || env.BIZTRANSPAY_PUBLIC_URL || 'https://biz-transpay.com',
  ).trim();
  const value = configured.includes('://') ? configured : `https://${configured}`;
  let url;
  try { url = new URL(value); } catch { throw httpError(503, 'Adresse de callback invalide.'); }
  if (url.protocol !== 'https:' || !url.hostname) {
    throw httpError(503, 'Adresse de callback HTTPS invalide.');
  }
  return url.origin;
}

function loadCredentials(config, sessionSecret, env) {
  const names = {
    master_key: 'PAYDUNYA_MASTER_KEY',
    private_key: 'PAYDUNYA_PRIVATE_KEY',
    token: 'PAYDUNYA_TOKEN',
    public_key: 'PAYDUNYA_PUBLIC_KEY',
  };
  const credentials = {};
  for (const [key, envName] of Object.entries(names)) {
    const encrypted = config[`${key}_encrypted`];
    if (encrypted) {
      if (!sessionSecret) throw httpError(503, 'Les identifiants PayDunya ne peuvent pas être déchiffrés.');
      try {
        credentials[key] = security.decryptFernet(encrypted, security.fernetKey(sessionSecret));
      } catch {
        throw httpError(503, 'Les identifiants PayDunya ne peuvent pas être déchiffrés.');
      }
    } else if (env[envName]) {
      credentials[key] = String(env[envName]);
    }
  }
  if (!credentials.master_key || !credentials.private_key || !credentials.token) {
    throw httpError(503, 'Les identifiants PayDunya ne sont pas configurés.');
  }
  return credentials;
}

async function invokePayDunya({ config, credentials, invoice, fetchImpl }) {
  const endpoint = config.mode === 'live'
    ? 'https://app.paydunya.com/api/v1/checkout-invoice/create'
    : 'https://app.paydunya.com/sandbox-api/v1/checkout-invoice/create';
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: {
        'PAYDUNYA-MASTER-KEY': credentials.master_key,
        'PAYDUNYA-PRIVATE-KEY': credentials.private_key,
        'PAYDUNYA-TOKEN': credentials.token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(invoice),
    });
  } catch {
    throw httpError(502, 'PayDunya ne répond pas. Vérifiez le statut avant de réessayer.');
  }
  let payload;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok || !payload || typeof payload !== 'object') {
    throw httpError(response.status >= 500 ? 502 : 400, 'PayDunya a refusé la création de facture.');
  }
  const responseCode = String(payload.response_code || payload.responseCode || '');
  if (responseCode && responseCode !== '00') {
    throw httpError(400, 'PayDunya a refusé la création de facture.');
  }
  return payload;
}

function createPaydunyaInvoiceRoutes({
  db, sessionService, sessionSecret = '', env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  async function handleRoute(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const flow = req.method === 'POST' ? ROUTES.get(url.pathname) : null;
    if (!flow) return false;

    try {
      const identity = await sessionService.authenticate(sessionToken(req));
      const userId = String(identity?.userId || '');
      if (!userId) throw httpError(401, 'Session requise.');

      const body = await readJson(req, 16 * 1024);
      const amount = Number(body.amount);
      const country = String(body.country || '').trim().toUpperCase();
      const operatorCode = String(body.operator || '').trim();
      const fullName = String(body.full_name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const phone = String(body.phone_number || '').replace(/[\s().-]/g, '');
      if (!Number.isSafeInteger(amount) || amount <= 0
          || !/^[A-Z]{2}$/.test(country) || !operatorCode
          || fullName.length < 2 || fullName.length > 160
          || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
          || (phone && !/^\+?\d{7,15}$/.test(phone))) {
        throw httpError(422, 'Informations de dépôt invalides.');
      }

      const settings = await db.collection('settings').find_one(
        { id: 'payment_provider_paydunya' }, { _id: 0 },
      );
      if (!settings?.enabled) throw httpError(503, 'Passerelle Mobile Money non configurée.');
      const modeSetting = settings.modes?.[flow];
      if (!settings.modes || !(modeSetting === true || modeSetting?.enabled === true)) {
        throw httpError(503, 'Ce mode de paiement Mobile Money est désactivé.');
      }
      const selected = selectOperator(settings.catalog, country, operatorCode);
      if (!selected) throw httpError(400, 'Opérateur non disponible pour ce pays.');
      const currency = String(selected.currency || 'XOF').toUpperCase();
      if (!['XOF', 'XAF'].includes(currency)
          || (body.currency && String(body.currency).toUpperCase() !== currency)) {
        throw httpError(400, 'Devise invalide pour cet opérateur.');
      }
      const minimum = Number(selected.min ?? 100);
      const maximum = Number(selected.max || 0);
      if (amount < minimum || (maximum > 0 && amount > maximum)) {
        throw httpError(422, `Montant autorisé : ${minimum} à ${maximum || 'sans maximum'} ${currency}.`);
      }
      const fees = calculateFees(amount, selected, body.fee_bearer);
      const fingerprint = requestFingerprint(body, flow, fees, phone);
      const suppliedIdempotencyKey = String(
        req.headers?.['idempotency-key'] || body.idempotency_key || '',
      ).trim();
      if (suppliedIdempotencyKey.length > 120) {
        throw httpError(422, 'Clé d’idempotence invalide.');
      }
      const depositId = suppliedIdempotencyKey
        ? `pd_${crypto.createHash('sha256')
          .update(`${userId}:${suppliedIdempotencyKey}`, 'utf8').digest('hex')}`
        : crypto.randomUUID();
      const deposits = db.collection('momo_deposits');
      const existing = suppliedIdempotencyKey
        ? await deposits.find_one({ id: depositId, user_id: userId }, { _id: 0 })
        : null;
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) {
          throw httpError(409, 'Cette clé d’idempotence est déjà liée à une autre demande.');
        }
        if (existing.initiation_state !== 'ready') {
          throw httpError(409, 'La demande existe déjà et nécessite une vérification avant nouvelle tentative.');
        }
        const result = {
          id: existing.id,
          status: existing.status,
          amount: existing.requested_amount,
          requested_amount: existing.requested_amount,
          charged_amount: existing.charged_amount,
          gateway_fee: existing.gateway_fee,
          platform_fee: existing.platform_fee,
          total_fee: existing.total_fee,
          fee_bearer: existing.fee_bearer,
          currency: existing.currency,
          mode: flow,
          created_at: existing.created_at,
          pending_expires_at: existing.pending_expires_at,
        };
        if (flow === 'par_redirect') {
          result.checkout_url = existing.checkout_url;
        } else {
          const expiresAt = Date.parse(existing.psr_capability_expires_at || '');
          if (!existing.psr_capability_encrypted || !Number.isFinite(expiresAt)
              || expiresAt <= Date.now()) {
            throw httpError(409, 'La demande PSR a expiré; créez une nouvelle demande.');
          }
          let previousCapability;
          try {
            previousCapability = security.decryptFernet(
              existing.psr_capability_encrypted, security.fernetKey(sessionSecret),
            );
          } catch {
            throw httpError(503, 'Le jeton PSR ne peut pas être récupéré.');
          }
          result.psr_token_url = `/api/deposits/paydunya/psr/${encodeURIComponent(existing.id)}`
            + `/token/${encodeURIComponent(previousCapability)}`;
        }
        reply(res, 200, result);
        return true;
      }

      const origin = callbackOrigin(env);
      const now = new Date().toISOString();
      const capability = flow === 'psr' ? crypto.randomBytes(32).toString('base64url') : '';
      const config = {
        ...settings,
        mode: settings.mode === 'live' ? 'live' : 'test',
      };
      const credentials = loadCredentials(config, sessionSecret, env);
      const userNameParts = fullName.split(/\s+/, 2);
      const document = {
        id: depositId,
        user_id: userId,
        amount,
        requested_amount: fees.requested_amount,
        charged_amount: fees.charged_amount,
        gateway_fee: fees.gateway_fee,
        platform_fee: fees.platform_fee,
        total_fee: fees.total_fee,
        wallet_credit_amount: fees.wallet_credit_amount,
        fee_snapshot: {
          ...fees,
          gateway_fee_pct: Number(selected.gateway_fee_pct ?? selected.fee_pct ?? 0),
          gateway_fee_fixed: Number(selected.gateway_fee_fixed || selected.fee_fixed || 0),
          platform_fee_pct: Number(selected.platform_fee_pct || 0),
          platform_fee_fixed: Number(selected.platform_fee_fixed || 0),
        },
        currency,
        email,
        full_name: fullName,
        country,
        operator: operatorCode,
        operator_name: selected.name || '',
        endpoint_slug: selected.endpoint_slug || '',
        operator_snapshot: selected,
        phone_number: phone,
        fee_bearer: fees.fee_bearer,
        idempotency_key: suppliedIdempotencyKey || null,
        request_fingerprint: fingerprint,
        status: 'pending',
        provider: 'paydunya',
        provider_mode: config.mode,
        paydunya_flow: flow,
        initiation_state: 'initiating',
        ...(capability ? {
          psr_capability_hash: crypto.createHash('sha256').update(capability).digest('hex'),
          psr_capability_encrypted: security.encryptFernet(
            capability, security.fernetKey(sessionSecret),
          ),
          psr_capability_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
          psr_capability_used: false,
        } : {}),
        created_at: now,
        pending_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      };
      await deposits.insert_one(document);

      const callbackUrl = `${origin}/api/webhooks/paydunya?ref=${encodeURIComponent(depositId)}`;
      let returnUrl = `${origin}/api/deposits/paydunya/return?ref=${encodeURIComponent(depositId)}`;
      if (body.return_url) {
        try {
          const suppliedReturnUrl = new URL(String(body.return_url));
          if (suppliedReturnUrl.origin !== origin || suppliedReturnUrl.protocol !== 'https:') {
            throw new Error('origin mismatch');
          }
          returnUrl = suppliedReturnUrl.toString();
        } catch {
          throw httpError(422, 'Adresse de retour invalide.');
        }
      }
      const names = fullName.split(/\s+/, 2);
      const providerInvoice = {
        invoice: {
          total_amount: fees.charged_amount,
          description: String(body.description || `Dépôt Biz-transPay ${amount} ${currency}`).slice(0, 250),
        },
        store: { name: String(settings.store_name || 'Biz-transPay') },
        actions: {
          callback_url: callbackUrl,
          return_url: returnUrl,
          cancel_url: `${origin}/dashboard/deposit?paydunya=cancelled`,
        },
        custom_data: {
          biztranspay_token: depositId,
          biztranspay_currency: currency,
          biztranspay_amount: String(fees.charged_amount),
        },
        customer: {
          firstname: names[0] || 'Client',
          lastname: names[1] || names[0] || 'Client',
          email,
          ...(phone ? { phone_number: phone } : {}),
        },
      };
      let invoice;
      try {
        invoice = await invokePayDunya({ config, credentials, invoice: providerInvoice, fetchImpl });
      } catch (error) {
        await deposits.update_one({ id: depositId, user_id: userId }, { $set: {
          initiation_state: error.status === 400 ? 'rejected' : 'unknown',
          initiation_error: String(error.message || 'provider error').slice(0, 180),
          ...(error.status === 400 ? { status: 'failed' } : {}),
          updated_at: new Date().toISOString(),
        } });
        throw error;
      }
      const token = getInvoiceToken(invoice);
      const checkoutUrl = getCheckoutUrl(invoice);
      if (!token || (flow === 'par_redirect' && !safeCheckoutUrl(checkoutUrl))) {
        await deposits.update_one({ id: depositId, user_id: userId }, { $set: {
          initiation_state: 'unknown',
          updated_at: new Date().toISOString(),
        } });
        throw httpError(502, 'PayDunya n’a pas retourné une facture exploitable.');
      }
      const tokenUrl = capability
        ? `/api/deposits/paydunya/psr/${encodeURIComponent(depositId)}/token/${encodeURIComponent(capability)}`
        : null;
      await deposits.update_one({ id: depositId, user_id: userId }, { $set: {
        paydunya_token: token,
        paydunya_reference: String(invoice.reference || invoice.invoice_id || ''),
        checkout_url: checkoutUrl || '',
        initiation_state: 'ready',
        updated_at: new Date().toISOString(),
      } });
      const result = {
        id: depositId,
        status: 'pending',
        amount: fees.requested_amount,
        requested_amount: fees.requested_amount,
        charged_amount: fees.charged_amount,
        gateway_fee: fees.gateway_fee,
        platform_fee: fees.platform_fee,
        total_fee: fees.total_fee,
        fee_bearer: fees.fee_bearer,
        currency,
        mode: flow,
        created_at: now,
        pending_expires_at: document.pending_expires_at,
      };
      if (flow === 'par_redirect') result.checkout_url = checkoutUrl;
      else result.psr_token_url = tokenUrl;
      reply(res, 200, result);
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      reply(res, status, {
        detail: status >= 500 ? 'Impossible de démarrer le dépôt.' : error.message,
      });
    }
    return true;
  }

  return { handleRoute };
}

module.exports = {
  createPaydunyaInvoiceRoutes,
  selectOperator,
  calculateFees,
  getInvoiceToken,
  getCheckoutUrl,
  loadCredentials,
};
