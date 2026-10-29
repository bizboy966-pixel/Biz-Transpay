'use strict';

const crypto = require('node:crypto');
const { publicUser, ensurePlatformOwnerRole } = require('./public-user.cjs');
const { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } = require('./session-service.cjs');

function parseCookies(header = '') {
  const values = {};
  for (const part of String(header).split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    try { values[name] = decodeURIComponent(part.slice(separator + 1).trim()); }
    catch { values[name] = ''; }
  }
  return values;
}

function sessionToken(req) {
  const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
  const authorization = String(req.headers.authorization || '');
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
  return cookie || bearer || null;
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function requestPath(req) {
  try { return new URL(req.url, 'http://localhost').pathname; }
  catch { return ''; }
}

function originAllowed(req, trustedOrigins = []) {
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) return false;
  const rawOrigin = req.headers.origin || req.headers.referer;
  if (!rawOrigin) return false;
  let origin;
  try { origin = new URL(rawOrigin).origin; } catch { return false; }
  const allowed = new Set(trustedOrigins.filter(Boolean).map(value => {
    try { return new URL(value.includes('://') ? value : `https://${value}`).origin; }
    catch { return null; }
  }).filter(Boolean));
  for (const host of [req.headers['x-forwarded-host'], req.headers.host]) {
    const firstHost = String(host || '').split(',')[0].trim();
    if (!firstHost) continue;
    const protocol = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    try { allowed.add(new URL(`${protocol}://${firstHost}`).origin); } catch { /* ignored */ }
  }
  return allowed.has(origin);
}

function csrfTrustedOrigins(env = process.env) {
  return [
    ...(env.CSRF_TRUSTED_ORIGINS || '').split(',').map(value => value.trim()),
    ...(env.REPLIT_DOMAINS || '').split(',').map(value => value.trim()),
    env.REPLIT_DEV_DOMAIN,
  ];
}

function verifyCsrf(req, env) {
  const cookies = parseCookies(req.headers.cookie);
  // Bearer-only clients do not use browser cookies and are not exposed to CSRF.
  if (!cookies[SESSION_COOKIE_NAME]) return true;
  if (!originAllowed(req, csrfTrustedOrigins(env))) return false;
  const cookieToken = cookies[CSRF_COOKIE_NAME] || '';
  const headerToken = String(req.headers['x-csrf-token'] || '');
  if (!cookieToken || !headerToken) return false;
  const cookieBytes = Buffer.from(cookieToken);
  const headerBytes = Buffer.from(headerToken);
  return cookieBytes.length === headerBytes.length
    && crypto.timingSafeEqual(cookieBytes, headerBytes);
}

function createAuthSessionRoutes({ db, sessionService, env = process.env }) {
  async function authenticate(req) {
    const token = sessionToken(req);
    if (!token) {
      const error = new Error('Session requise');
      error.status = 401;
      error.code = 'SESSION_REQUIRED';
      throw error;
    }
    return sessionService.authenticate(token);
  }

  return async function handleAuthSession(req, res) {
    const path = requestPath(req);
    const method = String(req.method || 'GET').toUpperCase();
    const isSessionRoute = (
      (path === '/api/auth/me' && method === 'GET')
      || (path === '/api/auth/csrf' && method === 'GET')
      || (path === '/api/auth/logout' && method === 'POST')
      || (path === '/api/auth/session/refresh' && method === 'POST')
    );
    if (!isSessionRoute) return false;
    if (!db || !sessionService) {
      json(res, 503, { detail: 'Routes d’authentification Node indisponibles.', code: 'MIGRATION_INCOMPLETE' });
      return true;
    }
    if (method === 'POST' && !verifyCsrf(req, env)) {
      json(res, 403, { detail: 'Requête CSRF invalide.', code: 'CSRF_REJECTED' });
      return true;
    }

    try {
      const identity = await authenticate(req);
      if (path === '/api/auth/me') {
        let user = await db.collection('users').find_one({ id: identity.userId }, { _id: 0 });
        if (!user) {
          json(res, 401, { detail: 'Utilisateur introuvable.', code: 'SESSION_USER_MISSING' });
          return true;
        }
        user = await ensurePlatformOwnerRole(db, user, {
          platformOwnerEmail: env.PLATFORM_OWNER_EMAIL || '',
          claimBefore: env.PLATFORM_OWNER_CLAIM_BEFORE || '',
        });
        json(res, 200, publicUser(user));
        return true;
      }
      if (path === '/api/auth/csrf') {
        const token = crypto.randomBytes(32).toString('base64url');
        const cookie = `${CSRF_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=86400; Secure; SameSite=Strict`;
        json(res, 200, { csrf_token: token }, { 'Set-Cookie': cookie });
        return true;
      }
      if (path === '/api/auth/logout') {
        const cookies = await sessionService.logout(identity);
        json(res, 200, { ok: true }, { 'Set-Cookie': cookies });
        return true;
      }
      const rotated = await sessionService.rotate(identity, {
        ip: String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim(),
        userAgent: req.headers['user-agent'] || '',
      });
      json(res, 200, { ok: true }, { 'Set-Cookie': rotated.setCookie });
      return true;
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      const detail = error.code
        ? { code: error.code, message: error.message }
        : (status >= 500 ? 'Erreur interne.' : error.message);
      json(res, status, { detail });
      return true;
    }
  };
}

module.exports = {
  createAuthSessionRoutes, parseCookies, sessionToken, originAllowed, verifyCsrf,
};
