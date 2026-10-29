'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createTelegramNotifier, formatAdminLogin, maskEmail, maskIp,
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
