'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const security = require('../src/security.cjs');
const { operationSignature } = require('../src/wallet.cjs');

const sessionSecret = 'synthetic-session-key-not-a-production-secret';
const jwtSecret = 'synthetic-jwt-key-not-a-production-secret';
function oracle(args = [], input) {
  const child = spawnSync('python', [path.join(__dirname, 'python-fixtures.py'), ...args], {
    encoding: 'utf8', input,
    env: { PATH: process.env.PATH, PYTHONPATH: process.env.PYTHONPATH ?? '' },
  });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout;
}
const fixtures = JSON.parse(oracle());

test('existing Python bcrypt passwords remain usable without reset', async () => {
  assert.equal(await security.verifyPassword('Synthetic-password9!', fixtures.password_hash), true);
  assert.equal(await security.verifyPassword('wrong', fixtures.password_hash), false);
  assert.equal(await security.verifyPassword('x'.repeat(73), fixtures.password_hash), false);
});

test('account/purpose-bound PIN pepper is exactly Python-compatible', async () => {
  const material = security.pinMaterial('synthetic-user', '123456', 'user', sessionSecret);
  assert.equal(material, fixtures.user_pin_material);
  assert.equal(await security.verifyPassword(material, fixtures.user_pin_hash), true);
  assert.equal(await security.verifyPassword(material, fixtures.admin_pin_hash), false);
  assert.notEqual(material, security.pinMaterial('other-user', '123456', 'user', sessionSecret));
  assert.throws(() => security.pinMaterial('synthetic-user', '12345', 'user', sessionSecret));
});

test('Python MFA and integration secrets decrypt unchanged', () => {
  assert.equal(security.decryptFernet(fixtures.encrypted_mfa,
    security.fernetKey(sessionSecret)), 'JBSWY3DPEHPK3PXP');
  assert.equal(security.decryptFernet(fixtures.encrypted_integration,
    security.integrationEncryptionKey(sessionSecret)), 'synthetic-webhook-value');
  assert.throws(() => security.decryptFernet(fixtures.encrypted_mfa, crypto.randomBytes(32)));
  const altered = Buffer.from(fixtures.encrypted_mfa, 'base64url');
  altered[30] ^= 1;
  assert.throws(() => security.decryptFernet(altered.toString('base64url'),
    security.fernetKey(sessionSecret)));
});

test('new Node Fernet tokens can be decrypted by existing Python code', () => {
  const token = security.encryptFernet('synthetic-round-trip', security.fernetKey(sessionSecret));
  assert.equal(oracle(['decrypt'], token).trim(), 'synthetic-round-trip');
});

test('TOTP code and replay counter match Python', () => {
  assert.equal(security.totpCode('JBSWY3DPEHPK3PXP', 1700000000), fixtures.totp);
  const counter = Math.floor(1700000000 / 30);
  assert.equal(security.verifyTotp('JBSWY3DPEHPK3PXP', fixtures.totp, null, 1700000000), counter);
  assert.equal(security.verifyTotp('JBSWY3DPEHPK3PXP', fixtures.totp, counter, 1700000000), null);
});

test('Python JWT accepted; expiration, wrong purpose, algorithm and future issue time rejected', () => {
  assert.equal(security.decodeToken(fixtures.token, jwtSecret, { now: 1700000100 }).sub, 'synthetic-user');
  assert.throws(() => security.decodeToken(fixtures.token, jwtSecret, { now: 1700000400 }));
  assert.throws(() => security.decodeToken(fixtures.token, jwtSecret, { now: 1700000100, purpose: 'pin' }));
  assert.throws(() => security.decodeToken(fixtures.token, jwtSecret, { now: 1699999999 }));
  const otherAlgorithm = jwt.sign({ sub: 'x', exp: 1700000300 }, jwtSecret, { algorithm: 'HS384' });
  assert.throws(() => security.decodeToken(otherAlgorithm, jwtSecret, { now: 1700000100 }));
});

test('existing Python financial idempotency signatures are preserved', () => {
  for (const vector of fixtures.signature_vectors) {
    assert.equal(operationSignature({
      userId: 'synthetic-user', direction: 'credit',
      increments: { balance_xof: vector.value },
    }), vector.signature, `signature for ${vector.value}`);
  }
});
