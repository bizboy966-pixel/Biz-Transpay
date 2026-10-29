'use strict';
const http = require('node:http');
const { createAuthSessionRoutes } = require('./auth-session-routes.cjs');

function createServer({ db = null, sessionService = null, env = process.env } = {}) {
  const handleAuthSession = createAuthSessionRoutes({ db, sessionService, env });
  // Explicit fail-closed migration server. Never forward traffic to live Python/providers.
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const health = req.method === 'GET' && new URL(req.url, 'http://localhost').pathname === '/healthz';
    if (health) {
      res.statusCode = 200;
      res.end(JSON.stringify({
        service: 'biz-transpay-node-preview',
        ready: false,
        migration_complete: false,
        implemented_groups: ['auth-session-read', 'auth-session-lifecycle'],
      }));
      return;
    }
    try {
      if (await handleAuthSession(req, res)) return;
      res.statusCode = 503;
      res.end(JSON.stringify({
        detail: 'Migration Node.js en cours. Opération non disponible.',
        code: 'MIGRATION_INCOMPLETE',
      }));
    } catch {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ detail: 'Erreur interne.' }));
      }
    }
  });
}

module.exports = { createServer };
