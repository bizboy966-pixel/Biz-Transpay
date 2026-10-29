'use strict';

const fs = require('node:fs');
const path = require('node:path');

const migrationEnvironment = process.env.BIZTRANSPAY_MIGRATION_ENV;
if (!['preview', 'production'].includes(migrationEnvironment)) {
  console.error('Startup blocked: set BIZTRANSPAY_MIGRATION_ENV to preview or production.');
  process.exit(1);
}

const staticRoot = path.resolve(__dirname, 'generated-artifacts', 'frontend-build');
if (!fs.existsSync(path.join(staticRoot, 'index.html'))) {
  console.error('Frontend build missing. Run "npm run build:frontend" before starting the Plesk app.');
  process.exit(1);
}

process.env.STATIC_ROOT = staticRoot;
require('./backend-node/app.js');
