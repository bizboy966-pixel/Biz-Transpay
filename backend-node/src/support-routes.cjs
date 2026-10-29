'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { sessionToken } = require('./auth-session-routes.cjs');
const { readJson, reply } = require('./auth-login.cjs');
const { validateRasterImage } = require('./kyc-routes.cjs');

const SOCIAL_KEYS = ['facebook', 'tiktok', 'instagram', 'whatsapp'];
const DEFAULT_SUPPORT_CONFIG = {
  id: 'support_config',
  chat_enabled: true,
  telegram_url: 'https://t.me/biztranspay',
  whatsapp_url: 'https://wa.me/22890000000',
  email: 'support@biz-transpay.com',
  social_channels: {
    facebook: { url: '', active: false },
    tiktok: { url: '', active: false },
    instagram: { url: '', active: false },
    whatsapp: { url: '', active: false },
  },
  community_enabled: false,
  community_url: '',
  community_label: 'Rejoindre la communauté',
  faqs: [
    {
      id: 'verify-account',
      question: 'Comment vérifier mon compte ?',
      answer: 'Rendez-vous sur la page Vérification KYC et téléversez vos documents.',
      active: true,
    },
    {
      id: 'fees',
      question: 'Quels sont les frais ?',
      answer: "Les frais applicables sont affichés dans le parcours de chaque opération et sont configurés par l'administrateur.",
      active: true,
    },
    {
      id: 'api-access',
      question: 'Quand puis-je utiliser l’API ?',
      answer: "L'accès à l'API est disponible pour les comptes marchands éligibles après les vérifications requises.",
      active: true,
    },
    {
      id: 'minimum-deposit',
      question: 'Quel est le montant minimum de dépôt ?',
      answer: 'Le montant minimum dépend du pays, de l’opérateur et des limites configurées dans la plateforme.',
      active: true,
    },
    {
      id: 'payment-link',
      question: 'Comment créer un lien de paiement ?',
      answer: 'Ouvrez Dashboard → Liens de paiement → Créer un lien de paiement, puis renseignez les informations demandées.',
      active: true,
    },
  ],
};

function routeError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizedSocialChannels(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(SOCIAL_KEYS.map(key => {
    const channel = source[key] && typeof source[key] === 'object' ? source[key] : {};
    let url = String(channel.url || '').trim();
    if (url) {
      let parsed;
      try { parsed = new URL(url); } catch { throw routeError(422, `Le lien ${key} doit être une URL HTTP ou HTTPS valide`); }
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.host) {
        throw routeError(422, `Le lien ${key} doit être une URL HTTP ou HTTPS valide`);
      }
      url = url.slice(0, 500);
    }
    return [key, { url, active: channel.active === undefined ? false : Boolean(channel.active) }];
  }));
}

async function getSupportConfig(db) {
  const collection = db.collection('settings');
  let config = await collection.find_one({ id: 'support_config' }, { _id: 0 });
  if (!config) {
    await collection.update_one(
      { id: 'support_config' },
      { $setOnInsert: DEFAULT_SUPPORT_CONFIG },
      true
    );
    config = await collection.find_one({ id: 'support_config' }, { _id: 0 });
  }
  if (!config) throw new Error('Support configuration unavailable');
  for (const [key, value] of Object.entries(DEFAULT_SUPPORT_CONFIG)) {
    if (config[key] === undefined) config[key] = structuredClone(value);
  }
  const socials = normalizedSocialChannels(config.social_channels);
  return {
    telegram_url: config.telegram_url || '',
    whatsapp_url: config.whatsapp_url || '',
    email: config.email || '',
    social_channels: SOCIAL_KEYS
      .map(key => socials[key])
      .map((channel, index) => ({ key: SOCIAL_KEYS[index], ...channel }))
      .filter(channel => channel.active && channel.url),
    faqs: (Array.isArray(config.faqs) ? config.faqs : [])
      .filter(faq => faq && Boolean(faq.active ?? true) && faq.question && faq.answer),
  };
}

function validateAttachments(value) {
  if (value === undefined || value === null) value = [];
  if (!Array.isArray(value) || value.length > 5) {
    throw routeError(422, 'Le nombre de pièces jointes est invalide.');
  }
  return value.map(attachment => {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
      throw routeError(422, 'Pièce jointe invalide');
    }
    if (typeof attachment.name !== 'string' || !attachment.name.trim() || attachment.name.length > 160) {
      throw routeError(422, 'Nom de pièce jointe invalide');
    }
    const type = attachment.type;
    const data = attachment.data;
    if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(type)) {
      throw routeError(422, 'Type de pièce jointe non autorisé');
    }
    let safeData;
    if (type.startsWith('image/')) {
      safeData = validateRasterImage(data, 'Pièce jointe');
      if (safeData.split(';', 1)[0].slice(5).toLowerCase() !== type) {
        throw routeError(422, 'Le type de la pièce jointe ne correspond pas au fichier');
      }
    } else {
      if (typeof data !== 'string' || data.length > 4_200_000) {
        throw routeError(422, 'Pièce jointe PDF invalide ou trop volumineuse');
      }
      const match = data.trim().match(/^data:application\/pdf;base64,([A-Za-z0-9+/]+={0,2})$/i);
      if (!match || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(match[1])) {
        throw routeError(422, 'Les pièces jointes PDF doivent être des données PDF valides');
      }
      const bytes = Buffer.from(match[1], 'base64');
      if (!bytes.length || bytes.length > 2_500_000 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
        throw routeError(422, 'Pièce jointe PDF invalide ou trop volumineuse');
      }
      safeData = `data:application/pdf;base64,${match[1]}`;
    }
    return {
      name: path.basename(attachment.name.replace(/\\/g, '/')).slice(0, 160),
      type,
      data: safeData,
    };
  });
}

