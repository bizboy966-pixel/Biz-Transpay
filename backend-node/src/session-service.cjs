'use strict';

const crypto = require('node:crypto');
const security = require('./security.cjs');

const SESSION_COOKIE_NAME = 'btp_session';
const CSRF_COOKIE_NAME = 'btp_csrf';
const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;
const SESSION_IDLE_SECONDS = 30 * 60;
const REAUTH_MAX_AGE_SECONDS = 15 * 60;
const MAX_ACTIVE_SESSIONS_PER_USER = 3;

class SessionError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'SessionError';
    this.status = status;
    this.code = code;
  }
}

function sessionTokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function asEpoch(value) {
  const epoch = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(epoch) ? epoch : NaN;
}

function serializeCookie(name, value, maxAge, httpOnly) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Strict${httpOnly ? '; HttpOnly' : ''}`;
}

class SessionService {
  constructor(db, { jwtSecret, now = () => Date.now() } = {}) {
    this.db = db;
    this.jwtSecret = jwtSecret;
    this.now = now;
    this.userQueues = new Map();
  }

  async _serializeUser(userId, action) {
    const previous = this.userQueues.get(userId) || Promise.resolve();
    let release;
    const next = new Promise(resolve => { release = resolve; });
    const queued = previous.then(() => next);
    this.userQueues.set(userId, queued);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (this.userQueues.get(userId) === queued) this.userQueues.delete(userId);
    }
  }

  async issue(userId, {
    ip = '', userAgent = '', adminAuthMethod = 'password',
    userPinRequired = false, userPinAuthenticated = false,
  } = {}) {
    if (!this.jwtSecret) throw new Error('Missing JWT/session signing secret');
    return this._serializeUser(userId, async () => {
      const now = new Date(this.now());
      const sessionId = crypto.randomBytes(32).toString('base64url');
      const token = security.createSessionToken(
        userId, sessionId, this.jwtSecret, Math.floor(now.getTime() / 1000));
      const session = {
        id: sessionId, user_id: userId, token_hash: sessionTokenHash(token),
        created_at: now, last_activity_at: now, last_auth_at: now,
        admin_auth_method: adminAuthMethod,
        user_pin_required: Boolean(userPinRequired),
        user_pin_authenticated: Boolean(userPinAuthenticated),
        expires_at: new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000),
        ip: String(ip).slice(0, 128), user_agent: String(userAgent).slice(0, 300),
      };
      await this.db.collection('sessions').insert_one(session);
      const active = await this.db.collection('sessions').find({
        user_id: userId, revoked_at: { $exists: false },
      }, { _id: 0, id: 1 }).sort([
        ['last_activity_at', -1], ['created_at', -1],
      ]).to_list(MAX_ACTIVE_SESSIONS_PER_USER + 1);
      const staleIds = active.slice(MAX_ACTIVE_SESSIONS_PER_USER)
        .map(item => item.id).filter(Boolean);
      if (staleIds.length) {
        await this.db.collection('sessions').update_many({
          user_id: userId, id: { $in: staleIds }, revoked_at: { $exists: false },
        }, { $set: {
          revoked_at: new Date(this.now()), revocation_reason: 'session_limit',
        } });
      }
      const csrfToken = crypto.randomBytes(32).toString('base64url');
      return {
        sessionId, token, csrfToken, session,
        setCookie: [
          serializeCookie(SESSION_COOKIE_NAME, token, SESSION_MAX_AGE_SECONDS, true),
          serializeCookie(CSRF_COOKIE_NAME, csrfToken, SESSION_MAX_AGE_SECONDS, false),
        ],
      };
    });
  }

  async authenticate(token, { skipUserPinCheck = false } = {}) {
    if (!token) throw new SessionError(401, 'Session requise', 'SESSION_REQUIRED');
    let payload;
    try {
      payload = security.decodeToken(token, this.jwtSecret, {
        now: Math.floor(this.now() / 1000),
      });
    }
    catch { throw new SessionError(401, 'Session invalide', 'SESSION_INVALID'); }
    if (payload.typ !== 'session' || !payload.sid) {
      throw new SessionError(401, 'Session invalide', 'SESSION_INVALID');
    }
    const sessions = this.db.collection('sessions');
    const session = await sessions.find_one({
      id: payload.sid, user_id: payload.sub,
      token_hash: sessionTokenHash(token), revoked_at: { $exists: false },
    }, { _id: 0 });
    if (!session) throw new SessionError(401, 'Session révoquée', 'SESSION_REVOKED');

    const now = this.now();
    if (!skipUserPinCheck && session.user_pin_required === undefined) {
      const user = await this.db.collection('users').find_one(
        { id: payload.sub }, { _id: 0, id: 1, role: 1 });
      const pinRequired = !['admin', 'super_admin'].includes(user?.role);
      await sessions.update_one({ id: session.id }, { $set: { user_pin_required: pinRequired } });
      session.user_pin_required = pinRequired;
    }
    if (!skipUserPinCheck && session.user_pin_required && !session.user_pin_authenticated) {
      throw new SessionError(428, 'Activez votre code PIN obligatoire puis reconnectez-vous.',
        'USER_PIN_REQUIRED');
    }
    const expiresAt = asEpoch(session.expires_at);
    const lastActivity = asEpoch(session.last_activity_at);
    const expired = !Number.isFinite(expiresAt) || expiresAt <= now;
    const idle = !Number.isFinite(lastActivity)
      || lastActivity + SESSION_IDLE_SECONDS * 1000 <= now;
    if (expired || idle) {
      await sessions.update_one({
        id: session.id, revoked_at: { $exists: false },
      }, { $set: { revoked_at: new Date(now), revocation_reason: 'expired' } });
      throw new SessionError(401, 'Session expirée', 'SESSION_EXPIRED');
    }
    await sessions.update_one({ id: session.id }, { $set: { last_activity_at: new Date(now) } });
    session.last_activity_at = new Date(now);
    return { userId: payload.sub, sessionId: session.id, payload, session, token };
  }

  async rotate(authenticated, metadata = {}) {
    const oldSession = authenticated?.session;
    const userId = authenticated?.userId;
    if (!oldSession || !userId) throw new SessionError(401, 'Session requise', 'SESSION_REQUIRED');
    await this.db.collection('sessions').update_one({
      id: authenticated.sessionId, user_id: userId, revoked_at: { $exists: false },
    }, { $set: { revoked_at: new Date(this.now()), revocation_reason: 'rotated' } });
    return this.issue(userId, {
      ip: metadata.ip ?? oldSession.ip,
      userAgent: metadata.userAgent ?? oldSession.user_agent,
      adminAuthMethod: oldSession.admin_auth_method || 'password',
      userPinRequired: Boolean(oldSession.user_pin_required),
      userPinAuthenticated: Boolean(oldSession.user_pin_authenticated),
    });
  }

  async logout(authenticated) {
    if (authenticated?.sessionId && authenticated?.userId) {
      await this.db.collection('sessions').update_one({
        id: authenticated.sessionId, user_id: authenticated.userId,
        revoked_at: { $exists: false },
      }, { $set: { revoked_at: new Date(this.now()), revocation_reason: 'logout' } });
    }
    return [
      `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`,
      `${CSRF_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; SameSite=Strict`,
    ];
  }

  requireRecentAuth(authenticated) {
    const lastAuth = asEpoch(authenticated?.session?.last_auth_at);
    if (!Number.isFinite(lastAuth) || lastAuth + REAUTH_MAX_AGE_SECONDS * 1000 <= this.now()) {
      throw new SessionError(428, 'Réauthentification requise pour cette opération.',
        'REAUTH_REQUIRED');
    }
    return authenticated.userId;
  }
}

module.exports = {
  SessionService, SessionError, sessionTokenHash, SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME, SESSION_MAX_AGE_SECONDS, SESSION_IDLE_SECONDS,
  REAUTH_MAX_AGE_SECONDS, MAX_ACTIVE_SESSIONS_PER_USER,
};
