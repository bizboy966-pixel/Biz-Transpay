'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createServer } = require('../src/server.cjs');

test('startup refuses unspecified or invalid data environment', () => {
  for (const environment of ['', 'staging']) {
    const child = spawnSync(process.execPath, [path.join(__dirname, '../app.js')], {
      env: { BIZTRANSPAY_MIGRATION_ENV: environment }, encoding: 'utf8',
    });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /Startup blocked/);
  }
});

test('production mode is recognized but fails closed without its MySQL URL', () => {
  const child = spawnSync(process.execPath, [path.join(__dirname, '../app.js')], {
    env: { BIZTRANSPAY_MIGRATION_ENV: 'production', PORT: '5100' }, encoding: 'utf8',
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /Startup failed at mysql-configuration \(MYSQL_URL_REQUIRED\)/);
});

test('Plesk entrypoint accepts production mode but still requires a built frontend', () => {
  const child = spawnSync(process.execPath, [path.join(__dirname, '../../app.js')], {
    env: { BIZTRANSPAY_MIGRATION_ENV: 'production' }, encoding: 'utf8',
  });
  assert.equal(child.status, 1);
  assert.doesNotMatch(child.stderr, /Startup blocked/);
  assert.match(child.stderr, /Frontend build missing|Startup failed at mysql-configuration/);
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
