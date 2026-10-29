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
  try {
    let dependencies = {};
    if (process.env.MYSQL_DATABASE_URL) {
      const jwtSecret = process.env.JWT_SECRET || process.env.SESSION_SECRET;
      if (!jwtSecret) throw new Error('Preview session signing secret is not configured');
      const { createPreviewPool, MySqlStore } = require('./src/mysql-store.cjs');
      const { SessionService } = require('./src/session-service.cjs');
      store = new MySqlStore(createPreviewPool(process.env.MYSQL_DATABASE_URL));
      await Promise.all([
        store.columnsForCollection('users'),
        store.columnsForCollection('sessions'),
      ]);
      dependencies = {
        db: store,
        sessionService: new SessionService(store, { jwtSecret }),
      };
    }
    server = createServer(dependencies).listen(port, '0.0.0.0', () => {
      console.log(process.env.MYSQL_DATABASE_URL
        ? `Preview Node server on port ${port}; only migrated auth session routes are enabled.`
        : `Migration diagnostic server on port ${port}; business routes disabled.`);
    });
  } catch {
    if (store) await store.close().catch(() => {});
    console.error('Startup failed: Preview MySQL schema or Node session configuration is unavailable.');
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
