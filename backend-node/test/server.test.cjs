'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createServer } = require('../src/server.cjs');

test('startup refuses unspecified or production data environment', () => {
  for (const environment of ['', 'production']) {
    const child = spawnSync(process.execPath, [path.join(__dirname, '../app.js')], {
      env: { BIZTRANSPAY_MIGRATION_ENV: environment }, encoding: 'utf8',
    });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /Startup blocked/);
  }
});

test('API root is available while diagnostic mode rejects unported business routes', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).migration_complete, false);
    const root = await fetch(`${base}/api/`);
    assert.equal(root.status, 200);
    assert.deepEqual(await root.json(), { message: 'Biz-transPay API', status: 'ok' });
    for (const route of ['/api/auth/login', '/api/transfers', '/api/webhook/afribapay', '/readyz']) {
      const result = await fetch(`${base}${route}`, { method: 'POST' });
      assert.equal(result.status, 503);
      assert.equal((await result.json()).code, 'MIGRATION_INCOMPLETE');
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
