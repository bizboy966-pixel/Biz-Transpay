'use strict';

function createWebhookProbeRoutes() {
  async function handleRoute(req, res) {
    if (req.url?.split('?')[0] !== '/api/webhooks/afribapay'
        || !['GET', 'HEAD'].includes(req.method)) return false;
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(req.method === 'GET' ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    });
    res.end(req.method === 'GET' ? JSON.stringify({ received: true }) : undefined);
    return true;
  }

  return { handleRoute };
}

module.exports = { createWebhookProbeRoutes };
