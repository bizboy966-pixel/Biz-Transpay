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
  const mobileMoney = body.sections.find(section => section.id === 'mobile-money');
  const transactionTracking = body.sections.find(section => section.id === 'transactions');
  assert.match(mobileMoney.description, /fee_bearer indique/);
  assert.match(mobileMoney.description, /charged_amount/);
  assert.match(transactionTracking.description, /traitement Biz-transPay/);
  assert.doesNotMatch(JSON.stringify(body), /PayDunya|AfriBaPay|Mbiyo/i);

  const deposit = body.endpoints.find(item => (
    item.method === 'POST' && item.path === '/api/integration/v1/deposits'
  ));
  const payout = body.endpoints.find(item => (
    item.method === 'POST' && item.path === '/api/integration/v1/payouts'
  ));
  assert.ok(deposit?.request);
  assert.ok(payout?.request);
  assert.match(deposit.description, /Biz-transPay choisit le traitement côté serveur/);
  assert.match(payout.description, /ne reroute pas un retrait en cours/);
  assert.ok(deposit.parameters.some(parameter => parameter.name === 'fee_bearer'));
  assert.match(deposit.parameters.find(parameter => parameter.name === 'request_otp').description,
    /ne crée pas de dépôt/);
  assert.equal(deposit.otp_request_response.charged_amount, 621);
  assert.equal(deposit.parameters.some(parameter => parameter.name === 'provider'), false);
  assert.equal(payout.parameters.some(parameter => parameter.name === 'provider'), false);
  const quote = body.endpoints.find(item => (
    item.method === 'POST' && item.path === '/api/integration/v1/deposits/quote'
  ));
  assert.equal(quote.response.code_to_enter, '*144*4*6*621#');
  const depositOtp = deposit.parameters.find(parameter => parameter.name === 'otp');
  assert.equal(depositOtp.required, false);
  assert.doesNotMatch(depositOtp.description, /PayDunya|AfriBaPay|Mbiyo/i);
  const writeEndpoints = body.endpoints.filter(item => item.method === 'POST');
  assert.equal(writeEndpoints.length, 7);
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
  assert.ok(res.body.toString('ascii').includes('otp'));
  const pdfText = res.body.toString('ascii');
  assert.ok(pdfText.includes('Apres creation, chaque operation garde le meme traitement'));
  assert.ok(pdfText.includes('charged_amount'));
  assert.doesNotMatch(pdfText, /PayDunya|AfriBaPay|Mbiyo/i);
});

