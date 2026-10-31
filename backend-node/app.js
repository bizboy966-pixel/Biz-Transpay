'use strict';
const { createServer } = require('./src/server.cjs');

// This independent setting identifies the data environment, not NODE_ENV.
const migrationEnvironment = process.env.BIZTRANSPAY_MIGRATION_ENV;
if (!['preview', 'production'].includes(migrationEnvironment)) {
  console.error('Startup blocked: set BIZTRANSPAY_MIGRATION_ENV to preview or production.');
  process.exit(1);
}
const port = Number(process.env.PORT || 5100);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Invalid port');
  process.exit(1);
}

function startHttpServer(dependencies, healthState = null) {
  const application = createServer(dependencies, {
    staticRoot: process.env.STATIC_ROOT || '',
    healthState,
  });
  const server = application.listen(port, '0.0.0.0', () => {
    console.log(healthState?.issue
      ? `${migrationEnvironment} Node diagnostic server on port ${port}; business APIs are blocked.`
      : `${migrationEnvironment} Node server on port ${port}; unverified routes remain disabled.`);
  });
  application.afriBaPayDepositWorker?.start();
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      application.afriBaPayDepositWorker?.stop();
      server.close(async () => {
        if (dependencies.db) await dependencies.db.close().catch(() => {});
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 5000).unref();
    });
  }
  return server;
}

function diagnosticState(error, stage) {
  if (error?.code === 'MYSQL_URL_REQUIRED') {
    return {
      database: 'not_configured',
      schemaStatus: 'not_checked',
      issue: 'mysql_url_missing',
    };
  }
  if (error?.code === 'SESSION_SECRET_REQUIRED') {
    return {
      database: 'not_checked',
      schemaStatus: 'not_checked',
      issue: 'session_secret_missing',
    };
  }
  if (error?.code === 'SPLIT_SCHEMA_MISSING') {
    return {
      database: 'schema_incomplete',
      schemaStatus: 'incomplete',
      issue: 'required_tables_missing',
    };
  }
  if (stage === 'mysql-connect-and-schema-check') {
    const connectionErrors = new Set([
      'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH',
      'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR',
    ]);
    return {
      database: 'unavailable',
      schemaStatus: 'not_checked',
      issue: connectionErrors.has(error?.code) ? 'mysql_connection_failed' : 'mysql_check_failed',
    };
  }
  return {
    database: 'unavailable',
    schemaStatus: 'not_checked',
    issue: 'startup_failed',
  };
}

async function start() {
  let store = null;
  let startupStage = 'session-configuration';
  try {
    let dependencies = {};
    if (migrationEnvironment === 'production' && !process.env.MYSQL_DATABASE_URL) {
      startupStage = 'mysql-configuration';
      const error = new Error('Production MySQL URL is required');
      error.code = 'MYSQL_URL_REQUIRED';
      throw error;
    }
    if (process.env.MYSQL_DATABASE_URL) {
      const jwtSecret = process.env.JWT_SECRET || process.env.SESSION_SECRET;
      if (!jwtSecret) {
        const error = new Error('Session signing secret is not configured');
        error.code = 'SESSION_SECRET_REQUIRED';
        throw error;
      }
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
        'integration_operations', 'integration_webhooks',
        'integration_webhook_deliveries', 'integration_webhook_events',
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
    startHttpServer(dependencies, {
      schemaStatus: store ? 'complete' : 'not_checked',
    });
  } catch (error) {
    if (store) await store.close().catch(() => {});
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code)
      ? error.code : 'CHECK_FAILED';
    const state = diagnosticState(error, startupStage);
    console.error(`Startup degraded at ${startupStage} (${code}); business APIs are blocked.`);
    startHttpServer({}, state);
  }
}

start();
