'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../src/server.cjs');

test('Plesk static server serves React routes and assets without swallowing API requests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biztranspay-static-'));
  fs.mkdirSync(path.join(root, 'static', 'js'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<div id="root">app</div>');
  fs.writeFileSync(path.join(root, 'static', 'js', 'main.js'), 'window.app=true;');
  const server = createServer({}, { staticRoot: root });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('cache-control'), /no-cache/);
    assert.equal(await home.text(), '<div id="root">app</div>');

    const route = await fetch(`${base}/transactions/history`);
    assert.equal(route.status, 200);
    assert.equal(await route.text(), '<div id="root">app</div>');

    const asset = await fetch(`${base}/static/js/main.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);
    assert.match(asset.headers.get('cache-control'), /immutable/);
    assert.equal(await asset.text(), 'window.app=true;');

    const missingAsset = await fetch(`${base}/static/js/missing.js`);
    assert.equal(missingAsset.status, 404);
    const api = await fetch(`${base}/api/not-yet-migrated`);
    assert.equal(api.status, 503);
    assert.equal((await api.json()).code, 'MIGRATION_INCOMPLETE');
    const traversal = await fetch(`${base}/%2e%2e%2foutside.txt`);
    assert.equal(traversal.status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
