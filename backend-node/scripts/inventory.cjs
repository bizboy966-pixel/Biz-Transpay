'use strict';

const fs = require('node:fs');
const path = require('node:path');

const inventoryPath = path.join(__dirname, '..', 'route-inventory.json');
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
if (!Array.isArray(inventory.routes)) throw new Error('Route inventory is missing its routes list');

const seen = new Set();
const allowed = new Set(['pending', 'implemented_unverified', 'verified', 'needs_review']);
for (const route of inventory.routes) {
  if (!route.method || !route.path || !route.status || !allowed.has(route.status)) {
    throw new Error(`Invalid route inventory entry: ${JSON.stringify(route)}`);
  }
  const key = `${route.method} ${route.path}`;
  if (seen.has(key)) throw new Error(`Duplicate route: ${key}`);
  seen.add(key);
}
console.log(`${inventory.routes.length} routes in the preserved migration inventory.`);
