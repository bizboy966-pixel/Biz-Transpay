'use strict';

const { URL } = require('node:url');
const { sessionToken } = require('./auth-session-routes.cjs');
const { readJson, reply } = require('./auth-login.cjs');

const IMAGE_DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i;
const IMAGE_SIGNATURES = {
  'image/jpeg': bytes => bytes.length >= 3
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  'image/png': bytes => bytes.subarray(0, 8).equals(Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ])),
  'image/webp': bytes => bytes.length >= 12
    && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP',
};

function validationError(message) {
  const error = new Error(message);
  error.status = 422;
  return error;
}

function validateText(body, name, min, max) {
  const value = body[name];
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw validationError(`${name} invalide.`);
  }
  return value;
}

function validateRasterImage(value, fieldName, { required = false } = {}) {
  if (!value) {
    if (required) throw validationError(`${fieldName} requis`);
    return null;
  }
  if (typeof value !== 'string' || value.length > 4_200_000) {
    throw validationError(`${fieldName} invalide ou trop volumineux`);
  }
  const match = IMAGE_DATA_URL.exec(value.trim());
  if (!match) throw validationError(`${fieldName} doit être une image JPEG, PNG ou WebP`);
  const mime = match[1].toLowerCase();
  const encoded = match[2];
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw validationError(`${fieldName} invalide`);
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > 3_000_000 || !IMAGE_SIGNATURES[mime](bytes)) {
    throw validationError(`${fieldName} invalide ou trop volumineux`);
  }
  return `data:${mime};base64,${encoded}`;
}

function validatePlatformUrl(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 2048) {
    throw validationError('Adresse de la plateforme invalide.');
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw validationError('Adresse de la plateforme invalide.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname
      || parsed.username || parsed.password) {
    throw validationError('Adresse de la plateforme invalide.');
  }
  return parsed.toString();
}

function validateSubmission(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw validationError('Données KYC invalides.');
  }
  const fullName = validateText(body, 'full_name', 1, 120);
  const phone = validateText(body, 'phone', 3, 40);
  const documentNumber = validateText(body, 'document_number', 1, 100);
  const activityDescription = validateText(body, 'activity_description', 1, 500);
  const activityDetails = validateText(body, 'activity_details', 10, 2000).trim();
  if (activityDetails.length < 10) {
    throw validationError('La description de l’activité doit contenir au moins 10 caractères utiles.');
  }
  if (!['cni', 'passport', 'driver_license'].includes(body.document_type)) {
    throw validationError('Type de document invalide.');
  }
  if (!['available', 'not_available'].includes(body.platform_status)) {
    throw validationError('Statut de la plateforme invalide.');
  }
  const platformUrl = validatePlatformUrl(body.platform_url);
  if (body.platform_status === 'available' && !platformUrl) {
    throw validationError('L’adresse de la plateforme est obligatoire si elle est déjà disponible.');
  }
  if (body.platform_status === 'not_available' && platformUrl) {
    throw validationError('Ne renseignez pas de lien si la plateforme n’est pas encore disponible.');
  }
  return {
    full_name: fullName,
    phone,
    document_type: body.document_type,
    document_number: documentNumber,
    activity_description: activityDescription,
    activity_details: activityDetails,
    platform_status: body.platform_status,
    platform_url: platformUrl,
    document_front: validateRasterImage(body.document_front, 'document_front', { required: true }),
    document_back: validateRasterImage(body.document_back, 'document_back'),
    selfie: validateRasterImage(body.selfie, 'selfie', { required: true }),
  };
}

function createKycRoutes({ db, sessionService, notifyAdminKyc } = {}) {
  return async function handleKyc(req, res) {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (!['GET', 'POST'].includes(req.method) || !['/api/kyc', '/api/kyc/submit'].includes(path)) {
      return false;
    }
    if (!db || !sessionService) {
      reply(res, 503, { detail: 'Données KYC indisponibles.', code: 'MIGRATION_INCOMPLETE' });
      return true;
    }
    try {
      const token = sessionToken(req);
      if (!token) {
        reply(res, 401, { detail: { code: 'SESSION_REQUIRED', message: 'Session requise' } });
        return true;
      }
      const identity = await sessionService.authenticate(token);
      const user = await db.collection('users').find_one({ id: identity.userId }, { _id: 0 });
      if (!user) {
        reply(res, 401, { detail: 'Utilisateur introuvable.' });
        return true;
      }
      if (req.method === 'GET') {
        const submission = await db.collection('kyc').find_one({
          user_id: identity.userId,
        }, { _id: 0 }) || {};
        reply(res, 200, { status: user.kyc_status || 'not_started', submission });
        return true;
      }
      const body = await readJson(req, 13_000_000);
      const data = validateSubmission(body);
      const submittedAt = new Date().toISOString();
      const document = {
        user_id: identity.userId,
        ...data,
        submitted_at: submittedAt,
        status: 'pending',
        reject_reason: null,
      };
      await db.collection('kyc').replace_one({ user_id: identity.userId }, document, true);
      await db.collection('users').update_one(
        { id: identity.userId }, { $set: { kyc_status: 'pending' } },
      );
      try {
        notifyAdminKyc?.({
          type: 'kyc_submitted', userId: identity.userId,
          status: 'pending', detectedAt: submittedAt,
        });
      } catch {
        // Telegram is an asynchronous best-effort side channel.
      }
      reply(res, 200, {
        status: 'pending',
        message: 'Votre demande a été soumise et est en attente de validation.',
      });
      return true;
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      const detail = status >= 500
        ? 'Erreur interne.'
        : error.code
          ? { code: error.code, message: error.message, ...error.extra }
          : error.message;
      reply(res, status, { detail });
      return true;
    }
  };
}

module.exports = { createKycRoutes, validateRasterImage, validateSubmission };
