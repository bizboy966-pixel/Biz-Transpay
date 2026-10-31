'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  requestAfriBaPayOtp,
  submitAfriBaPayin,
  afribapayPaymentFlow,
} = require('../src/afribapay-payin.cjs');

const config = {
  apiUser: 'test-user',
  apiKey: 'test-api-key',
  merchantKey: 'test-merchant-key',
  baseUrl: 'https://api-sandbox.afribapay.com',
};

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test('AfriBaPay Wigli Dicash OTP flow matches the documented two-step sequence', async () => {
  const calls = [];
  const result = await requestAfriBaPayOtp({
    config,
    payload: {
      operator: 'BF:wligdicash', country: 'BF', phone_number: '04090000',
      amount: 500, currency: 'XOF',
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1
        ? jsonResponse({ data: { access_token: 'temporary-test-token' } })
        : jsonResponse({ data: {
          message: 'OTP sent. Please check your phone.',
          status: 'SUCCESS',
          code: 200,
        } });
    },
  });

  assert.deepEqual(result, { sent: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${config.baseUrl}/v1/token`);
  assert.equal(calls[1].url, `${config.baseUrl}/v1/pay/otp`);
  assert.equal(calls[1].options.headers.authorization, 'Bearer temporary-test-token');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    operator: 'wligdicash',
    country: 'BF',
    phone_number: '04090000',
    amount: 500,
    currency: 'XOF',
    merchant_key: config.merchantKey,
  });
});

test('AfriBaPay requests OTP only for the documented Burkina Faso Wigli Dicash route', async () => {
  let called = false;
  await assert.rejects(
    requestAfriBaPayOtp({
      config,
      payload: {
        operator: 'orange', country: 'SN', phone_number: '77000000',
        amount: 500, currency: 'XOF',
      },
      fetchImpl: async () => { called = true; return jsonResponse({}); },
    }),
    error => error.status === 422,
  );
  assert.equal(called, false);
});

test('AfriBaPay public flows explain Wigli OTP and Wave redirection', () => {
  const otp = afribapayPaymentFlow({ country: 'BF', operator: 'wligdicash' });
  assert.equal(otp.otp_request_before_submit, true);
  assert.equal(otp.otp_required, true);
  assert.equal(otp.before_submit, true);

  const wave = afribapayPaymentFlow({ country: 'SN', operator: 'wave' });
  assert.equal(wave.kind, 'redirect');
});

test('AfriBaPay payin sends the supplied OTP without storing it in the response', async () => {
  const calls = [];
  await submitAfriBaPayin({
    config,
    payload: {
      operator: 'wligdicash',
      country: 'BF',
      phone_number: '04090000',
      amount: 500,
      currency: 'XOF',
      otp_code: '987654',
      order_id: 'order-test',
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1
        ? jsonResponse({ data: { access_token: 'temporary-test-token' } })
        : jsonResponse({ success: true, data: { status: 'PENDING', transaction_id: 'tx-test' } });
    },
  });
  assert.equal(calls[1].url, `${config.baseUrl}/v1/pay/payin`);
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.otp_code, '987654');
  assert.equal(body.merchant_key, config.merchantKey);
});
