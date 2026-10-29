'use strict';
const inventory = require('../route-inventory.json');
const unported = inventory.routes.filter(route => route.status === 'pending');
const unverified = inventory.routes.filter(route => route.status === 'implemented_unverified');
const other = inventory.routes.filter(route => !['pending', 'implemented_unverified', 'verified'].includes(route.status));
if (unported.length || unverified.length || other.length) {
  console.error(
    `Migration NOT ready: ${unported.length} routes not ported, `
    + `${unverified.length} ported but unverified, ${other.length} needing review `
    + `(${inventory.routes.length} total).`
  );
  process.exitCode = 1;
} else {
  console.error('All routes verified. Manual financial, storage and background-worker approval is still required.');
}
