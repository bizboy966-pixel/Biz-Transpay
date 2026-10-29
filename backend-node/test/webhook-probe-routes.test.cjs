'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWebhookProbeRoutes } = require('../src/webhook-probe-routes.cjs');

async function call(service, method, path = '/api/webhooks/afribapay') {
  const response = {
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) { this.body = body; },
  };
  const handled = await service.handleRoute({ method, url: path }, response);
  return { handled, ...response };
}

test('AfriBaPay GET probe returns the legacy acknowledgement', async () => {
  const result = await call(createWebhookProbeRoutes(), 'GET', '/api/webhooks/afribapay?ref=probe');
  assert.equal(result.handled, true);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { received: true });
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('AfriBaPay HEAD probe returns headers without a body', async () => {
  const result = await call(createWebhookProbeRoutes(), 'HEAD');
  assert.equal(result.handled, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, undefined);
});

test('AfriBaPay probe leaves POST and unrelated paths to their handlers', async () => {
  const service = createWebhookProbeRoutes();
  assert.equal((await call(service, 'POST')).handled, false);
  assert.equal((await call(service, 'GET', '/api/webhooks/other')).handled, false);
});
