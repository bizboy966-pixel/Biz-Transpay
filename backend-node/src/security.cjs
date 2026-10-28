'use strict';

// Compatibility primitives only. No login/session route is enabled by these helpers.
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

function requireSecret(value) {
  if (typeof value !== 'string' || !value) throw new Error('Missing security secret');
  return value;
}

function fernetKey(sessionSecret) {
  return crypto.createHash('sha256').update(requireSecret(sessionSecret)).digest();
}

function pinMaterial(userId, pin, purpose, sessionSecret) {
  if (!/^[0-9]{6}$/.test(pin) || !['admin', 'user'].includes(purpose)) {
    throw new Error('Invalid PIN');
  }
  // Python HMAC uses the URL-safe BASE64 key bytes, NOT the decoded AES key.
  const pepper = fernetKey(sessionSecret).toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_');
  return crypto.createHmac('sha256', pepper)
    .update(`${purpose}-login-pin:${userId}:${pin}`).digest('hex');
}

async function verifyPassword(password, hash) {
  try {
    if (typeof password !== 'string' || typeof hash !== 'string'
        || Buffer.byteLength(password, 'utf8') > 72) return false;
    return await bcrypt.compare(password, hash);
  } catch { return false; }
}

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    throw new Error('Invalid encrypted token');
  }
  return Buffer.from(value, 'base64url');
}

function decryptFernet(token, key) {
  const bytes = decodeBase64Url(token);
  const decodedKey = typeof key === 'string' ? decodeBase64Url(key) : key;
  if (!Buffer.isBuffer(decodedKey) || decodedKey.length !== 32
      || bytes.length < 73 || bytes[0] !== 0x80
      || (bytes.length - 57) % 16 !== 0) throw new Error('Invalid encrypted token');
  const body = bytes.subarray(0, -32);
  const expected = crypto.createHmac('sha256', decodedKey.subarray(0, 16))
    .update(body).digest();
  if (!crypto.timingSafeEqual(expected, bytes.subarray(-32))) {
    throw new Error('Invalid encrypted token');
  }
  const decipher = crypto.createDecipheriv(
    'aes-128-cbc', decodedKey.subarray(16), bytes.subarray(9, 25));
  return Buffer.concat([decipher.update(bytes.subarray(25, -32)), decipher.final()])
    .toString('utf8');
}

function encryptFernet(plaintext, key, now = Math.floor(Date.now() / 1000)) {
  const decodedKey = typeof key === 'string' ? decodeBase64Url(key) : key;
  if (!Buffer.isBuffer(decodedKey) || decodedKey.length !== 32) throw new Error('Invalid key');
  const header = Buffer.alloc(9);
  header[0] = 0x80;
  header.writeBigUInt64BE(BigInt(now), 1);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-cbc', decodedKey.subarray(16), iv);
  const body = Buffer.concat([header, iv, cipher.update(plaintext, 'utf8'), cipher.final()]);
  const signature = crypto.createHmac('sha256', decodedKey.subarray(0, 16)).update(body).digest();
  return Buffer.concat([body, signature]).toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_');
}

function integrationEncryptionKey(sessionSecret) {
  return crypto.createHash('sha256')
    .update(`biz-transpay:secrets-encryption:${requireSecret(sessionSecret)}`).digest();
}

function decodeBase32(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const text = String(secret).toUpperCase().replace(/=+$/, '');
  if (!text || /[^A-Z2-7]/.test(text)) throw new Error('Invalid TOTP secret');
  let bits = 0; let accumulator = 0; const result = [];
  for (const char of text) {
    accumulator = (accumulator << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      result.push((accumulator >>> bits) & 255);
      accumulator &= (1 << bits) - 1;
    }
  }
  return Buffer.from(result);
}

function totpCode(secret, timestamp) {
  const counter = Math.floor(timestamp / 30);
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('Invalid TOTP time');
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

function verifyTotp(secret, code, lastCounter = null, now = Date.now() / 1000) {
  const normalized = String(code).replace(/[^0-9]/g, '');
  if (normalized.length !== 6) return null;
  const current = Math.floor(now / 30);
  for (const counter of [current - 1, current, current + 1]) {
    if (counter < 0 || (lastCounter !== null && counter <= lastCounter)) continue;
    if (crypto.timingSafeEqual(Buffer.from(totpCode(secret, counter * 30)),
      Buffer.from(normalized))) return counter;
  }
  return null;
}

function decodeToken(token, secret, { purpose, now } = {}) {
  // Explicit allowlist; never accept algorithm selection from the token header.
  const payload = jwt.verify(token, requireSecret(secret), {
    algorithms: ['HS256'], ...(now === undefined ? {} : { clockTimestamp: now }),
  });
  if (!payload || typeof payload !== 'object' || typeof payload.sub !== 'string'
      || typeof payload.exp !== 'number') throw new Error('Invalid token');
  if (payload.iat !== undefined && (!Number.isFinite(payload.iat)
      || payload.iat > (now ?? Date.now() / 1000))) throw new Error('Invalid token issue time');
  if (purpose !== undefined && payload.purpose !== purpose) throw new Error('Invalid token purpose');
  return payload;
}

module.exports = {
  fernetKey, pinMaterial, verifyPassword, decryptFernet, encryptFernet,
  integrationEncryptionKey, totpCode, verifyTotp, decodeToken,
};
