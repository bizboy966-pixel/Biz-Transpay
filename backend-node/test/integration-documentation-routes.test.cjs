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

test('integration documentation lists only the implemented read endpoints', async () => {
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
  assert.equal(body.endpoints.some(item => item.method === 'POST'), false);
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
});

