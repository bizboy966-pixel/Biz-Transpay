'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPublicConfigRoutes } = require('../src/public-config-routes.cjs');

function setup({
  afriCredentials = false,
  paydunyaReady = true,
  paydunyaModes = {
    softpay_direct: { enabled: true },
    psr: { enabled: false },
    par_redirect: { enabled: false },
  },
} = {}) {
  const settings = [
    {
      id: 'deposit_config',
      mobile_money: {
        enabled: true,
        operators: [
          { country: 'TG', code: 'moov_tg', fee_pct: 1.5, fee_fixed: 10, active: true },
        ],
      },
      crypto: { enabled: true, fees: { USDT: 2 }, hidden_coins: ['BTC'] },
    },
    {
      id: 'payment_provider_paydunya',
      enabled: true,
      ...(paydunyaReady ? {
        master_key_encrypted: 'private-key',
        private_key_encrypted: 'private-key',
        token_encrypted: 'private-token',
        modes: paydunyaModes,
      } : { master_key_encrypted: 'private-key' }),
      catalog: [
        { country: 'TG', country_label: 'Togo', code: 'moov_tg', name: 'Moov Togo', currency: 'XOF', active: true, payment_flow: { kind: 'ussd' } },
        { country: 'TG', code: 'orange_tg', name: 'Orange Togo', currency: 'XOF', active: false },
      ],
    },
    {
      id: 'payment_provider_mbiyo',
      enabled: true, api_key_encrypted: 'private-api-key',
      webhook_secret_encrypted: 'private-webhook-secret',
      catalog: [
        { country: 'BF', country_label: 'Burkina Faso', code: 'mbiyo_moov', name: 'Moov Burkina', currency: 'XOF', active: true },
      ],
    },
    {
      id: 'payment_provider_afribapay',
      enabled: true, api_key_encrypted: 'private-afri-key',
      catalog: [
        { country: 'BF', code: 'afribapay_moov', name: 'Moov Burkina', currency: 'XOF', active: true },
        { country: 'CM', code: 'orange_cm', name: 'Orange Cameroun', currency: 'XAF', active: true },
        { country: 'TD', code: 'airtel_td', public_code: 'airtel_td', operator: 'airtel', name: 'Airtel Money Tchad', currency: 'XAF', active: true },
        { country: 'TD', code: 'moov_td', public_code: 'moov_td', operator: 'moov', name: 'Moov Money Tchad', currency: 'XAF', active: true },
        { country: 'TD', code: 'wrong_currency_td', public_code: 'wrong_currency_td', name: 'Route invalide', currency: 'XOF', active: true },
      ],
      ...(afriCredentials ? {
        api_user_encrypted: 'encrypted-user',
        merchant_key_encrypted: 'encrypted-merchant',
        agent_id_encrypted: 'encrypted-agent',
        mode: 'sandbox',
      } : {}),
    },
    {
      id: 'transfer_config',
      crypto: { fees: { USDT: 3 }, fees_gateway: { USDT: 1 }, fees_platform: { USDT: 2 } },
    },
  ];
  const db = {
    collection(name) {
      assert.equal(name, 'settings');
      return {
        async find_one(query) {
          return structuredClone(settings.find(item => item.id === query.id) || null);
        },
      };
    },
  };
  const service = createPublicConfigRoutes({ db, env: {} });
  return service;
}

function response() {
  return {
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
}

async function call(service, path) {
  const res = response();
  const handled = await service.handleRoute({ method: 'GET', url: path }, res);
  return { handled, status: res.status, body: res.body };
}

test('deposit config returns grouped active catalogs, fees and the public-link provider subset', async () => {
  const service = setup();
  const dashboard = await call(service, '/api/deposits/config');
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.mobile_money_enabled, true);
  assert.equal(dashboard.body.catalog.length, 2);
  assert.equal(dashboard.body.catalog.some(country => country.country === 'BF'), true);
  const togo = dashboard.body.catalog.find(country => country.country === 'TG');
  assert.equal(togo.operators[0].fee_pct, 1.5);
  assert.equal(togo.operators[0].fee_fixed, 10);
  assert.equal(togo.operators[0].payment_flow.kind, 'ussd');
  assert.equal(dashboard.body.crypto.fees.USDT, 2);
  assert.equal(JSON.stringify(dashboard.body).includes('private-key'), false);
  assert.equal(dashboard.body.catalog.some(country => country.country === 'CM'), false);

  const link = await call(service, '/api/deposits/config?surface=public_link');
  assert.deepEqual(link.body.catalog.map(country => country.country), ['TG', 'BF']);
  assert.equal(link.body.catalog.flatMap(country => country.operators)
    .some(operator => operator.code.startsWith('afribapay_')), false);
});

test('AfriBaPay dashboard routes appear only with all credentials and a valid configured API host', async () => {
  const service = setup({ afriCredentials: true });
  const dashboard = await call(service, '/api/deposits/config');
  assert.equal(dashboard.body.catalog.some(country => country.country === 'CM'), true);
  const chad = dashboard.body.catalog.find(country => country.country === 'TD');
  assert.deepEqual(chad.operators.map(operator => operator.code).sort(), ['airtel_td', 'moov_td']);
  assert.equal(chad.operators.every(operator => operator.currency === 'XAF'), true);
});

test('dashboard hides PayDunya routes without a complete supported payment setup', async () => {
  const service = setup({ paydunyaReady: false });
  const dashboard = await call(service, '/api/deposits/config');
  assert.equal(dashboard.body.catalog.some(country => country.country === 'TG'), false);
});

test('dashboard shows Pay Junior operators with the default SoftPay direct mode', async () => {
  const service = setup();
  const dashboard = await call(service, '/api/deposits/config');

  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.catalog.some(country => country.country === 'TG'), true);
});

test('dashboard keeps ambiguous PSR/PAR-only setup hidden rather than choosing a flow', async () => {
  const service = setup({
    paydunyaModes: {
      softpay_direct: { enabled: false },
      psr: { enabled: true },
      par_redirect: { enabled: true },
    },
  });
  const dashboard = await call(service, '/api/deposits/config');

  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.catalog.some(country => country.country === 'TG'), false);
});

test('Pay Junior and AfriBaPay catalogs can be available at the same time', async () => {
  const service = setup({ afriCredentials: true });
  const dashboard = await call(service, '/api/deposits/config');
  const operators = dashboard.body.catalog.flatMap(country => country.operators);

  assert.equal(dashboard.status, 200);
  assert.equal(operators.some(operator => operator.code === 'moov_tg'), true);
  assert.equal(operators.some(operator => operator.code === 'orange_cm'), true);
});

test('deposit config rejects unknown surfaces', async () => {
  const service = setup();
  const invalid = await call(service, '/api/deposits/config?surface=admin');
  assert.equal(invalid.status, 422);
});
