'use strict';
const http = require('node:http');
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
const { createAdminUserRoutes } = require('./admin-user-routes.cjs');
const { createAdminBalanceRoutes } = require('./admin-balance-routes.cjs');
const { createAdminTransactionRoutes } = require('./admin-transaction-routes.cjs');

function createServer({
  db = null, sessionService = null, jwtSecret = '', sessionSecret = '',
  env = process.env, verifyBot, sendEmail, onAuthRecoveryError,
  sendTelegramNotification,
} = {}) {
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
  const support = createSupportRoutes({ db, sessionService });
  const publicConfig = createPublicConfigRoutes({ db, env });
  const cryptoCatalog = createCryptoCatalogRoutes({ db, sessionService, sessionSecret, env });
  const exchange = createExchangeRoutes({
    db, sessionService, cryptoCatalog, notify: notifications.notify,
  });
  const adminUserRoutes = createAdminUserRoutes({ db, sessionService, cryptoCatalog, env });
  const adminBalanceRoutes = createAdminBalanceRoutes({
    db, sessionService, cryptoCatalog, env,
  });
  const adminTransactionRoutes = createAdminTransactionRoutes({
    db, sessionService, env,
  });
  // Explicit fail-closed migration server. Never forward traffic to live Python/providers.
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const health = req.method === 'GET' && new URL(req.url, 'http://localhost').pathname === '/healthz';
    if (health) {
      res.statusCode = 200;
      res.end(JSON.stringify({
        service: 'biz-transpay-node-preview',
        ready: false,
        migration_complete: false,
        implemented_groups: [
          'auth-login', 'auth-register', 'auth-session-lifecycle',
          'auth-mfa', 'auth-recovery', 'user-wallet-summary', 'user-transactions',
          'user-kyc',
          'user-settings',
          'user-notifications-push',
          'user-referrals',
          'user-support',
          'public-config',
          'crypto-catalog',
          'conversion-exchange',
          'admin-user-list',
          'admin-wallet-adjustment',
          'admin-transaction-read',
        ],
      }));
      return;
    }
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      const method = String(req.method || 'GET').toUpperCase();
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
      if (await publicConfig.handleRoute(req, res)) return;
      if (await cryptoCatalog.handleRoute(req, res)) return;
      if (await exchange.handleRoute(req, res)) return;
      if (await adminTransactionRoutes.handleRoute(req, res)) return;
      if (await adminBalanceRoutes.handleRoute(req, res)) return;
      if (await adminUserRoutes.handleRoute(req, res)) return;
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
