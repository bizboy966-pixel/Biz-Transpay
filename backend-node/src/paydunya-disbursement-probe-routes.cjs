'use strict';

function createPayDunyaDisbursementProbeRoutes() {
  async function handleRoute(req, res) {
    if (req.method !== 'HEAD') return false;
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname !== '/api/webhooks/paydunya/disbursement') return false;
    res.writeHead(200, {
      Allow: 'GET, HEAD, POST',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end();
    return true;
  }

  return { handleRoute };
}

module.exports = { createPayDunyaDisbursementProbeRoutes };
