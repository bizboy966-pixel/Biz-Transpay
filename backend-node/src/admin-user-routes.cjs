'use strict';

const { randomUUID } = require('node:crypto');
const { authorizeAdmin } = require('./admin-authorization.cjs');
const { readJson } = require('./auth-login.cjs');
const { passwordPolicyErrors } = require('./security.cjs');
const { SPLIT_COLLECTIONS } = require('./document-store.cjs');

const SECRET_FIELDS = {
  _id: 0,
  password_hash: 0,
  admin_pin_hash: 0,
  admin_pin_version: 0,
  user_pin_hash: 0,
  user_pin_version: 0,
  two_fa_secret_encrypted: 0,
  two_fa_last_counter: 0,
  recovery_codes: 0,
};

function reply(res, status, body) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isProtectedPlatformOwner(user, env) {
  if (user?.platform_owner === true) return true;
  const ownerEmail = String(env.PLATFORM_OWNER_EMAIL || '').trim().toLowerCase();
  if (!ownerEmail || String(user?.email || '').trim().toLowerCase() !== ownerEmail) return false;
  const created = Date.parse(user.created_at || '');
  const claimBefore = Date.parse(env.PLATFORM_OWNER_CLAIM_BEFORE || '');
  return Number.isFinite(created) && Number.isFinite(claimBefore) && created <= claimBefore;
}

function adminUpdateError(res, error) {
  const status = Number.isInteger(error.status) ? error.status : 500;
  reply(res, status, {
    detail: error.code
      ? { code: error.code, message: error.message }
      : status >= 500 ? 'Erreur interne.' : error.message,
  });
}

function isSuperAdmin(admin) {
  return String(admin?._effective_role || admin?.role || '').toLowerCase() === 'super_admin';
}

