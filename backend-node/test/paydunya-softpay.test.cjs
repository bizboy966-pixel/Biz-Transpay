'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolvePaydunyaSoftpayOperator,
  paydunyaSoftpayPaymentFlow,
  submitPaydunyaSoftpay,
  localPhone,
} = require('../src/paydunya-softpay.cjs');

const profiles = [
  ['SN', 'orange-money-senegal', 'new-orange-money-senegal'],
  ['SN', 'free-money-senegal', 'free-money-senegal'],
  ['SN', 'expresso-senegal', 'expresso-senegal'],
  ['SN', 'wave-senegal', 'wave-senegal'],
  ['SN', 'wizall-money-senegal', 'wizall-money-senegal'],
  ['CI', 'orange-money-ci', 'orange-money-ci'],
  ['CI', 'mtn-ci', 'mtn-ci'],
  ['CI', 'moov-ci', 'moov-ci'],
  ['CI', 'wave-ci', 'wave-ci'],
  ['BF', 'orange-money-burkina', 'orange-money-burkina'],
  ['BF', 'moov-burkina', 'moov-burkina'],
  ['BJ', 'moov-benin', 'moov-benin'],
  ['BJ', 'mtn-benin', 'mtn-benin'],
  ['BJ', 'celtiis-cash', 'celtiis-cash'],
  ['TG', 't-money-togo', 't-money-togo'],
  ['TG', 'moov-togo', 'moov-togo'],
  ['ML', 'orange-money-mali', 'orange-money-mali'],
  ['ML', 'moov-mali', 'moov-mali'],
  ['CM', 'mtn-cameroun', 'mtn-cameroun'],
  ['SN', 'djamo-sn', 'djamo'],
  ['CI', 'djamo-ci', 'djamo'],
];

test('PayDunya official SoftPay operator aliases resolve to documented endpoints', () => {
  for (const [country, alias, endpoint] of profiles) {
    assert.equal(resolvePaydunyaSoftpayOperator(alias, country)?.endpoint, endpoint, alias);
  }
  assert.equal(resolvePaydunyaSoftpayOperator('mtn-ci', 'SN'), null);
});

test('PayDunya SoftPay flows declare OTP, redirect, address and USSD requirements', () => {
  const orangeCi = paydunyaSoftpayPaymentFlow('orange-ci', 'CI');
  assert.equal(orangeCi.kind, 'ussd');
  assert.equal(orangeCi.ussd_code, '#144*82#');
  assert.equal(orangeCi.otp_required, true);
  assert.equal(orangeCi.before_submit, true);

  const orangeBf = paydunyaSoftpayPaymentFlow('orange-bf', 'BF');
  assert.equal(orangeBf.otp_required, true);
  assert.equal(orangeBf.before_submit, true);

  const wizall = paydunyaSoftpayPaymentFlow('wizall-sn', 'SN');
  assert.equal(wizall.kind, 'otp');
  assert.equal(wizall.before_submit, false);
  assert.equal(wizall.otp_required, true);

  const wave = paydunyaSoftpayPaymentFlow('wave-sn', 'SN');
  assert.equal(wave.kind, 'redirect');

  for (const [country, alias] of [
    ['TG', 'moov-togo'], ['ML', 'orange-mali'], ['ML', 'moov-mali'],
  ]) {
    assert.equal(paydunyaSoftpayPaymentFlow(alias, country).address_required, true);
  }
});

test('PayDunya SoftPay sends documented field names and returns only a trusted redirect', async () => {
  let captured;
  const response = await submitPaydunyaSoftpay({
    mode: 'live',
    endpointSlug: 'wave-sn',
    country: 'SN',
    fullName: 'Test Payer',
    email: 'payer@example.test',
    phone: '+221 770000000',
    paymentToken: 'invoice-token',
    credentials: { master_key: 'master', private_key: 'private', token: 'token' },
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({
        success: true, url: 'https://pay.wave.com/c/checkout?id=abc',
      }) };
    },
  });
  assert.equal(captured.url, 'https://app.paydunya.com/api/v1/softpay/wave-senegal');
  assert.deepEqual(Object.keys(captured.body).sort(), [
    'wave_senegal_email', 'wave_senegal_fullName', 'wave_senegal_payment_token',
    'wave_senegal_phone',
  ].sort());
  assert.equal(captured.body.wave_senegal_phone, '770000000');
  assert.equal(response.redirect_url, 'https://pay.wave.com/c/checkout?id=abc');
});

test('PayDunya SoftPay includes required OTP, wallet and address fields', async () => {
  const calls = [];
  const invoke = async (endpointSlug, country, extras = {}) => submitPaydunyaSoftpay({
    mode: 'live', endpointSlug, country,
    fullName: 'Test Payer', email: 'payer@example.test', phone: '12345678',
    paymentToken: 'invoice-token', credentials: {
      master_key: 'master', private_key: 'private', token: 'token',
    },
    ...extras,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({
        success: true,
        ...(endpointSlug === 'wizall-sn' ? { data: { TransactionID: 'wizall-tx-1' } } : {}),
      }) };
    },
  });
  await invoke('orange-ci', 'CI', { otp: '1234' });
  await invoke('mtn-ci', 'CI');
  await invoke('moov-togo', 'TG', { address: 'Lomé' });
  const wizall = await invoke('wizall-sn', 'SN');
  assert.equal(calls[0].body.orange_money_ci_otp, '1234');
  assert.equal(calls[0].body.payment_token, 'invoice-token');
  assert.equal(calls[1].body.mtn_ci_wallet_provider, 'MTNCI');
  assert.equal(calls[2].body.moov_togo_customer_address, 'Lomé');
  assert.equal(wizall.provider_reference, 'wizall-tx-1');
  assert.equal(wizall.auth_mode, 'otp');
  await assert.rejects(
    invoke('moov-togo', 'TG'),
    error => error.status === 422,
  );
});

test('PayDunya only returns HTTPS redirect URLs from documented payment hosts', async () => {
  await assert.rejects(
    submitPaydunyaSoftpay({
      mode: 'live', endpointSlug: 'wave-sn', country: 'SN',
      fullName: 'Test', email: 'payer@example.test', phone: '770000000',
      paymentToken: 'token',
      credentials: { master_key: 'm', private_key: 'p', token: 't' },
      fetchImpl: async () => ({ ok: true, json: async () => ({
        success: true, url: 'https://malicious.example/collect',
      }) }),
    }),
    error => error.status === 502 && error.outcomeUnknown === true,
  );
});

test('local phone normalization strips only the selected country calling code', () => {
  assert.equal(localPhone('BF', '+226 70 00 00 00'), '70000000');
  assert.equal(localPhone('SN', '+221 77 00 00 00'), '77000000');
  assert.equal(localPhone('SN', '77000000'), '77000000');
});
