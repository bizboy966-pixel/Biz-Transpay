'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPublicConfigRoutes } = require('../src/public-config-routes.cjs');

function setup() {
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
      enabled: true, master_key_encrypted: 'private-key',
      catalog: [
        { country: 'TG', country_label: 'Togo', code: 'moov_tg', name: 'Moov Togo', currency: 'XOF', active: true, payment_flow: { kind: 'ussd' } },
        { country: 'TG', code: 'orange_tg', name: 'Orange Togo', currency: 'XOF', active: false },
      ],
    },
    {
      id: 'payment_provider_mbiyo',
      enabled: true, api_key_encrypted: 'private-api-key',
      catalog: [
        { country: 'BF', country_label: 'Burkina Faso', code: 'mbiyo_moov', name: 'Moov Burkina', currency: 'XOF', active: true },
      ],
    },
    {
      id: 'payment_provider_afribapay',
      enabled: true, api_key_encrypted: 'private-afri-key',
      catalog: [
        { country: 'BF', code: 'afribapay_moov', name: 'Moov Burkina', currency: 'XOF', active: true },
      ],
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
  const togo = dashboard.body.catalog.find(country => country.country === 'TG');
  assert.equal(togo.operators[0].fee_pct, 1.5);
  assert.equal(togo.operators[0].fee_fixed, 10);
  assert.equal(togo.operators[0].payment_flow.kind, 'ussd');
  assert.equal(dashboard.body.crypto.fees.USDT, 2);
  assert.equal(JSON.stringify(dashboard.body).includes('private-key'), false);

  const link = await call(service, '/api/deposits/config?surface=public_link');
  assert.deepEqual(link.body.catalog.map(country => country.country), ['TG', 'BF']);
  assert.equal(link.body.catalog.flatMap(country => country.operators)
    .some(operator => operator.code.startsWith('afribapay_')), false);
});

test('deposit config rejects unknown surfaces', async () => {
  const service = setup();
  const invalid = await call(service, '/api/deposits/config?surface=admin');
  assert.equal(invalid.status, 422);
});