function createAdminUserRoutes({
  db, sessionService, cryptoCatalog, env = process.env,
  notify = async () => {}, notifyAdminKyc = async () => {},
}) {
  async function handleUserUpdate(req, res, match) {
    try {
      const { admin } = await authorizeAdmin(req, {
        db, sessionService, env, permission: 'users:write',
        action: 'admin_update_user', sensitive: true,
      });
      const userId = decodeURIComponent(match[1]);
      if (!userId || userId.length > 160) {
        reply(res, 422, { detail: 'Identifiant utilisateur invalide' });
        return true;
      }
      const target = await db.collection('users').find_one({ id: userId }, { _id: 0 });
      if (!target) {
        reply(res, 404, { detail: 'Utilisateur introuvable' });
        return true;
      }
      const body = await readJson(req, 16 * 1024);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        reply(res, 422, { detail: 'Corps de requête invalide' });
        return true;
      }
      const allowed = new Set([
        'full_name', 'username', 'email', 'phone', 'country',
        'role', 'admin_role', 'account_type', 'confirmation',
      ]);
      if (Object.keys(body).some(key => !allowed.has(key))) {
        reply(res, 422, { detail: 'Champ de modification non autorisé' });
        return true;
      }
      const updates = {};
      const limits = {
        full_name: 200, username: 64, email: 320, phone: 64, country: 100,
      };
      for (const [field, maxLength] of Object.entries(limits)) {
        if (body[field] === undefined || body[field] === null) continue;
        if (typeof body[field] !== 'string' || body[field].length > maxLength) {
          reply(res, 422, { detail: `Champ ${field} invalide` });
          return true;
        }
        updates[field] = body[field].trim();
      }
      if (updates.email) updates.email = updates.email.toLowerCase();
      if (body.account_type !== undefined && body.account_type !== null) {
        if (!['personal', 'merchant'].includes(body.account_type)) {
          reply(res, 422, { detail: 'Type de compte invalide' });
          return true;
        }
        updates.account_type = body.account_type;
      }
      if (body.role !== undefined && body.role !== null) {
        if (!['user', 'admin', 'super_admin'].includes(body.role)) {
          reply(res, 422, { detail: 'Rôle invalide' });
          return true;
        }
        updates.role = body.role;
      }
      if (body.admin_role !== undefined && body.admin_role !== null) {
        if (!['general', 'finance', 'operations', 'support', 'compliance'].includes(body.admin_role)) {
          reply(res, 422, { detail: 'Rôle administratif invalide' });
          return true;
        }
        updates.admin_role = body.admin_role;
      }

      const protectedIdentityFields = ['role', 'admin_role', 'email', 'account_type'];
      if (isProtectedPlatformOwner(target, env)
          && protectedIdentityFields.some(field => field in updates)) {
        reply(res, 403, { detail: 'Le compte propriétaire de la plateforme est protégé.' });
        return true;
      }
      const confirmation = String(body.confirmation || '').trim().toUpperCase();
      if ('role' in updates || 'admin_role' in updates) {
        if (String(admin._effective_role || admin.role || '').toLowerCase() !== 'super_admin') {
          reply(res, 403, { detail: 'Seul un super administrateur peut modifier les rôles.' });
          return true;
        }
        if (confirmation !== 'CONFIRMER') {
          reply(res, 428, {
            detail: { code: 'ADMIN_CONFIRMATION_REQUIRED', message: 'Saisissez CONFIRMER.' },
          });
          return true;
        }
      }
      if (updates.role === 'user') delete updates.admin_role;
      if (updates.admin_role && (updates.role || target.role) !== 'admin') {
        reply(res, 422, { detail: 'Un rôle administratif nécessite un compte admin.' });
        return true;
      }
      if (isProtectedPlatformOwner(target, env)
          && updates.role && updates.role !== 'super_admin') {
        reply(res, 403, { detail: 'Le compte propriétaire ne peut pas être rétrogradé.' });
        return true;
      }
      if ('username' in updates && updates.username !== target.username) {
        const duplicate = await db.collection('users').find_one({
          username: updates.username, id: { $ne: userId },
        }, { _id: 0, id: 1 });
        if (duplicate) {
          reply(res, 409, { detail: "Nom d'utilisateur déjà utilisé" });
          return true;
        }
      }
      if ('email' in updates && updates.email !== target.email) {
        const duplicate = await db.collection('users').find_one({
          email: updates.email, id: { $ne: userId },
        }, { _id: 0, id: 1 });
        if (duplicate) {
          reply(res, 409, { detail: 'Adresse email déjà utilisée' });
          return true;
        }
      }

      const update = {};
      if (updates.role === 'user') {
        update.$unset = { admin_role: '' };
      }
      if (Object.keys(updates).length) update.$set = updates;
      if (Object.keys(update).length) {
        await db.collection('users').update_one({ id: userId }, update);
      }
      await db.collection('admin_logs').insert_one({
        id: randomUUID(),
        admin_id: admin.id,
        admin_username: admin.username || '',
        action: 'update_user',
        target_user_id: userId,
        target_username: target.username || '',
        details: updates,
        created_at: new Date().toISOString(),
      });
      const user = await db.collection('users').find_one({ id: userId }, SECRET_FIELDS);
      reply(res, 200, user);
    } catch (error) {
      adminUpdateError(res, error);
    }
    return true;
  }

  async function handleAdminPasswordReset(req, res, match) {
    try {
      const { admin } = await authorizeAdmin(req, {
        db, sessionService, env, permission: 'users:write',
        action: 'admin_reset_password', sensitive: true,
      });
      const userId = decodeURIComponent(match[1]);
      if (!userId || userId.length > 160) {
        reply(res, 422, { detail: 'Identifiant utilisateur invalide' });
        return true;
      }
      const users = db.collection('users');
      const target = await users.find_one({ id: userId }, { _id: 0 });
      if (!target) {
        reply(res, 404, { detail: 'Utilisateur introuvable' });
        return true;
      }
      const body = await readJson(req, 16 * 1024);
      if (Object.keys(body).some(key => !['new_password', 'confirmation'].includes(key))) {
        reply(res, 422, { detail: 'Champ de réinitialisation invalide' });
        return true;
      }
      if (String(body.confirmation || '').trim().toUpperCase() !== 'CONFIRMER') {
        reply(res, 422, {
          detail: { code: 'ADMIN_CONFIRMATION_REQUIRED', message: 'Saisissez CONFIRMER.' },
        });
        return true;
      }
      const isAdminTarget = ['admin', 'super_admin'].includes(target.role);
      const errors = passwordPolicyErrors(body.new_password, isAdminTarget);
      if (errors.length) {
        reply(res, 422, { detail: `Mot de passe insuffisant : ${errors.join(', ')}` });
        return true;
      }
      const passwordHash = await require('bcryptjs').hash(body.new_password, 12);
      await users.update_one({ id: userId }, { $set: {
        password_hash: passwordHash,
        password_policy_version: 1,
      } });
      await db.collection('admin_logs').insert_one({
        admin_id: admin.id,
        admin_username: admin.username || '',
        action: 'reset_password',
        target_user_id: userId,
        target_username: target.username || '',
        created_at: new Date().toISOString(),
      });
      reply(res, 200, { ok: true });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      reply(res, status, {
        detail: status >= 500 ? 'Erreur interne.' : error.message,
      });
    }
    return true;
  }

  async function handleUserAction(req, res, match) {
    try {
      const { admin } = await authorizeAdmin(req, {
        db, sessionService, env, permission: 'users:write',
        action: 'admin_user_action', sensitive: true,
      });
      const userId = decodeURIComponent(match[1]);
      const action = String(match[2] || '');
      const updates = {
        block: { is_blocked: true },
        unblock: { is_blocked: false },
        ban: { is_banned: true, is_blocked: true },
        unban: { is_banned: false, is_blocked: false },
        block_withdrawals: { withdrawals_blocked: true },
        unblock_withdrawals: { withdrawals_blocked: false },
      }[action];
      if (!updates) {
        reply(res, 400, { detail: 'Action inconnue' });
        return true;
      }
      const body = await readJson(req, 16 * 1024);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        reply(res, 422, { detail: 'Corps de requête invalide' });
        return true;
      }
      if (typeof body.reason !== 'undefined'
          && (typeof body.reason !== 'string' || body.reason.length > 500)) {
        reply(res, 422, { detail: 'Motif invalide' });
        return true;
      }
      if (String(body.confirmation || '').trim().toUpperCase() !== 'CONFIRMER') {
        reply(res, 428, {
          detail: { code: 'ADMIN_CONFIRMATION_REQUIRED', message: 'Saisissez CONFIRMER.' },
        });
        return true;
      }
      const target = await db.collection('users').find_one({ id: userId }, { _id: 0 });
      if (!target) {
        reply(res, 404, { detail: 'Utilisateur introuvable' });
        return true;
      }
      if (isProtectedPlatformOwner(target, env)
          && Object.values(updates).some(value => value === true)) {
        reply(res, 403, { detail: 'Le compte propriétaire de la plateforme est protégé.' });
        return true;
      }
      await db.collection('users').update_one({ id: userId }, { $set: updates });
      await db.collection('admin_logs').insert_one({
        id: randomUUID(),
        admin_id: admin.id,
        admin_username: admin.username || '',
        action,
        target_user_id: userId,
        target_username: target.username || '',
        details: { reason: String(body.reason || '').slice(0, 500) },
        created_at: new Date().toISOString(),
      });
      const user = await db.collection('users').find_one({ id: userId }, SECRET_FIELDS);
      reply(res, 200, { ok: true, user });
    } catch (error) {
      adminUpdateError(res, error);
    }
    return true;
  }

  async function requireDestructiveAdmin(req, action) {
    const { admin } = await authorizeAdmin(req, {
      db, sessionService, env, permission: 'users:write',
      action, sensitive: true,
    });
    if (!isSuperAdmin(admin)) {
      throw Object.assign(new Error('Réservé au super administrateur.'), { status: 403 });
    }
    if (typeof db.transaction !== 'function') {
      throw Object.assign(new Error('Opération indisponible sans transaction atomique.'), { status: 503 });
    }
    return admin;
  }

  function destructiveLocks(extra = []) {
    const names = new Set([
      'users', 'wallet_operations', 'admin_logs', ...SPLIT_COLLECTIONS, ...extra,
    ]);
    return [
      'users', 'wallet_operations',
      ...[...names].filter(name => !['users', 'wallet_operations'].includes(name)).sort(),
    ];
  }

  async function deleteUserRecords(repo, userId, linkIds = null) {
    const counts = {};
    const ownedLinks = linkIds || (await repo.find('payment_links', { user_id: userId }))
      .map(link => String(link.id || '')).filter(Boolean);
    if (ownedLinks.length) {
      counts.link_payments = (await repo.deleteMany(
        'link_payments', { link_id: { $in: ownedLinks } },
      )).deleted_count;
    }
    const userFieldByCollection = {
      merchant_payments: 'merchant_id',
      support_messages: 'conversation_id',
    };
    const skip = new Set(['users', 'payment_links', 'link_payments', 'admin_logs',
      'settings', 'platform_bootstrap']);
    for (const collection of SPLIT_COLLECTIONS) {
      if (skip.has(collection)) continue;
      const field = userFieldByCollection[collection] || 'user_id';
      const result = await repo.deleteMany(collection, { [field]: userId });
      if (result.deleted_count) counts[collection] = result.deleted_count;
    }
    if (ownedLinks.length) {
      counts.payment_links = (await repo.deleteMany(
        'payment_links', { id: { $in: ownedLinks } },
      )).deleted_count;
    }
    counts.user = (await repo.deleteMany('users', { id: userId })).deleted_count;
    return counts;
  }

  async function handleUserDelete(req, res, match) {
    try {
      const admin = await requireDestructiveAdmin(req, 'admin_delete_user');
      let userId;
      try { userId = decodeURIComponent(match[1]); } catch {
        reply(res, 400, { detail: 'Identifiant utilisateur invalide' });
        return true;
      }
      if (!userId || userId.length > 160) {
        reply(res, 422, { detail: 'Identifiant utilisateur invalide' });
        return true;
      }
      const body = await readJson(req, 8 * 1024);
      const result = await db.transaction(async repo => {
        for (const name of destructiveLocks()) await repo.lockCollection(name);
        const target = await repo.get('users', userId);
        if (!target) return { status: 404, detail: 'Utilisateur introuvable' };
        if (String(target.id) === String(admin.id)) {
          return { status: 403, detail: 'Vous ne pouvez pas supprimer votre propre compte.' };
        }
        if (target.role === 'super_admin' || isProtectedPlatformOwner(target, env)) {
          return { status: 403, detail: 'Le compte propriétaire ou super administrateur est protégé.' };
        }
        const expected = `SUPPRIMER ${String(target.username || target.email || '').trim()}`;
        if (String(body.confirmation || '') !== expected) {
          return { status: 428, detail: {
            code: 'ADMIN_CONFIRMATION_REQUIRED',
            message: `Saisissez exactement « ${expected} » pour confirmer.`,
          } };
        }
        const links = await repo.find('payment_links', { user_id: userId });
        const counts = await deleteUserRecords(
          repo, userId, links.map(link => String(link.id || '')).filter(Boolean),
        );
        const timestamp = new Date().toISOString();
        const logId = randomUUID();
        await repo.insert('admin_logs', logId, {
          id: logId,
          admin_id: admin.id,
          admin_username: admin.username || '',
          action: 'delete_user',
          target_user_id: userId,
          target_username: target.username || '',
          details: { deleted: counts },
          created_at: timestamp,
        });
        return { status: 200, deleted: counts };
      });
      const { status, ...payload } = result;
      reply(res, status, payload);
    } catch (error) {
      adminUpdateError(res, error);
    }
    return true;
  }

  async function handleCleanupTestUsers(req, res) {
    try {
      const admin = await requireDestructiveAdmin(req, 'admin_cleanup_test_users');
      const body = await readJson(req, 8 * 1024);
      if (String(body.confirmation || '') !== 'SUPPRIMER LES COMPTES NON-SUPERADMIN') {
        reply(res, 428, {
          detail: {
            code: 'ADMIN_CONFIRMATION_REQUIRED',
            message: 'Saisissez exactement SUPPRIMER LES COMPTES NON-SUPERADMIN.',
          },
        });
        return true;
      }
      const result = await db.transaction(async repo => {
        for (const name of destructiveLocks()) await repo.lockCollection(name);
        const allUsers = await repo.find('users', {});
        const victims = allUsers.filter(user => (
          user.role !== 'super_admin' && !isProtectedPlatformOwner(user, env)
        ));
        const victimIds = victims.map(user => String(user.id)).filter(Boolean);
        if (!victimIds.length) return { deleted: 0, kept: allUsers.length };
        const counts = {};
        const links = await repo.find('payment_links', {});
        const ownedLinkIds = links.filter(link => victimIds.includes(String(link.user_id)))
          .map(link => String(link.id || '')).filter(Boolean);
        if (ownedLinkIds.length) {
          counts.link_payments = (await repo.deleteMany(
            'link_payments', { link_id: { $in: ownedLinkIds } },
          )).deleted_count;
        }
        const fieldByCollection = {
          merchant_payments: 'merchant_id',
          support_messages: 'conversation_id',
        };
        const skip = new Set([
          'users', 'payment_links', 'link_payments', 'admin_logs',
          'settings', 'platform_bootstrap',
        ]);
        for (const collection of SPLIT_COLLECTIONS) {
          if (skip.has(collection)) continue;
          const field = fieldByCollection[collection] || 'user_id';
          const deleted = await repo.deleteMany(collection, { [field]: { $in: victimIds } });
          if (deleted.deleted_count) counts[collection] = deleted.deleted_count;
        }
        if (ownedLinkIds.length) {
          counts.payment_links = (await repo.deleteMany(
            'payment_links', { id: { $in: ownedLinkIds } },
          )).deleted_count;
        }
        counts.users = (await repo.deleteMany('users', { id: { $in: victimIds } })).deleted_count;
        const timestamp = new Date().toISOString();
        const logId = randomUUID();
        await repo.insert('admin_logs', logId, {
          id: logId,
          admin_id: admin.id,
          admin_username: admin.username || '',
          action: 'cleanup_test_users',
          details: { deleted: counts, kept_super_admins: allUsers.length - victims.length },
          created_at: timestamp,
        });
        return { deleted: counts.users, kept: allUsers.length - victims.length, counts };
      });
      reply(res, 200, result);
    } catch (error) {
      adminUpdateError(res, error);
    }
    return true;
  }

  async function handlePlatformReset(req, res) {
    try {
      const admin = await requireDestructiveAdmin(req, 'admin_platform_reset');
      const body = await readJson(req, 8 * 1024);
      const fullWipe = body.delete_all === true;
      const expected = fullWipe ? 'SUPPRIMER_TOUT' : 'RÉINITIALISER';
      if (String(body.confirmation || '') !== expected) {
        reply(res, 428, {
          detail: { code: 'ADMIN_CONFIRMATION_REQUIRED', message: `Saisissez exactement ${expected}.` },
        });
        return true;
      }
      const preservedCollections = new Set([
        'users', 'settings', 'platform_bootstrap', 'admin_logs',
      ]);
      const wipeCollections = [...SPLIT_COLLECTIONS]
        .filter(name => !preservedCollections.has(name));
      const result = await db.transaction(async repo => {
        for (const name of destructiveLocks(wipeCollections)) await repo.lockCollection(name);
        const allUsers = await repo.find('users', {});
        const keep = allUsers.filter(user => (
          isProtectedPlatformOwner(user, env)
            || (!fullWipe && user.role === 'super_admin')
        ));
        const keepIds = new Set(keep.map(user => String(user.id)));
        const victimIds = allUsers.map(user => String(user.id))
          .filter(id => id && !keepIds.has(id));
        const wiped = {};
        for (const collection of wipeCollections) {
          wiped[collection] = (await repo.deleteMany(collection, {})).deleted_count;
        }
        wiped.users = victimIds.length
          ? (await repo.deleteMany('users', { id: { $in: victimIds } })).deleted_count : 0;
        for (const user of keep) {
          const reset = { ...user };
          for (const key of Object.keys(reset)) {
            if (key.startsWith('balance_')) reset[key] = 0;
          }
          reset.wallet_credit_operation_ids = [];
          reset.wallet_operation_ids = [];
          await repo.replace('users', String(user.id), reset);
        }
        const timestamp = new Date().toISOString();
        const logId = randomUUID();
        await repo.insert('admin_logs', logId, {
          id: logId,
          admin_id: admin.id,
          admin_username: admin.username || '',
          action: 'platform_reset',
          details: {
            delete_all: fullWipe,
            deleted_users: wiped.users,
            kept_super_admins: keep.length,
            wiped,
          },
          created_at: timestamp,
        });
        return {
          deleted_users: wiped.users,
          kept_super_admins: keep.length,
          kept_platform_owner: keep.some(user => isProtectedPlatformOwner(user, env)),
          wiped,
          balances_reset: true,
        };
      });
      reply(res, 200, result);
    } catch (error) {
      adminUpdateError(res, error);
    }
    return true;
  }

  async function handleKycRoute(req, res, url, decisionMatch) {
    const list = !decisionMatch;
    try {
      const { admin } = await authorizeAdmin(req, {
        db, sessionService, env,
        permission: list ? 'kyc:read' : 'kyc:write',
        action: list ? 'admin_list_kyc' : 'admin_kyc_decision',
      });
      if (list) {
        const status = String(url.searchParams.get('status') || '').trim();
        if (status.length > 32) {
          reply(res, 422, { detail: 'Filtre KYC invalide' });
          return true;
        }
        const query = status ? { status } : {};
        const documents = await db.collection('kyc').find(query, { _id: 0 })
          .sort('submitted_at', -1).to_list(500);
        const userIds = [...new Set(documents.map(row => String(row.user_id || '')).filter(Boolean))];
        const users = userIds.length
          ? await db.collection('users').find({ id: { $in: userIds } }, {
            _id: 0, id: 1, full_name: 1, username: 1, email: 1, country: 1,
          }).to_list()
          : [];
        const byId = new Map(users.map(user => [String(user.id), user]));
        reply(res, 200, documents.map(row => ({
          ...row,
          user: byId.get(String(row.user_id || '')) || null,
        })));
        return true;
      }

      let userId;
      try { userId = decodeURIComponent(decisionMatch[1]); } catch {
        reply(res, 400, { detail: 'Identifiant utilisateur invalide' });
        return true;
      }
      const body = await readJson(req, 16 * 1024);
      if (typeof body.approve !== 'boolean') {
        reply(res, 422, { detail: 'La décision KYC est invalide' });
        return true;
      }
      const reason = body.reason === undefined || body.reason === null ? '' : body.reason;
      if (typeof reason !== 'string' || reason.length > 2000) {
        reply(res, 422, { detail: 'Le motif ne peut pas dépasser 2 000 caractères' });
        return true;
      }
      const target = await db.collection('users').find_one(
        { id: userId }, { _id: 0, id: 1, username: 1 },
      );
      if (!target) {
        reply(res, 404, { detail: 'Utilisateur introuvable' });
        return true;
      }

      const reviewedAt = new Date().toISOString();
      let action;
      let notificationType;
      let title;
      let message;
      let data;
      let userStatus;
      let kycStatus;
      if (body.approve) {
        action = 'kyc_approve';
        notificationType = 'kyc_verified';
        title = 'KYC vérifié ✓';
        message = 'Votre identité a été vérifiée. Vous pouvez maintenant utiliser toutes les fonctionnalités (liens de paiement, API, retraits).';
        userStatus = 'verified';
        kycStatus = 'verified';
        data = { status: 'verified', reviewed_at: reviewedAt };
      } else if (body.request_resubmit === true) {
        action = 'kyc_request_resubmit';
        notificationType = 'kyc_resubmit_requested';
        title = 'KYC — nouveaux documents demandés';
        message = reason || 'Merci de renvoyer vos documents KYC.';
        userStatus = 'not_started';
        kycStatus = 'resubmit_requested';
        data = { status: kycStatus, reason, reviewed_at: reviewedAt };
      } else {
        action = 'kyc_reject';
        notificationType = 'kyc_rejected';
        title = 'KYC rejeté';
        message = reason || "Votre demande de KYC a été rejetée. Contactez le support pour plus d'informations.";
        userStatus = 'rejected';
        kycStatus = 'rejected';
        data = { status: kycStatus, reason, reviewed_at: reviewedAt };
      }

      await db.collection('users').update_one(
        { id: userId }, { $set: { kyc_status: userStatus } },
      );
      await db.collection('kyc').update_one(
        { user_id: userId },
        { $set: {
          status: kycStatus,
          reviewed_at: reviewedAt,
          reject_reason: body.approve ? null : reason,
          ...(body.approve ? { verified_at: reviewedAt } : {}),
        } },
      );

      try { await notify(userId, notificationType, title, message, data); } catch { /* best effort */ }
      try {
        await notifyAdminKyc(
          userId, notificationType, 'Décision KYC',
          'Le statut de la vérification KYC a été mis à jour.', data,
        );
      } catch { /* best effort */ }
      await db.collection('admin_logs').insert_one({
        id: randomUUID(),
        admin_id: admin.id,
        admin_username: admin.username || null,
        action,
        target_user_id: userId,
        target_username: target.username || null,
        details: { reason },
        ip: '',
        created_at: reviewedAt,
      });
      reply(res, 200, { ok: true });
    } catch (error) {
      reply(res, error.status || 500, {
        detail: error.code
          ? { code: error.code, message: error.message }
          : error.status ? error.message : 'Erreur interne.',
      });
    }
    return true;
  }

  async function handleRoute(req, res) {
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); }
    catch { return false; }
    if (req.method === 'POST' && url.pathname === '/api/admin/platform/reset') {
      return handlePlatformReset(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/users/cleanup-test-users') {
      return handleCleanupTestUsers(req, res);
    }
    const deleteUser = req.method === 'DELETE'
      ? /^\/api\/admin\/users\/([^/]+)$/.exec(url.pathname) : null;
    if (deleteUser) return handleUserDelete(req, res, deleteUser);
    const createAdmin = req.method === 'POST' && url.pathname === '/api/admin/admins';
    if (createAdmin) {
      try {
        const { admin } = await authorizeAdmin(req, {
          db, sessionService, env,
          permission: 'admin_users:write',
          action: 'admin_create_admin',
          sensitive: true,
        });
        if (admin._effective_role !== 'SUPER_ADMIN') {
          reply(res, 403, { detail: "Seul l'administrateur principal peut ajouter un admin" });
          return true;
        }
        const body = await readJson(req, 16 * 1024);
        if (String(body.confirmation || '').trim().toUpperCase() !== 'CONFIRMER') {
          reply(res, 422, {
            detail: { code: 'ADMIN_CONFIRMATION_REQUIRED', message: 'Saisissez CONFIRMER.' },
          });
          return true;
        }
        const fullName = String(body.full_name || '').trim();
        const username = String(body.username || '').trim().toLowerCase();
        const email = String(body.email || '').trim().toLowerCase();
        const country = String(body.country || 'TG').trim().toUpperCase();
        const phone = String(body.phone || '').trim();
        const password = String(body.password || '');
        const adminRole = String(body.admin_role || 'general').trim();
        const allowedRoles = new Set(['general', 'finance', 'operations', 'support', 'compliance']);
        if (fullName.length < 2 || fullName.length > 120
            || !/^[a-z0-9_.-]{3,40}$/.test(username)
            || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
            || !/^[A-Z]{2}$/.test(country) || phone.length > 32
            || !allowedRoles.has(adminRole)) {
          reply(res, 422, { detail: 'Informations administrateur invalides.' });
          return true;
        }
        const passwordErrors = passwordPolicyErrors(password, true);
        if (passwordErrors.length) {
          reply(res, 422, {
            detail: `Mot de passe insuffisant : ${passwordErrors.join(', ')}`,
          });
          return true;
        }
        const users = db.collection('users');
        if (await users.find_one({ $or: [{ email }, { username }] }, { _id: 0, id: 1 })) {
          reply(res, 409, { detail: 'Cet e-mail ou cet identifiant est déjà utilisé.' });
          return true;
        }
        const createdAt = new Date().toISOString();
        const user = {
          id: randomUUID(),
          full_name: fullName,
          username,
          account_type: 'merchant',
          country,
          phone,
          email,
          password_hash: await require('bcryptjs').hash(password, 12),
          password_policy_version: 1,
          kyc_status: 'verified',
          balance_xof: 0,
          balance_xaf: 0,
          balance_usdt: 0,
          balance_gnf: 0,
          balance_cdf: 0,
          balance_usd: 0,
          created_at: createdAt,
          two_fa_enabled: false,
          language: 'fr',
          default_currency: 'XOF',
          role: 'admin',
          admin_role: adminRole,
          is_active: true,
          is_blocked: false,
          is_banned: false,
          withdrawals_blocked: false,
        };
        try {
          await users.insert_one(user);
        } catch (error) {
          if (['ER_DUP_ENTRY', 11000].includes(error.code)) {
            reply(res, 409, { detail: 'Cet e-mail ou cet identifiant est déjà utilisé.' });
            return true;
          }
          throw error;
        }
        await db.collection('admin_logs').insert_one({
          id: randomUUID(),
          admin_id: admin.id,
          admin_username: admin.username || '',
          action: 'create_admin',
          target_user_id: user.id,
          target_username: username,
          details: { admin_role: adminRole },
          created_at: createdAt,
        });
        const safeUser = { ...user };
        for (const key of Object.keys(SECRET_FIELDS)) delete safeUser[key];
        reply(res, 201, safeUser);
      } catch (error) {
        const status = Number.isInteger(error.status) ? error.status : 500;
        reply(res, status, {
          detail: status >= 500 ? 'Impossible de créer le compte administrateur.' : error.message,
        });
      }
      return true;
    }
    const kycList = req.method === 'GET' && url.pathname === '/api/admin/kyc';
    const kycDecision = req.method === 'POST'
      ? /^\/api\/admin\/kyc\/([^/]+)\/decision$/.exec(url.pathname)
      : null;
    if (kycList || kycDecision) return handleKycRoute(req, res, url, kycDecision);
    const userUpdate = req.method === 'PATCH'
      ? /^\/api\/admin\/users\/([^/]+)$/.exec(url.pathname)
      : null;
    if (userUpdate) return handleUserUpdate(req, res, userUpdate);
    const resetPassword = req.method === 'POST'
      ? /^\/api\/admin\/users\/([^/]+)\/reset-password$/.exec(url.pathname) : null;
    if (resetPassword) return handleAdminPasswordReset(req, res, resetPassword);
    const userAction = req.method === 'POST'
      ? /^\/api\/admin\/users\/([^/]+)\/action\/([^/]+)$/.exec(url.pathname)
      : null;
    if (userAction) return handleUserAction(req, res, userAction);
    if (req.method !== 'GET') return false;
    const adminsList = url.pathname === '/api/admin/admins';
    const listUsers = url.pathname === '/api/admin/users';
    const balanceMatch = /^\/api\/admin\/users\/([^/]+)\/balance-wallets$/.exec(url.pathname);
    const detailMatch = /^\/api\/admin\/users\/([^/]+)$/.exec(url.pathname);
    if (!adminsList && !listUsers && !balanceMatch && !detailMatch) return false;

    try {
      await authorizeAdmin(req, {
        db, sessionService, env,
        permission: adminsList ? 'admin_users:read' : 'users:read',
        action: adminsList ? 'admin_list_admins'
          : listUsers ? 'admin_list_users'
            : (balanceMatch ? 'admin_user_balance_wallets' : 'admin_get_user'),
      });

      if (adminsList) {
        const admins = await db.collection('users').find({
          role: { $in: ['admin', 'super_admin'] },
        }, {
          _id: 0, id: 1, full_name: 1, username: 1, email: 1,
          role: 1, admin_role: 1, created_at: 1, two_fa_enabled: 1,
          is_active: 1, last_login_at: 1,
        }).sort('created_at', -1).to_list(200);
        reply(res, 200, admins.map(admin => ({
          ...admin,
          admin_role: admin.role === 'admin' && !admin.admin_role
            ? 'general' : admin.admin_role,
        })));
        return true;
      }

      if (balanceMatch || detailMatch) {
        let userId;
        try {
          userId = decodeURIComponent((balanceMatch || detailMatch)[1]);
        } catch {
          reply(res, 400, { detail: 'Identifiant utilisateur invalide' });
          return true;
        }
        const user = await db.collection('users').find_one({ id: userId }, SECRET_FIELDS);
        if (!user) {
          reply(res, 404, { detail: 'Utilisateur introuvable' });
          return true;
        }
        if (balanceMatch) {
          const assets = await cryptoCatalog.activeExchangeAssets();
          const wallets = [
            { id: 'XOF', currency: 'XOF', balance: Number(user.balance_xof || 0) },
            { id: 'XAF', currency: 'XAF', balance: Number(user.balance_xaf || 0) },
          ];
          for (const [assetId, asset] of assets) {
            wallets.push({
              id: assetId,
              asset_id: assetId,
              currency: asset.coin,
              coin: asset.coin,
              network: asset.network,
              network_name: asset.network_name,
              balance: Number(user[asset.wallet_field] || 0),
            });
          }
          reply(res, 200, {
            wallets,
            legacy_usdt_balance: Number(user.balance_usdt || 0),
          });
          return true;
        }
        const transactions = db.collection('transactions');
        const transactionsCount = await transactions.count_documents({ user_id: userId });
        const recentTransactions = await transactions.find(
          { user_id: userId }, { _id: 0 },
        ).sort('created_at', -1).to_list(20);
        reply(res, 200, {
          user,
          transactions_count: transactionsCount,
          recent_transactions: recentTransactions,
        });
        return true;
      }

      const query = {};
      const searchText = String(url.searchParams.get('q') || '').trim();
      if (searchText) {
        if (searchText.length > 100) {
          reply(res, 422, { detail: 'Recherche trop longue' });
          return true;
        }
        const safeSearch = escapeRegex(searchText);
        const usernameQuery = searchText.replace(/^@+/, '').trim();
        const terms = [
          { id: { $regex: safeSearch, $options: 'i' } },
          { full_name: { $regex: safeSearch, $options: 'i' } },
          { email: { $regex: safeSearch, $options: 'i' } },
          { username: { $regex: safeSearch, $options: 'i' } },
        ];
        if (usernameQuery && usernameQuery !== searchText) {
          terms.push({ username: { $regex: escapeRegex(usernameQuery), $options: 'i' } });
        }
        const phoneDigits = searchText.replace(/\D/g, '');
        if (phoneDigits) {
          terms.push({ phone: { $regex: safeSearch, $options: 'i' } });
          if (phoneDigits.length >= 6) {
            terms.push({
              phone: {
                $regex: [...phoneDigits].map(digit => escapeRegex(digit)).join('\\D*'),
                $options: 'i',
              },
            });
          }
        } else {
          terms.push({ phone: { $regex: safeSearch, $options: 'i' } });
        }
        query.$or = terms;
      }

      const kyc = url.searchParams.get('kyc');
      if (kyc) {
        if (kyc.length > 32) {
          reply(res, 422, { detail: 'Filtre KYC invalide' });
          return true;
        }
        query.kyc_status = kyc;
      }
      const status = url.searchParams.get('status');
      if (status === 'blocked') query.is_blocked = true;
      else if (status === 'banned') query.is_banned = true;
      else if (status === 'active') {
        query.is_blocked = false;
        query.is_banned = false;
      }

      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? 200 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        reply(res, 422, { detail: 'Limite invalide (1–1000)' });
        return true;
      }
      const users = await db.collection('users').find(query, SECRET_FIELDS)
        .sort('created_at', -1).to_list(limit);
      reply(res, 200, users);
    } catch (error) {
      reply(res, error.status || 500, {
        detail: error.code
          ? { code: error.code, message: error.message }
          : error.message || 'Erreur interne.',
      });
    }
    return true;
  }
  return { handleRoute };
}

module.exports = { createAdminUserRoutes, escapeRegex, SECRET_FIELDS };
