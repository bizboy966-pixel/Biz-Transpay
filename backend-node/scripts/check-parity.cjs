'use strict';
const inventory = require('../route-inventory.json');
const pending = inventory.routes.filter(route => route.status !== 'verified');
if (pending.length) {
  console.error(`Migration NOT ready: ${pending.length}/${inventory.routes.length} routes still pending.`);
  process.exitCode = 1;
} else {
  console.error('Manual financial, storage and background-worker approval is also required.');
}
