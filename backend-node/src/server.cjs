'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createAuthSessionRoutes, verifyCsrf } = require('./auth-session-routes.cjs');
const { createAuthLoginRoute } = require('./auth-login.cjs');
const { createAuthRegisterRoute } = require('./auth-register.cjs');
const { createAuthMfaRoutes } = require('./auth-mfa-routes.cjs');
const { createAuthRecoveryRoutes } = require('./auth-recovery-routes.cjs');
const { createUserDataRoutes } = require('./user-data-routes.cjs');
const { createTelegramNotifier } = require('./telegram-notifications.cjs');
const { createKycRoutes } = require('./kyc-routes.cjs');
const { createUserSettingsRoutes } = require('./user-settings-routes.cjs');
const { createNotificationsPushRoutes } = require('./notifications-push-routes.cjs');
const { createReferralRoutes } = require('./referral-routes.cjs');
const { createSupportRoutes } = require('./support-routes.cjs');
const { createPublicConfigRoutes } = require('./public-config-routes.cjs');
const { createCryptoCatalogRoutes } = require('./crypto-catalog-routes.cjs');
const { createExchangeRoutes } = require('./exchange-routes.cjs');
const { createTransferRoutes } = require('./transfer-routes.cjs');
const { createAdminUserRoutes } = require('./admin-user-routes.cjs');
const { createAdminBalanceRoutes } = require('./admin-balance-routes.cjs');
const { createAdminTransactionRoutes } = require('./admin-transaction-routes.cjs');
const { createAdminPaymentLinkRoutes } = require('./admin-payment-link-routes.cjs');
const { createAdminPaymentProviderRoutes } = require('./admin-payment-provider-routes.cjs');
const { createAdminSettingsRoutes } = require('./admin-settings-routes.cjs');
const { createAdminStatisticsRoutes } = require('./admin-statistics-routes.cjs');
const { createPaymentLinkRoutes } = require('./payment-link-routes.cjs');
const { createAdminPushRoutes } = require('./admin-push-routes.cjs');

const STATIC_MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res, root) {
  if (!root || !['GET', 'HEAD'].includes(String(req.method || '').toUpperCase())) return false;
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname); }
  catch {
    res.writeHead(400);
    res.end();
    return true;
  }
  if (pathname === '/healthz' || pathname === '/api' || pathname.startsWith('/api/')) return false;

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const candidate = path.resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    res.writeHead(404);
    res.end();
    return true;
  }

  let file = candidate;
  let stat;
  try {
    stat = await fs.promises.stat(file);
    if (!stat.isFile()) stat = null;
  } catch { stat = null; }

  if (!stat) {
    // Serve the React entry point for client-side routes, but never disguise a
    // missing asset (such as a missing JS bundle) as a successful HTML response.
    if (path.extname(relative)) {
      res.writeHead(404);
      res.end();
      return true;
    }
    file = path.join(root, 'index.html');
    try {
      stat = await fs.promises.stat(file);
      if (!stat.isFile()) stat = null;
    } catch { stat = null; }
  }
  if (!stat) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Frontend build unavailable');
    return true;
  }

  const extension = path.extname(file).toLowerCase();
  const headers = {
    'Content-Type': STATIC_MIME_TYPES[extension] || 'application/octet-stream',
    'Content-Length': String(stat.size),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': path.basename(file) === 'index.html'
      ? 'no-cache' : 'public, max-age=31536000, immutable',
  };
  res.writeHead(200, headers);
  if (String(req.method).toUpperCase() === 'HEAD') {
    res.end();
    return true;
  }
  await new Promise(resolve => {
    const stream = fs.createReadStream(file);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
      resolve();
    });
    stream.on('end', resolve);
    stream.pipe(res);
  });
  return true;
}

