'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const security = require('../src/security.cjs');
const { operationSignature } = require('../src/wallet.cjs');
const fixtures = require('./legacy-security-fixtures.cjs');

const sessionSecret = 'synthetic-session-key-not-a-production-secret';
const jwtSecret = 'synthetic-jwt-key-not-a-production-secret';

test('existing bcrypt password hashes remain usable without reset', async () => {
  assert.equal(await security.verifyPassword('Synthetic-password9!', fixtures.password_hash), true);
  assert.equal(await security.verifyPassword('wrong', fixtures.password_hash), false);
  assert.equal(await security.verifyPassword('x'.repeat(73), fixtures.password_hash), false);
});

test('account/purpose-bound PIN pepper matches the persisted compatibility vector', async () => {
  const material = security.pinMaterial('synthetic-user', '123456', 'user', sessionSecret);
  assert.equal(material, fixtures.user_pin_material);
  assert.equal(await security.verifyPassword(material, fixtures.user_pin_hash), true);
  assert.equal(await security.verifyPassword(material, fixtures.admin_pin_hash), false);
  assert.notEqual(material, security.pinMaterial('other-user', '123456', 'user', sessionSecret));
  assert.throws(() => security.pinMaterial('synthetic-user', '12345', 'user', sessionSecret));
  const hashed = await security.hashPin('synthetic-user', '123456', 'user', sessionSecret);
  assert.equal(await security.verifyPin('synthetic-user', '123456', 'user', hashed, sessionSecret), true);
  assert.equal(await security.verifyPin('synthetic-user', '123455', 'user', hashed, sessionSecret), false);
});

test('persisted MFA and integration secrets decrypt unchanged', () => {
  assert.equal(security.decryptFernet(fixtures.encrypted_mfa,
    security.fernetKey(sessionSecret)), 'JBSWY3DPEHPK3PXP');
  assert.equal(security.decryptFernet(fixtures.encrypted_integration,
    security.integrationEncryptionKey(sessionSecret)), 'synthetic-webhook-value');
  assert.equal(security.decryptFernet(fixtures.encrypted_explicit_integration,
    security.integrationEncryptionKey(sessionSecret, fixtures.explicit_integration_key)),
  'synthetic-explicit-value');
  assert.throws(() => security.decryptFernet(fixtures.encrypted_mfa, crypto.randomBytes(32)));
  const altered = Buffer.from(fixtures.encrypted_mfa, 'base64url');
  altered[30] ^= 1;
  assert.throws(() => security.decryptFernet(altered.toString('base64url'),
    security.fernetKey(sessionSecret)));
});

test('new Fernet tokens round-trip with the persisted key', () => {
  const token = security.encryptFernet('synthetic-round-trip', security.fernetKey(sessionSecret));
  assert.equal(security.decryptFernet(token, security.fernetKey(sessionSecret)), 'synthetic-round-trip');
});

test('TOTP code and replay counter match the persisted compatibility vector', () => {
  assert.equal(security.totpCode('JBSWY3DPEHPK3PXP', 1700000000), fixtures.totp);
  const counter = Math.floor(1700000000 / 30);
  assert.equal(security.verifyTotp('JBSWY3DPEHPK3PXP', fixtures.totp, null, 1700000000), counter);
  assert.equal(security.verifyTotp('JBSWY3DPEHPK3PXP', fixtures.totp, counter, 1700000000), null);
});

test('legacy JWT accepted; expiration, wrong purpose, algorithm and future issue time rejected', () => {
  assert.equal(security.decodeToken(fixtures.token, jwtSecret, { now: 1700000100 }).sub, 'synthetic-user');
  assert.throws(() => security.decodeToken(fixtures.token, jwtSecret, { now: 1700000400 }));
  assert.throws(() => security.decodeToken(fixtures.token, jwtSecret, { now: 1700000100, purpose: 'pin' }));
  assert.throws(() => security.decodeToken(fixtures.token, jwtSecret, { now: 1699999999 }));
  const otherAlgorithm = jwt.sign({ sub: 'x', exp: 1700000300 }, jwtSecret, { algorithm: 'HS384' });
  assert.throws(() => security.decodeToken(otherAlgorithm, jwtSecret, { now: 1700000100 }));
});

test('password policies match the persisted fixtures, including admin minimum', () => {
  const values = ['', 'abc', 'Synthetic-password9!', 'NoDigits!', '123456aA!',
    'abcdefghijklmnA1!', `${'A'.repeat(73)}a1!`];
  for (let i = 0; i < values.length; i += 1) {
    assert.deepEqual(security.passwordPolicyErrors(values[i]), fixtures.password_policy[i].user);
    assert.deepEqual(security.passwordPolicyErrors(values[i], true), fixtures.password_policy[i].admin);
  }
});

test('Node session and MFA JWTs retain the established claim shapes', () => {
  const now = 1700000000;
  const session = security.createSessionToken('synthetic-user', 'synthetic-session', jwtSecret, now);
  const payload = security.decodeToken(session, jwtSecret, { now: now + 1 });
  assert.deepEqual(
    { sub: payload.sub, sid: payload.sid, typ: payload.typ, iat: payload.iat, exp: payload.exp },
    { sub: 'synthetic-user', sid: 'synthetic-session', typ: 'session', iat: now, exp: now + 168 * 3600 },
  );
  const challenge = security.createMfaToken('synthetic-user', 'login_mfa',
    { pin_version: 'synthetic-version' }, jwtSecret, now);
  assert.deepEqual(security.decodeMfaToken(challenge, jwtSecret, 'login_mfa', now + 1).pin_version,
    'synthetic-version');
  assert.throws(() => security.decodeMfaToken(challenge, jwtSecret, 'user_login_pin', now + 1));
});

test('existing financial idempotency signatures are preserved', () => {
  for (const vector of fixtures.signature_vectors) {
    assert.equal(operationSignature({
      userId: 'synthetic-user', direction: 'credit',
      increments: { balance_xof: vector.value },
    }), vector.signature, `signature for ${vector.value}`);
  }
});
