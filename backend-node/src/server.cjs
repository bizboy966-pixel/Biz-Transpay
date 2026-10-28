'use strict';
const http = require('node:http');

function createServer() {
  // Explicit fail-closed migration server. Never forward traffic to live Python/providers.
  return http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const health = req.method === 'GET' && req.url === '/healthz';
    res.statusCode = health ? 200 : 503;
    res.end(JSON.stringify(health
      ? { service: 'biz-transpay-node-preview', ready: false, migration_complete: false }
      : { detail: 'Migration Node.js en cours. Opération non disponible.', code: 'MIGRATION_INCOMPLETE' }));
  });
}

module.exports = { createServer };
