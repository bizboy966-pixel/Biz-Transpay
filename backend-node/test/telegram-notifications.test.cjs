'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createTelegramNotifier, formatAdminLogin, formatOperationEvent, maskEmail, maskIp,
} = require('../src/telegram-notifications.cjs');

test('administrative login alert masks contact data and escapes HTML', () => {
  const text = formatAdminLogin({
    user: {
      full_name: '<Admin & Owner>',
      username: 'owner',
      email: 'private.person@example.com',
    },
    ip: '203.0.113.45',
    unusual: true,
    detectedAt: '2026-10-29T08:00:00.000Z',
  });
  assert.match(text, /&lt;Admin &amp; Owner&gt;/);
  assert.match(text, /p\*\*\*@example\.com/);
  assert.match(text, /203\.0\.113\.xxx/);
  assert.match(text, /caractéristiques inhabituelles/);
  assert.doesNotMatch(text, /private\.person/);
  assert.doesNotMatch(text, /203\.0\.113\.45/);
  assert.equal(maskEmail('bad-address'), '—');
  assert.equal(maskIp('unknown'), 'inconnue');
});

test('Telegram queue is allowlisted, asynchronous, and disabled outside production', async () => {
  const sent = [];
  const db = {
    collection: name => ({
      async find_one(query) {
        assert.equal(name, 'users');
        assert.equal(query.id, 'admin-1');
        return {
          full_name: 'Admin',
          username: 'admin',
          email: 'admin@example.invalid',
        };
      },
    }),
  };
  const notifier = createTelegramNotifier({
    db,
    env: {
      NODE_ENV: 'production',
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_CHAT_ID: 'test-chat',
    },
    fetchImpl: async (url, options) => {
      sent.push({ url, options });
      return { ok: true };
    },
  });
  assert.equal(notifier.enqueueAdminLogin({
    type: 'deposit_success', userId: 'admin-1',
  }), false);
  assert.equal(notifier.enqueueAdminLogin({
    type: 'admin_login', userId: 'admin-1', ip: '198.51.100.22',
    unusual: false, detectedAt: '2026-10-29T08:00:00.000Z',
  }), true);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /sendMessage$/);
  const payload = JSON.parse(sent[0].options.body);
  assert.equal(payload.chat_id, 'test-chat');
  assert.equal(payload.parse_mode, 'HTML');
  assert.match(payload.text, /198\.51\.100\.xxx/);

  const preview = createTelegramNotifier({
    db,
    env: {
      NODE_ENV: 'development',
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_CHAT_ID: 'test-chat',
    },
    fetchImpl: async () => { throw new Error('must not send in preview'); },
  });
  preview.enqueueAdminLogin({ type: 'admin_login', userId: 'admin-1' });
  await new Promise(resolve => setTimeout(resolve, 10));
});

test('financial Telegram alerts include only allowlisted fields and mask customer contacts', async () => {
  const sent = [];
  const warnings = [];
  const notifier = createTelegramNotifier({
    db: {
      collection: () => ({
        async find_one() { return { full_name: 'Client Example' }; },
      }),
    },
    env: {
      NODE_ENV: 'production',
      BIZTRANSPAY_MIGRATION_ENV: 'production',
      TELEGRAM_BOT_TOKEN: 'fixture-token',
      TELEGRAM_CHAT_ID: 'admin-chat',
    },
    logger: { warn: message => warnings.push(message) },
    fetchImpl: async (url, options) => {
      sent.push({ url, payload: JSON.parse(options.body) });
      return { ok: true, async json() { return { ok: true }; } };
    },
  });
  assert.equal(notifier.enqueueOperationEvent({
    userId: 'user-1',
    type: 'deposit_success',
    data: {
      reference: 'txn-123',
      amount: 500,
      currency: 'XOF',
      phone: '+228 90 00 11 22',
      email: 'client@example.test',
      token: 'must-not-appear',
      provider_payload: { secret: 'must-not-appear' },
    },
  }), true);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.text, /txn-123/);
  assert.match(sent[0].payload.text, /••••/);
  assert.doesNotMatch(sent[0].payload.text, /90 00 11 22|client@example\.test|must-not-appear/);
  assert.deepEqual(warnings, []);
  const safe = formatOperationEvent({
    type: 'withdrawal_success',
    data: { phone: '+225 01 23 45 67' },
  });
  assert.doesNotMatch(safe, /01 23 45 67/);
});
