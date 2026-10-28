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
const server = createServer().listen(port, '0.0.0.0', () => {
  console.log(`Migration diagnostic server on port ${port}; business routes disabled.`);
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