function createServer({
  db = null, sessionService = null, jwtSecret = '', sessionSecret = '',
  env = process.env, verifyBot, sendEmail, onAuthRecoveryError,
  sendTelegramNotification,
} = {}, {
  staticRoot: configuredStaticRoot = '',
  healthState = null,
} = {}) {
  const staticRoot = configuredStaticRoot ? path.resolve(configuredStaticRoot) : '';
  const telegramNotifier = sendTelegramNotification
    ? { enqueueAdminLogin: sendTelegramNotification }
    : createTelegramNotifier({ db, env });
  const handleAuthSession = createAuthSessionRoutes({ db, sessionService, env });
  const handleAuthRegister = createAuthRegisterRoute({
    db, jwtSecret, sessionSecret, env, verifyBot,
  });
  const handleAuthLogin = createAuthLoginRoute({
    db, sessionService, jwtSecret, sessionSecret, env, verifyBot,
    onAdminLogin: telegramNotifier.enqueueAdminLogin,
  });
  const handleAuthMfa = createAuthMfaRoutes({
    db, sessionService, jwtSecret, sessionSecret,
  });
  const handleAuthRecovery = createAuthRecoveryRoutes({
    db, sessionService, jwtSecret, sessionSecret, env, verifyBot, sendEmail,
    onError: onAuthRecoveryError,
  });
  const handleUserData = createUserDataRoutes({ db, sessionService });
  const handleKyc = createKycRoutes({
    db, sessionService, notifyAdminKyc: telegramNotifier.enqueueKycEvent,
  });
  const handleUserSettings = createUserSettingsRoutes({
    db, sessionService, sessionSecret,
  });
  const notifications = createNotificationsPushRoutes({ db, sessionService, env });
  const referrals = createReferralRoutes({ db, sessionService });
  const support = createSupportRoutes({ db, sessionService, env });
  const publicConfig = createPublicConfigRoutes({ db, sessionService, env });
  const paymentLinks = createPaymentLinkRoutes({ db, sessionService });
  const cryptoCatalog = createCryptoCatalogRoutes({ db, sessionService, sessionSecret, env });
  const exchange = createExchangeRoutes({
    db, sessionService, cryptoCatalog, notify: notifications.notify,
  });
  const transfers = createTransferRoutes({
    db, sessionService, sessionSecret, env, verifyBot, cryptoCatalog,
    notify: notifications.notify,
  });
  const adminUserRoutes = createAdminUserRoutes({
    db, sessionService, cryptoCatalog, env,
    notify: notifications.notify,
    notifyAdminKyc: telegramNotifier.enqueueKycEvent,
  });
  const adminBalanceRoutes = createAdminBalanceRoutes({
    db, sessionService, cryptoCatalog, env,
  });
  const adminTransactionRoutes = createAdminTransactionRoutes({
    db, sessionService, env,
  });
  const adminPaymentLinkRoutes = createAdminPaymentLinkRoutes({
    db, sessionService, env,
  });
  const adminPaymentProviderRoutes = createAdminPaymentProviderRoutes({
    db, sessionService, sessionSecret, env,
  });
  const adminSettingsRoutes = createAdminSettingsRoutes({ db, sessionService, env });
  const adminStatisticsRoutes = createAdminStatisticsRoutes({ db, sessionService, env });
  const adminPushRoutes = createAdminPushRoutes({
    db, sessionService, env,
    sendPushToUser: notifications.sendPushToUser,
    notify: notifications.notify,
  });
  // Explicit fail-closed migration server. Never forward traffic to legacy services or providers.
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const health = req.method === 'GET' && new URL(req.url, 'http://localhost').pathname === '/healthz';
    if (health) {
      let database = healthState?.database || (db ? 'unverified' : 'not_configured');
      let issue = healthState?.issue || null;
      let schemaStatus = healthState?.schemaStatus
        || (issue === 'required_tables_missing' ? 'incomplete' : 'not_checked');
      let databasePingFailed = false;
      if (db?.healthCheck) {
        try {
          await db.healthCheck();
          database = 'connected';
        } catch {
          database = 'unavailable';
          databasePingFailed = true;
          issue = issue || 'mysql_ping_failed';
        }
      }
      if (databasePingFailed) schemaStatus = 'unavailable';
      // This is a liveness/diagnostic endpoint: always return its JSON body if
      // Node is listening. The database field reports readiness separately.
      res.statusCode = 200;
      res.end(JSON.stringify({
        backend: 'ok',
        database,
        ...(issue ? { issue } : {}),
        schema_complete: database === 'connected' && schemaStatus === 'complete',
        schema_status: schemaStatus,
        // Route migration is tracked independently; several business APIs are
        // intentionally still disabled until their port and regression tests land.
        migration_complete: false,
      }));
      return;
    }
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      const method = String(req.method || 'GET').toUpperCase();
      if (healthState?.issue && path.startsWith('/api/')) {
        if (path === '/api/security/turnstile-config'
            && await publicConfig.handleRoute(req, res)) return;
        res.statusCode = 503;
        res.end(JSON.stringify({
          detail: {
            code: 'BACKEND_NOT_READY',
            message: 'Le backend est en mode diagnostic; les opérations restent bloquées.',
            issue: healthState.issue,
          },
        }));
        return;
      }
      if (await serveStatic(req, res, staticRoot)) return;
      if (method === 'GET' && path === '/api/') {
        res.statusCode = 200;
        res.end(JSON.stringify({ message: 'Biz-transPay API', status: 'ok' }));
        return;
      }
      const csrfExempt = path === '/api/auth/login'
        || path === '/api/auth/register'
        || path === '/api/auth/recover'
        || path === '/api/auth/password-reset/request'
        || path === '/api/auth/password-reset/confirm'
        || path === '/api/auth/user-pin/reset/request'
        || path === '/api/auth/user-pin/reset/confirm'
        || path === '/api/webhooks/afribapay'
        || path === '/api/links/pay'
        || path === '/api/links/pay/mobile-money'
        || (path.startsWith('/api/links/payments/')
          && (path.endsWith('/finalize') || path.endsWith('/mobile-money/finalize')));
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
          && path.startsWith('/api/') && !csrfExempt && !verifyCsrf(req, env)) {
        res.statusCode = 403;
        res.end(JSON.stringify({
          detail: {
            code: 'CSRF_TOKEN_INVALID',
            message: 'Jeton CSRF absent ou invalide.',
          },
        }));
        return;
      }
      if (await handleAuthRegister(req, res)) return;
      if (await handleAuthLogin(req, res)) return;
      if (await handleAuthMfa(req, res)) return;
      if (await handleAuthRecovery(req, res)) return;
      if (await handleAuthSession(req, res)) return;
      if (await handleUserData(req, res)) return;
      if (await handleKyc(req, res)) return;
      if (await handleUserSettings(req, res)) return;
      if (await notifications.handleRoute(req, res)) return;
      if (await referrals.handleRoute(req, res)) return;
      if (await support.handleRoute(req, res)) return;
       if (await paymentLinks(req, res)) return;
      if (await publicConfig.handleRoute(req, res)) return;
      if (await cryptoCatalog.handleRoute(req, res)) return;
      if (await transfers.handleRoute(req, res)) return;
      if (await exchange.handleRoute(req, res)) return;
      if (await adminTransactionRoutes.handleRoute(req, res)) return;
      if (await adminPaymentLinkRoutes.handleRoute(req, res)) return;
      if (await adminPaymentProviderRoutes.handleRoute(req, res)) return;
      if (await adminBalanceRoutes.handleRoute(req, res)) return;
      if (await adminUserRoutes.handleRoute(req, res)) return;
      if (await adminSettingsRoutes.handleRoute(req, res)) return;
      if (await adminStatisticsRoutes.handleRoute(req, res)) return;
       if (await adminPushRoutes(req, res)) return;
      res.statusCode = 503;
      res.end(JSON.stringify({
        detail: 'Migration Node.js en cours. Opération non disponible.',
        code: 'MIGRATION_INCOMPLETE',
      }));
    } catch {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ detail: 'Erreur interne.' }));
      }
    }
  });
}

module.exports = { createServer };
