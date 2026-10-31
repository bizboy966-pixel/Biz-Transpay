'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createIntegrationDocumentationRoutes } = require('../src/integration-documentation-routes.cjs');

function response() {
  return {
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

test('integration documentation describes authenticated reads and supported writes', async () => {
  const routes = createIntegrationDocumentationRoutes();
  const res = response();
  const handled = await routes.handleRoute({
    method: 'GET', url: '/api/integration/documentation',
  }, res);
  const body = JSON.parse(res.body);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.ok(body.sections.length > 0);
  assert.ok(body.endpoints.some(item => item.path === '/api/integration/v1/transactions'));
  assert.equal(body.base_url, 'https://biz-transpay.com');

  const deposit = body.endpoints.find(item => (
    item.method === 'POST' && item.path === '/api/integration/v1/deposits'
  ));
  const payout = body.endpoints.find(item => (
    item.method === 'POST' && item.path === '/api/integration/v1/payouts'
  ));
  assert.ok(deposit?.request);
  assert.ok(payout?.request);
  const writeEndpoints = body.endpoints.filter(item => item.method === 'POST');
  assert.equal(writeEndpoints.length, 6);
  for (const endpoint of writeEndpoints) {
    assert.ok(endpoint.request, `${endpoint.path} has a request example`);
    assert.ok(endpoint.code_examples?.curl, `${endpoint.path} has a cURL example`);
    assert.match(endpoint.auth, /Idempotency-Key/);
    assert.ok(endpoint.risk_notice);
  }
  assert.match(deposit.auth, /Authorization: Bearer/);
  assert.match(deposit.auth, /X-Public-Key/);
  assert.match(deposit.auth, /Idempotency-Key/);
  assert.match(deposit.code_examples.curl, /X-Public-Key/);
  assert.match(deposit.code_examples.curl, /Idempotency-Key/);
  assert.match(`${payout.description} ${payout.auth}`, /KYC/i);
  assert.ok(body.endpoints.some(item => (
    item.path === '/api/integration/v1/links/{id}/payments'
  )));
  assert.equal(body.endpoints.some(item => (
    item.path === '/api/integration/v1/links/payments/{id}'
  )), false);
});

test('integration documentation PDF is delivered with a valid PDF response', async () => {
  const routes = createIntegrationDocumentationRoutes();
  const res = response();
  const handled = await routes.handleRoute({
    method: 'GET', url: '/api/integration/documentation.pdf',
  }, res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/pdf');
  assert.ok(Buffer.isBuffer(res.body));
  assert.ok(res.body.subarray(0, 8).toString('ascii').startsWith('%PDF-1.'));
  assert.ok(res.body.toString('ascii').includes('%%EOF'));
  assert.ok(res.body.toString('ascii').includes('/api/integration/v1/deposits'));
  assert.ok(res.body.toString('ascii').includes('/api/integration/v1/payouts'));
});

