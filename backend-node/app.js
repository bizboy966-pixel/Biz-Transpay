'use strict';
const { createServer } = require('./src/server.cjs');

// NODE_ENV=production can be required by Plesk even for a test domain.
// This independent guard describes the DATA environment instead.
if (process.env.BIZTRANSPAY_MIGRATION_ENV !== 'preview') {
  console.error('Startup blocked: this incomplete backend is for isolated Preview only.');
  process.exit(1);
}
const port = Number(process.env.PORT || 5100);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Invalid port');
  process.exit(1);
}

async function start() {
  let store = null;
  let server;
  let startupStage = 'session-configuration';
  try {
    let dependencies = {};
    if (process.env.MYSQL_DATABASE_URL) {
      const jwtSecret = process.env.JWT_SECRET || process.env.SESSION_SECRET;
      if (!jwtSecret) throw new Error('Preview session signing secret is not configured');
      const sessionSecret = process.env.SESSION_SECRET || jwtSecret;
      const { createPreviewPool, MySqlStore } = require('./src/mysql-store.cjs');
      const { SessionService } = require('./src/session-service.cjs');
      startupStage = 'mysql-connect-and-schema-check';
      store = new MySqlStore(createPreviewPool(process.env.MYSQL_DATABASE_URL));
      await Promise.all([
        'users', 'sessions', 'auth_rate_limits', 'auth_challenges',
        'auth_events', 'mfa_enrollments', 'platform_bootstrap', 'admin_logs',
        'password_reset_limits', 'password_reset_tokens', 'settings',
        'transactions', 'momo_deposits', 'crypto_deposits', 'wallet_operations',
        'kyc', 'notifications', 'push_devices', 'referral_commissions',
        'tickets', 'support_messages',
      ].map(collection => store.columnsForCollection(collection)));
      dependencies = {
        db: store,
        sessionService: new SessionService(store, { jwtSecret }),
        jwtSecret,
        sessionSecret,
      };
    }
    startupStage = 'server-listen';
    server = createServer(dependencies, {
      staticRoot: process.env.STATIC_ROOT || '',
    }).listen(port, '0.0.0.0', () => {
      console.log(process.env.MYSQL_DATABASE_URL
        ? `Preview Node server on port ${port}; only verified authentication routes are enabled.`
        : `Migration diagnostic server on port ${port}; business routes disabled.`);
    });
  } catch (error) {
    if (store) await store.close().catch(() => {});
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code)
      ? error.code : 'CHECK_FAILED';
    console.error(`Startup failed at ${startupStage} (${code}); no database URL or error message logged.`);
    process.exitCode = 1;
    return;
  }
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      server.close(async () => {
        if (store) await store.close().catch(() => {});
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 5000).unref();
    });
  }
}

start();
