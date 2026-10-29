'use strict';

const fs = require('node:fs');
const path = require('node:path');

if (process.env.BIZTRANSPAY_MIGRATION_ENV !== 'preview') {
  console.error('Startup blocked: configure this Plesk app as an isolated Preview instance.');
  process.exit(1);
}

const staticRoot = path.resolve(__dirname, 'generated-artifacts', 'frontend-build');
if (!fs.existsSync(path.join(staticRoot, 'index.html'))) {
  console.error('Frontend build missing. Run "npm run build:frontend" before starting the Plesk Preview app.');
  process.exit(1);
}

process.env.STATIC_ROOT = staticRoot;
require('./backend-node/app.js');
