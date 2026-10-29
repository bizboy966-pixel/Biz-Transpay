'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPayDunyaDisbursementProbeRoutes } = require('../src/paydunya-disbursement-probe-routes.cjs');

test('PayDunya disbursement HEAD probe responds without processing a payment', async () => {
  const routes = createPayDunyaDisbursementProbeRoutes();
  const response = {
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) { this.body = body; },
  };
  const handled = await routes.handleRoute({
    method: 'HEAD', url: '/api/webhooks/paydunya/disbursement',
  }, response);
  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers.Allow, 'GET, HEAD, POST');
  assert.equal(response.body, undefined);
});

test('PayDunya disbursement probe leaves POST handling to the verified callback route', async () => {
  const routes = createPayDunyaDisbursementProbeRoutes();
  const handled = await routes.handleRoute({
    method: 'POST', url: '/api/webhooks/paydunya/disbursement',
  }, {});
  assert.equal(handled, false);
});