function sanitizeStoredAttachments(value) {
  if (!Array.isArray(value)) return [];
  const clean = [];
  for (const attachment of value) {
    try { clean.push(...validateAttachments([attachment])); } catch { /* skip legacy invalid attachment */ }
  }
  return clean;
}

function createSupportRoutes({ db, sessionService }) {
  async function authenticate(req) {
    const session = await sessionService.authenticate(sessionToken(req));
    return session.userId;
  }

  async function handleRoute(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const routeKey = `${req.method} ${url.pathname}`;
    if (![
      'GET /api/support/config',
      'GET /api/support/messages',
      'POST /api/support/messages',
      'GET /api/support/tickets',
      'POST /api/support/tickets',
    ].includes(routeKey)) return false;

    let userId;
    try { userId = await authenticate(req); } catch (error) {
      reply(res, error.status || 401, { detail: error.message || 'Session requise' });
      return true;
    }

    try {
      if (routeKey === 'GET /api/support/config') {
        reply(res, 200, await getSupportConfig(db));
        return true;
      }
      if (routeKey === 'GET /api/support/messages') {
        const collection = db.collection('support_messages');
        const messages = await collection.find(
          { conversation_id: userId }, { _id: 0 }
        ).sort('created_at', 1).to_list(500);
        const safeMessages = messages.map(message => ({
          ...message,
          attachments: sanitizeStoredAttachments(message.attachments),
        }));
        await collection.update_many(
          { conversation_id: userId, sender: 'admin', read_by_user: { $ne: true } },
          { $set: { read_by_user: true, read_at: new Date().toISOString() } }
        );
        reply(res, 200, safeMessages);
        return true;
      }
      if (routeKey === 'POST /api/support/messages') {
        const body = await readJson(req, 22_000_000);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw routeError(422, 'Message invalide');
        }
        const text = body.text === undefined || body.text === null ? '' : body.text;
        if (typeof text !== 'string' || text.length > 5000) {
          throw routeError(422, 'Le message ne peut pas dépasser 5 000 caractères.');
        }
        const attachments = validateAttachments(body.attachments);
        const user = await db.collection('users').find_one(
          { id: userId }, { _id: 0, id: 1, username: 1, full_name: 1 }
        );
        if (!user) throw routeError(404, 'Utilisateur introuvable');
        const message = {
          id: randomUUID(),
          conversation_id: userId,
          sender: 'user',
          sender_id: userId,
          sender_name: user.full_name || user.username,
          text,
          attachments,
          created_at: new Date().toISOString(),
          read_by_user: true,
          read_by_admin: false,
          status: 'sent',
        };
        await db.collection('support_messages').insert_one(message);
        reply(res, 200, message);
        return true;
      }
      if (routeKey === 'GET /api/support/tickets') {
        const tickets = await db.collection('tickets').find(
          { user_id: userId }, { _id: 0 }
        ).sort('created_at', -1).to_list(200);
        reply(res, 200, tickets);
        return true;
      }
      if (routeKey === 'POST /api/support/tickets') {
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw routeError(422, 'Demande de support invalide');
        }
        if (typeof body.subject !== 'string' || body.subject.length < 1 || body.subject.length > 200) {
          throw routeError(422, 'Le sujet doit contenir entre 1 et 200 caractères.');
        }
        if (typeof body.message !== 'string' || body.message.length < 1 || body.message.length > 5000) {
          throw routeError(422, 'Le message doit contenir entre 1 et 5 000 caractères.');
        }
        const category = body.category === undefined ? 'general' : body.category;
        if (!['general', 'technical', 'billing', 'kyc'].includes(category)) {
          throw routeError(422, 'Catégorie de support invalide');
        }
        const ticket = {
          id: randomUUID(),
          user_id: userId,
          subject: body.subject,
          message: body.message,
          category,
          status: 'open',
          created_at: new Date().toISOString(),
          replies: [],
        };
        await db.collection('tickets').insert_one(ticket);
        reply(res, 200, ticket);
        return true;
      }
    } catch (error) {
      reply(res, error.status || 500, {
        detail: error.status ? error.message : 'Erreur interne.',
      });
      return true;
    }
    return false;
  }
  return { handleRoute };
}

module.exports = {
  createSupportRoutes,
  getSupportConfig,
  sanitizeStoredAttachments,
  validateAttachments,
};
