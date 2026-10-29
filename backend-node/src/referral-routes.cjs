'use strict';

const { sessionToken } = require('./auth-session-routes.cjs');

const REQUIRED_REFERRALS = 5;
const REFERRAL_CLAIM_PREFIX = 'referral:';
const USER_PROJECTION = {
  _id: 0,
  id: 1,
  kyc_status: 1,
  status: 1,
  banned: 1,
  is_banned: 1,
  blocked: 1,
  is_blocked: 1,
  phone: 1,
  phone_number: 1,
  country: 1,
  document_type: 1,
  document_number: 1,
  referred_by_user_id: 1,
  referral_first_tx_id: 1,
  referral_first_amount: 1,
  referral_first_currency: 1,
  referral_qualified_at: 1,
};
const KYC_PROJECTION = {
  _id: 0,
  user_id: 1,
  phone: 1,
  country: 1,
  document_type: 1,
  document_number: 1,
  verified_at: 1,
  status: 1,
};

function reply(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function failure(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseTime(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePhone(user, kyc) {
  return String(user.phone || user.phone_number || kyc.phone || '').replace(/\D/g, '');
}

function identity(user, kyc) {
  const country = String(kyc.country || user.country || '').trim().toUpperCase();
  const documentType = String(kyc.document_type || user.document_type || '').trim().toLowerCase();
  const documentNumber = String(kyc.document_number || user.document_number || '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!country || !documentType || !documentNumber) return null;
  return `${country}\u0000${documentType}\u0000${documentNumber}`;
}

function isBlocked(user) {
  const status = String(user.status || '').toLowerCase();
  return Boolean(
    user.banned || user.is_banned || user.blocked || user.is_blocked ||
    ['banned', 'blocked', 'suspended'].includes(status)
  );
}

function positiveAmount(raw) {
  const amount = Number(raw);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

async function identityIndex(db) {
  const [users, kycRows] = await Promise.all([
    db.collection('users').find({}, USER_PROJECTION).to_list(),
    db.collection('kyc').find({}, KYC_PROJECTION).to_list(),
  ]);
  const usersById = new Map(users.filter(user => user.id).map(user => [String(user.id), user]));
  const verifiedKyc = new Map();
  for (const row of kycRows) {
    const userId = String(row.user_id || '');
    if (
      userId && !verifiedKyc.has(userId) && row.status === 'verified' &&
      parseTime(row.verified_at) !== null
    ) verifiedKyc.set(userId, row);
  }

  const details = new Map();
  const phoneOwners = new Map();
  const identityOwners = new Map();
  for (const [userId, user] of usersById) {
    const kyc = verifiedKyc.get(userId);
    if (!kyc || user.kyc_status !== 'verified' || isBlocked(user)) continue;
    const verifiedAt = parseTime(kyc.verified_at);
    if (verifiedAt === null) continue;
    const phone = normalizePhone(user, kyc);
    const identityKey = identity(user, kyc);
    details.set(userId, { kyc, verifiedAt, phone, identityKey });
    if (phone) {
      if (!phoneOwners.has(phone)) phoneOwners.set(phone, new Set());
      phoneOwners.get(phone).add(userId);
    }
    if (identityKey) {
      if (!identityOwners.has(identityKey)) identityOwners.set(identityKey, new Set());
      identityOwners.get(identityKey).add(userId);
    }
  }
  return { usersById, details, phoneOwners, identityOwners };
}

function identityIsUnique(index, userId, details) {
  const phoneOwners = index.phoneOwners.get(details.phone);
  if (details.phone && phoneOwners && [...phoneOwners].some(id => id !== userId)) return false;
  const identityOwners = index.identityOwners.get(details.identityKey);
  if (
    details.identityKey && identityOwners &&
    [...identityOwners].some(id => id !== userId)
  ) return false;
  return true;
}

function qualifiedCandidates(users, index, sponsorId) {
  const result = [];
  for (const user of users) {
    const userId = String(user.id || '');
    if (user.referred_by_user_id !== sponsorId || !user.referral_first_tx_id) continue;
    const details = index.details.get(userId);
    if (!details || !identityIsUnique(index, userId, details)) continue;
    const amount = positiveAmount(user.referral_first_amount);
    const currency = String(user.referral_first_currency || '').toUpperCase();
    const qualifiedAt = parseTime(user.referral_qualified_at);
    if (!amount || !['XOF', 'XAF'].includes(currency) || qualifiedAt === null) continue;
    result.push({
      user_id: userId,
      tx_id: String(user.referral_first_tx_id),
      amount,
      currency,
      qualified_at: qualifiedAt,
    });
  }
  return result.sort((left, right) =>
    left.qualified_at - right.qualified_at ||
    left.tx_id.localeCompare(right.tx_id) ||
    left.user_id.localeCompare(right.user_id)
  );
}

async function getSummary(db, sponsorId) {
  const sponsor = await db.collection('users').find_one(
    { id: sponsorId },
    { _id: 0, id: 1 }
  );
  if (!sponsor) throw failure(404, 'Parrain introuvable');
  const index = await identityIndex(db);
  const users = [...index.usersById.values()];
  const qualified = qualifiedCandidates(users, index, sponsorId);
  const claim = await db.collection('referral_commissions').find_one(
    { id: `${REFERRAL_CLAIM_PREFIX}${sponsorId}` },
    { _id: 0, status: 1, amount: 1, currency: 1, rate_percent: 1 }
  );
  const commission = claim ? {
    status: claim.status,
    amount: claim.amount,
    currency: claim.currency,
    rate_percent: claim.rate_percent,
  } : null;
  return {
    code: sponsor.id,
    invited_count: users.filter(user => user.referred_by_user_id === sponsorId).length,
    qualified_count: qualified.length,
    required_count: REQUIRED_REFERRALS,
    commission,
  };
}

function validInviteCode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : null;
}

function createReferralRoutes({ db, sessionService }) {
  async function handleRoute(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'GET') {
      const inviteMatch = url.pathname.match(/^\/api\/referrals\/invite\/([^/]+)$/);
      if (inviteMatch) {
        let decodedCode = '';
        try { decodedCode = decodeURIComponent(inviteMatch[1]); } catch { /* invalid path encoding */ }
        const sponsorId = validInviteCode(decodedCode);
        if (!sponsorId) {
          reply(res, 404, { detail: 'Lien de parrainage invalide' });
          return true;
        }
        const sponsor = await db.collection('users').find_one(
          { id: sponsorId, is_blocked: { $ne: true }, is_banned: { $ne: true } },
          { _id: 0, username: 1 }
        );
        if (!sponsor) reply(res, 404, { detail: 'Lien de parrainage invalide' });
        else reply(res, 200, { username: sponsor.username });
        return true;
      }
      if (url.pathname === '/api/referrals/me') {
        let session;
        try {
          const token = sessionToken(req);
          session = await sessionService.authenticate(token);
        } catch (error) {
          reply(res, error.status || 401, { detail: error.message || 'Session requise' });
          return true;
        }
        try {
          reply(res, 200, await getSummary(db, session.userId));
        } catch (error) {
          reply(res, error.status || 500, {
            detail: error.status ? error.message : 'Erreur interne.',
          });
        }
        return true;
      }
    }
    return false;
  }
  return { handleRoute };
}

module.exports = {
  createReferralRoutes,
  getSummary,
  validInviteCode,
};
