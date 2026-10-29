'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
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

test('production startup exposes safe diagnostics and blocks business APIs when MySQL is missing', async () => {
  const portServer = net.createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const child = spawn(process.execPath, [path.join(__dirname, '../../app.js')], {
    env: {
      ...process.env,
      BIZTRANSPAY_MIGRATION_ENV: 'production',
      MYSQL_DATABASE_URL: '',
      SESSION_SECRET: 'test-only-session-secret-not-for-production',
      JWT_SECRET: 'test-only-jwt-secret-not-for-production',
      CLOUDFLARE_TURNSTILE_SITE_KEY: '',
      CLOUDFLARE_TURNSTILE_SECRET_KEY: '',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try {
    let health;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (child.exitCode !== null) break;
      try {
        health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(300) });
        if (health.ok) break;
      } catch { /* wait for the diagnostic listener */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(health?.ok, `diagnostic server did not start: ${output}`);
    assert.deepEqual(await health.json(), {
      backend: 'ok',
      database: 'not_configured',
      issue: 'mysql_url_missing',
      schema_complete: false,
      schema_status: 'not_checked',
      migration_complete: false,
    });

    const auth = await fetch(`${base}/api/auth/login`, { method: 'POST' });
    assert.equal(auth.status, 503);
    assert.equal((await auth.json()).detail.code, 'BACKEND_NOT_READY');

    const turnstile = await fetch(`${base}/api/security/turnstile-config`);
    assert.equal(turnstile.status, 200);
    assert.deepEqual(await turnstile.json(), { enabled: false, site_key: null });
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) {
      await new Promise(resolve => child.once('exit', resolve));
    }
  }
});

test('API root is available while diagnostic mode rejects unported business routes', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      backend: 'ok',
      database: 'not_configured',
      schema_complete: false,
      schema_status: 'not_checked',
      migration_complete: false,
    });
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

test('health endpoint checks MySQL and returns no connection details', async () => {
  for (const scenario of [
    {
      healthCheck: async () => true,
      database: 'connected',
      schemaStatus: 'complete',
    },
    {
      healthCheck: async () => { throw new Error('private database failure detail'); },
      database: 'unavailable',
      schemaStatus: 'unavailable',
    },
  ]) {
    const server = createServer(
      { db: { healthCheck: scenario.healthCheck } },
      { healthState: { schemaStatus: 'complete' } },
    );
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body, {
        backend: 'ok',
        database: scenario.database,
        ...(scenario.database === 'unavailable' ? { issue: 'mysql_ping_failed' } : {}),
        schema_complete: scenario.schemaStatus === 'complete',
        schema_status: scenario.schemaStatus,
        migration_complete: false,
      });
      assert.doesNotMatch(JSON.stringify(body), /private database failure detail/);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
});

test('startup diagnostic reports incomplete schema and safely gates APIs', async () => {
  const server = createServer({
    env: {
      CLOUDFLARE_TURNSTILE_SITE_KEY: 'public-site-key',
      CLOUDFLARE_TURNSTILE_SECRET_KEY: 'server-secret',
    },
  }, {
    healthState: { database: 'schema_incomplete', issue: 'required_tables_missing' },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      backend: 'ok',
      database: 'schema_incomplete',
      issue: 'required_tables_missing',
      schema_complete: false,
      schema_status: 'incomplete',
      migration_complete: false,
    });

    const auth = await fetch(`${base}/api/auth/register`, { method: 'POST' });
    assert.equal(auth.status, 503);
    assert.equal((await auth.json()).detail.code, 'BACKEND_NOT_READY');

    const turnstile = await fetch(`${base}/api/security/turnstile-config`);
    assert.equal(turnstile.status, 200);
    assert.deepEqual(await turnstile.json(), {
      enabled: true,
      site_key: 'public-site-key',
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
