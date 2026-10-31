'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createTelegramCommandBot, parseTelegramCommand,
} = require('../src/telegram-command-bot.cjs');
const { MySqlStore } = require('../src/mysql-store.cjs');

test('Telegram commands preserve full search text and normalize accents/bot suffixes', () => {
  assert.deepEqual(parseTelegramCommand('/échange@biztrans_bot Jean Dupont'), {
    command: 'exchange', query: 'Jean Dupont',
  });
  assert.deepEqual(parseTelegramCommand('/retrait +228 90 00 11 22'), {
    command: 'withdrawal', query: '+228 90 00 11 22',
  });
});

test('read-only transaction commands authorize the configured chat and mask contacts', async () => {
  const sent = [];
  const queries = [];
  const db = {
    async searchTelegramText(collection, options) {
      queries.push({ collection, options });
      if (collection === 'users') return [{ id: 'user-1' }];
      if (collection === 'transactions') return [{
        id: '<ref-1>', type: 'withdrawal', status: 'completed',
        amount: '500', currency: 'XOF', user_id: 'user-1',
        phone_number: '+228 90 00 11 22', created_at: '2026-10-30T10:00:00Z',
      }];
      return [];
    },
  };
  const bot = createTelegramCommandBot({
    db,
    env: { TELEGRAM_BOT_TOKEN: 'fixture-token', TELEGRAM_CHAT_ID: 'admin-chat' },
    sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return true; },
    logger: { warn() {} },
  });

  await bot.handleMessage({ chat: { id: 7 }, text: '/retrait test' }, 'admin-chat');
  assert.equal(sent.length, 0);
  await bot.handleMessage({
    chat: { id: 'admin-chat' }, text: '/retrait@biztrans_bot +228 90 00 11 22',
  }, 'admin-chat');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /&lt;ref-1&gt;/);
  assert.match(sent[0].text, /••••/);
  assert.doesNotMatch(sent[0].text, /90 00 11 22/);
  assert.equal(queries[0].options.query, '+228 90 00 11 22');
  assert.ok(queries.some(item => item.collection === 'transactions'));
});

test('production polling replaces a stale webhook without dropping pending updates', async () => {
  const calls = [];
  const lockCalls = [];
  let bot;
  const logger = { warn() {} };
  const fetchImpl = async (url, options) => {
    const method = url.split('/').at(-1);
    const payload = JSON.parse(options.body);
    calls.push({ method, payload });
    if (method === 'getWebhookInfo') return {
      ok: true, status: 200, async json() { return { ok: true, result: { url: 'https://private.example/hook' } }; },
    };
    if (method === 'deleteWebhook') return {
      ok: true, status: 200, async json() { return { ok: true, result: true }; },
    };
    if (method === 'setMyCommands') return {
      ok: true, status: 200, async json() { return { ok: true, result: true }; },
    };
    if (method === 'getUpdates') {
      bot.stop();
      return { ok: true, status: 200, async json() { return { ok: true, result: [] }; } };
    }
    throw new Error('unexpected Telegram method');
  };
  bot = createTelegramCommandBot({
    db: {
      pool: {
        async getConnection() {
          return {
            async execute(sql) {
              lockCalls.push(sql);
              return sql.includes('GET_LOCK')
                ? [[{ acquired: 1 }]] : [[{ released: 1 }]];
            },
            release() { lockCalls.push('connection released'); },
            destroy() { lockCalls.push('connection destroyed'); },
          };
        },
      },
    }, env: {
      BIZTRANSPAY_MIGRATION_ENV: 'production',
      TELEGRAM_BOT_TOKEN: 'fixture-token', TELEGRAM_CHAT_ID: 'admin-chat',
    },
    fetchImpl, sendMessage: async () => true, logger,
  });
  assert.equal(bot.start(), true);
  for (let attempt = 0; attempt < 50 && !calls.some(call => call.method === 'getUpdates'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  for (let attempt = 0; attempt < 50 && !lockCalls.includes('connection released'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(calls.map(call => call.method), [
    'getWebhookInfo', 'deleteWebhook', 'setMyCommands', 'getUpdates',
  ]);
  assert.equal(calls.find(call => call.method === 'deleteWebhook').payload.drop_pending_updates, false);
  assert.equal(JSON.stringify(calls).includes('private.example'), false);
  assert.deepEqual(lockCalls, [
    'SELECT GET_LOCK(?, 0) AS acquired', 'SELECT RELEASE_LOCK(?)', 'connection released',
  ]);
});

test('MySQL Telegram search stays parameterized, field-allowlisted, and result-bounded', async () => {
  const calls = [];
  const pool = {
    async execute(sql, params) {
      calls.push({ sql, params });
      return [[{ raw_document: '{"id":"record-1"}' }]];
    },
  };
  const store = new MySqlStore(pool);
  const result = await store.searchTelegramText('transactions', {
    fields: ['reference', 'metadata.phone_number', 'raw_document; DROP TABLE users'],
    query: '%_needle',
    ownerFields: ['user_id'],
    ownerIds: ['user-1'],
    limit: 500,
  });
  assert.deepEqual(result, [{ id: 'record-1' }]);
  assert.match(calls[0].sql, /LIMIT \?/);
  assert.doesNotMatch(calls[0].sql, /DROP TABLE/i);
  assert.ok(calls[0].params.includes('%!%!_needle%'));
  assert.equal(calls[0].params.at(-1), 100);
});
