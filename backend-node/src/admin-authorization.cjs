'use strict';

const net = require('node:net');
const crypto = require('node:crypto');
const { sessionToken } = require('./auth-session-routes.cjs');
const {
  ROLE_PERMISSIONS, effectiveRole, isAdminAccount, ensurePlatformOwnerRole,
} = require('./public-user.cjs');
const { REAUTH_MAX_AGE_SECONDS } = require('./session-service.cjs');

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function parseIp(value) {
  const address = String(value || '').trim().toLowerCase().split('%')[0];
  const version = net.isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    let numericValue = 0n;
    for (const octet of octets) numericValue = (numericValue << 8n) | BigInt(octet);
    return { version: 4, bits: 32, value: numericValue };
  }
  if (version !== 6) return null;

  const ipv4Tail = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address)?.[1];
  let normalized = address;
  if (ipv4Tail) {
    const octets = ipv4Tail.split('.').map(Number);
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${address.slice(0, address.length - ipv4Tail.length)}${high}:${low}`;
  }
  const sides = normalized.split('::');
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides.length === 2 && sides[1] ? sides[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((sides.length === 1 && missing !== 0) || (sides.length === 2 && missing < 1)) return null;
  const groups = sides.length === 2
    ? [...left, ...Array(missing).fill('0'), ...right]
    : left;
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  let numericValue = 0n;
  for (const group of groups) numericValue = (numericValue << 16n) | BigInt(parseInt(group, 16));
  // Normalize IPv4-mapped IPv6 so an IPv4 allowlist entry matches Node's
  // common ::ffff:127.0.0.1 remote address representation.
  if ((numericValue >> 32n) === 0xffffn) {
    return { version: 4, bits: 32, value: numericValue & 0xffffffffn };
  }
  return { version: 6, bits: 128, value: numericValue };
}

function ipMatchesRule(address, rule) {
  const parsedAddress = parseIp(address);
  if (!parsedAddress) return false;
  const raw = String(rule || '').trim();
  const slash = raw.lastIndexOf('/');
  const networkText = slash < 0 ? raw : raw.slice(0, slash);
  const network = parseIp(networkText);
  if (!network || network.version !== parsedAddress.version) return false;
  let prefix = parsedAddress.bits;
  if (slash >= 0) {
    if (!/^\d{1,3}$/.test(raw.slice(slash + 1))) return false;
    prefix = Number(raw.slice(slash + 1));
    if (prefix < 0 || prefix > parsedAddress.bits) return false;
  }
  const shift = BigInt(parsedAddress.bits - prefix);
  return (parsedAddress.value >> shift) === (network.value >> shift);
}

function requestIp(req, env) {
  if (String(env.ADMIN_TRUST_PROXY_HEADERS || '').toLowerCase() === 'true') {
    const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',', 1)[0].trim();
    if (forwarded) return forwarded;
    const realIp = String(req.headers?.['x-real-ip'] || '').trim();
    if (realIp) return realIp;
  }
  return req.socket?.remoteAddress || '';
}

function isAdminIpAllowed(req, env = process.env) {
  const rules = String(env.ADMIN_ALLOWED_IPS || '').split(',').map(item => item.trim()).filter(Boolean);
  if (!rules.length) return true;
  const candidate = requestIp(req, env);
  return rules.some(rule => ipMatchesRule(candidate, rule));
}

async function writeAdminAudit(db, { admin, userId, req, ip, action, allowed, permission, error }) {
  await db.collection('admin_logs').insert_one({
    id: crypto.randomUUID(),
    admin_id: admin?.id || userId || null,
    admin_username: admin?.username || null,
    action: allowed ? action : 'admin_access_denied',
    target_user_id: null,
    target_username: null,
    details: {
      path: new URL(req.url || '/', 'http://localhost').pathname,
      method: String(req.method || '').toUpperCase(),
      permission,
      allowed,
      ...(error ? { reason: error.code || `HTTP_${error.status || 500}` } : {}),
    },
    ip: String(ip || '').slice(0, 128),
    created_at: new Date().toISOString(),
  });
}

async function authorizeAdmin(req, {
  db, sessionService, env = process.env, permission, action = 'admin_read',
  sensitive = false,
}) {
  let authenticated = null;
  let admin = null;
  let userId = null;
  const ip = requestIp(req, env);
  let failure = null;

  try {
    if (!isAdminIpAllowed(req, env)) {
      throw httpError(403, 'Accès administrateur refusé depuis cette adresse IP', 'ADMIN_IP_DENIED');
    }
    authenticated = await sessionService.authenticate(sessionToken(req));
    userId = authenticated.userId;
    admin = await db.collection('users').find_one({ id: userId }, { _id: 0 });
    if (!admin) throw httpError(401, 'Non autorisé', 'ADMIN_SESSION_INVALID');
    admin = await ensurePlatformOwnerRole(db, admin, {
      platformOwnerEmail: env.PLATFORM_OWNER_EMAIL || '',
      claimBefore: env.PLATFORM_OWNER_CLAIM_BEFORE || '',
    });
    if (!isAdminAccount(admin)) {
      throw httpError(403, 'Accès administrateur requis', 'ADMIN_REQUIRED');
    }
    if (!admin.two_fa_enabled) {
      throw httpError(403, 'MFA obligatoire pour accéder à l’administration.', 'ADMIN_MFA_REQUIRED');
    }
    const panelUnlockedAt = authenticated.session?.admin_panel_unlocked_at instanceof Date
      ? authenticated.session.admin_panel_unlocked_at.getTime()
      : Date.parse(authenticated.session?.admin_panel_unlocked_at);
    if (!Number.isFinite(panelUnlockedAt)
        || panelUnlockedAt + REAUTH_MAX_AGE_SECONDS * 1000 <= Date.now()) {
      throw httpError(
        428,
        'Confirmez votre identité avec l’authentificateur pour ouvrir le panneau.',
        'ADMIN_PANEL_MFA_REQUIRED',
      );
    }
    const role = effectiveRole(admin);
    const permissions = ROLE_PERMISSIONS[role] || [];
    if (!permissions.includes('*') && !permissions.includes(permission)) {
      throw httpError(403, `Permission requise : ${permission}`, 'ADMIN_PERMISSION_REQUIRED');
    }
    if (sensitive) {
      sessionService.requireRecentAuth(authenticated);
      if (authenticated.session?.admin_auth_method !== 'totp') {
        throw httpError(
          428,
          'Confirmez cette action sensible avec votre mot de passe et l’authentificateur.',
          'REAUTH_REQUIRED',
        );
      }
    }
    admin = { ...admin, _effective_role: role, _permissions: [...permissions].sort() };
  } catch (error) {
    failure = error.status ? error : httpError(500, 'Erreur interne.');
    if (userId && !admin) {
      try {
        admin = await db.collection('users').find_one({ id: userId }, { _id: 0, username: 1 });
      } catch { /* retain the denial and do not expose storage failures */ }
    }
  }

  try {
    await writeAdminAudit(db, {
      admin, userId, req, ip, action, allowed: !failure, permission, error: failure,
    });
  } catch {
    if (!failure) throw httpError(503, 'La journalisation administrateur est indisponible.');
  }
  if (failure) throw failure;
  return { admin, authenticated, ip };
}

module.exports = {
  authorizeAdmin, isAdminIpAllowed, ipMatchesRule, parseIp, requestIp,
};
