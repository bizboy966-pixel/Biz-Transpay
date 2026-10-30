'use strict';

const security = require('./security.cjs');

function decryptSetting(config, field, sessionSecret) {
  const encrypted = config?.[`${field}_encrypted`];
  if (!encrypted) return String(config?.[field] || '').trim();
  if (!sessionSecret) {
    throw Object.assign(new Error('Identifiants du prestataire indisponibles.'), { status: 503 });
  }
  try {
    return security.decryptFernet(encrypted, security.fernetKey(sessionSecret));
  } catch {
    throw Object.assign(new Error('Identifiants du prestataire illisibles.'), { status: 503 });
  }
}

module.exports = { decryptSetting };
