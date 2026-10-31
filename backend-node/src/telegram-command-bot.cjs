'use strict';

const { escapeHtml } = require('./telegram-notifications.cjs');
const { loadCredentials } = require('./paydunya-invoice-routes.cjs');
const { loadProviderConfig, sanitizeTotals } = require('./admin-funds-routes.cjs');

const MAX_COMMAND_LENGTH = 100;
const MAX_RESULTS = 20;
const TELEGRAM_LIMIT = 3900;
const SEARCH_COLLECTIONS = [
  'transactions', 'momo_deposits', 'crypto_deposits', 'link_payments',
  'integration_operations',
];
const USER_FIELDS = [
  'id', 'username', 'handle', 'email', 'full_name', 'name', 'phone',
  'phone_number', 'mobile', 'mobile_number', 'telegram_username',
];
const RECORD_FIELDS = [
  'id', 'transaction_id', 'deposit_id', 'reference', 'provider_reference',
  'external_reference', 'order_id', 'operation_id', 'user_id', 'owner_user_id',
  'merchant_id', 'username', 'email', 'phone', 'phone_number', 'mobile',
  'mobile_number', 'sender_phone', 'recipient_phone', 'sender_name',
  'recipient_name', 'full_name', 'name', 'crypto_address', 'wallet_address',
  'tx_hash', 'type', 'transaction_type', 'operation_type', 'direction',
  'metadata.reference', 'metadata.provider_reference', 'metadata.order_id',
  'metadata.phone', 'metadata.phone_number', 'metadata.sender_phone',
  'metadata.recipient_phone', 'metadata.username', 'metadata.email',
];
const OWNER_FIELDS = ['user_id', 'owner_user_id', 'merchant_id'];
const COMMANDS = new Map([
  ['depot', 'deposit'], ['deposit', 'deposit'], ['depots', 'deposit'],
  ['retrait', 'withdrawal'], ['retraits', 'withdrawal'],
  ['withdraw', 'withdrawal'], ['withdrawal', 'withdrawal'],
  ['echange', 'exchange'], ['echanges', 'exchange'], ['exchange', 'exchange'],
  ['total', 'total'], ['help', 'help'], ['aide', 'help'], ['start', 'help'],
]);
const KIND_LABELS = {
  deposit: 'Dépôt', withdrawal: 'Retrait', exchange: 'Échange', total: 'Opération',
};

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim();
}

function parseTelegramCommand(text) {
  const value = String(text || '').trim();
  const separator = value.search(/\s/);
  const head = separator < 0 ? value : value.slice(0, separator);
  const query = separator < 0 ? '' : value.slice(separator).trim();
  const command = normalize(head).replace(/^\/+/, '').split('@', 1)[0];
  return { command: COMMANDS.get(command) || '', query };
}

function valueAtPath(document, path) {
  return path.split('.').reduce((value, part) => value && value[part], document);
}

function textMatches(value, query) {
  const needle = normalize(query);
  const haystack = normalize(value);
  if (needle && haystack.includes(needle)) return true;
  const digits = needle.replace(/\D/g, '');
  return digits.length >= 6 && String(value || '').replace(/\D/g, '').includes(digits);
}

function isForKind(document, collection, kind) {
  if (kind === 'total') return true;
  if (kind === 'deposit' && ['momo_deposits', 'crypto_deposits', 'link_payments'].includes(collection)) return true;
  const type = normalize([
    document.type, document.transaction_type, document.operation_type,
    document.kind, document.category, document.direction, document.flow,
  ].filter(Boolean).join(' '));
  if (kind === 'deposit') return /deposit|pay.?in|recharge|credit/.test(type);
  if (kind === 'withdrawal') return /withdraw|payout|retrait|debit/.test(type);
  return /exchange|echange|conversion/.test(type);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC',
  }).format(date);
}

function maskContact(value, email = false) {
  const text = String(value || '').trim();
  if (email) {
    const at = text.indexOf('@');
    return at > 0 ? `${text.slice(0, 1)}***@${text.slice(at + 1)}` : '—';
  }
  const digits = text.replace(/\D/g, '');
  return digits.length > 4 ? `${digits.slice(0, 3)}••••${digits.slice(-2)}` : '—';
}

function formatRecord(document, collection, kind) {
  const meta = document.metadata && typeof document.metadata === 'object' ? document.metadata : {};
  const reference = document.reference || document.provider_reference || document.external_reference
    || document.order_id || document.operation_id || document.id || document.transaction_id || '—';
  const amount = document.amount_net ?? document.amount ?? document.amount_gross
    ?? document.metadata?.amount ?? '—';
  const currency = document.currency || document.metadata?.currency || '';
  const status = document.status || document.state || '—';
  const phone = document.phone || document.phone_number || document.recipient_phone
    || document.sender_phone || meta.phone || meta.phone_number || meta.recipient_phone;
  const email = document.email || meta.email;
  const operationLabel = collection === 'momo_deposits' ? 'Dépôt Mobile Money'
    : collection === 'crypto_deposits' ? 'Dépôt crypto'
      : collection === 'link_payments' ? 'Paiement par lien'
        : KIND_LABELS[kind] || 'Opération';
  return [
    `<b>${escapeHtml(operationLabel)}</b> — <code>${escapeHtml(reference)}</code>`,
    `Statut : ${escapeHtml(status)} · Montant : <b>${escapeHtml(amount)} ${escapeHtml(currency)}</b>`,
    `Date : ${escapeHtml(formatDate(document.created_at || document.updated_at))}`,
    ...(phone ? [`Téléphone : <code>${escapeHtml(maskContact(phone))}</code>`] : []),
    ...(email ? [`E-mail : <code>${escapeHtml(maskContact(email, true))}</code>`] : []),
  ].join('\n');
}

function chunkMessages(header, blocks, limit = TELEGRAM_LIMIT) {
  const messages = [];
  let current = header;
  for (const block of blocks) {
    if (current.length + block.length + 2 > limit && current !== header) {
      messages.push(current);
      current = header;
    }
    if (current.length + block.length + 2 > limit) {
      messages.push(block.slice(0, limit));
      continue;
    }
    current += `\n\n${block}`;
  }
  if (current) messages.push(current);
  return messages;
}

function createTelegramCommandBot({
  db, env = process.env, fetchImpl = globalThis.fetch, sendMessage,
  logger = console,
} = {}) {
  let running = false;
  let stopping = false;
  let offset = 0;
  let pollerConnection = null;

  const apiRequest = async (method, payload = {}) => {
    const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(method === 'getUpdates' ? 35_000 : 10_000),
    });
    let result = null;
    try { result = await response.json(); } catch { /* handled as an API failure */ }
    return { response, result };
  };

  async function findDocuments(collection, query, options = {}) {
    if (typeof db?.searchTelegramText === 'function') {
      return db.searchTelegramText(collection, {
        fields: collection === 'users' ? USER_FIELDS : RECORD_FIELDS,
        query,
        ownerFields: collection === 'users' ? [] : OWNER_FIELDS,
        ownerIds: options.ownerIds || [],
        limit: options.limit || 100,
      });
    }
    const rows = await db.collection(collection).find({}).sort({ created_at: -1 })
      .limit(2000).to_list(2000);
    const ownerIds = new Set((options.ownerIds || []).map(String));
    return rows.filter(row => (
      (collection !== 'users' && OWNER_FIELDS.some(field => ownerIds.has(String(row[field] || ''))))
      || (collection === 'users' ? USER_FIELDS : RECORD_FIELDS)
        .some(field => textMatches(valueAtPath(row, field), query))
    )).slice(0, options.limit || 100);
  }

  async function searchRecords(query, kind) {
    const userMatches = await findDocuments('users', query, { limit: 100 });
    const userIds = userMatches.map(user => user.id).filter(Boolean).map(String);
    const results = [];
    for (const collection of SEARCH_COLLECTIONS) {
      const records = await findDocuments(collection, query, { ownerIds: userIds, limit: 100 });
      for (const record of records) {
        if (!isForKind(record, collection, kind)) continue;
        results.push({ record, collection });
      }
    }
    const unique = new Map();
    for (const item of results) {
      const key = `${item.collection}:${item.record.id || item.record.transaction_id || item.record.reference}`;
      if (!unique.has(key)) unique.set(key, item);
    }
    return [...unique.values()]
      .sort((a, b) => new Date(b.record.created_at || 0) - new Date(a.record.created_at || 0))
      .slice(0, MAX_RESULTS);
  }

  async function balanceReport() {
    const lines = ['<b>Soldes des comptes prestataires</b>'];
    const readPaydunya = async () => {
      try {
        const saved = await db.collection('settings').find_one({ id: 'payment_provider_paydunya' }, { _id: 0 });
        if (!saved?.enabled) return 'PayDunya : désactivé.';
        const credentials = loadCredentials(saved, env.SESSION_SECRET, env);
        if (!credentials.master_key || !credentials.private_key || !credentials.token) return 'PayDunya : non configuré.';
        const base = saved.mode === 'live' ? 'https://app.paydunya.com' : 'https://app.paydunya.com/sandbox-api';
        const response = await fetchImpl(`${base}/api/v2/disburse/check-balance`, {
          method: 'GET', headers: {
            'PAYDUNYA-MASTER-KEY': credentials.master_key,
            'PAYDUNYA-PRIVATE-KEY': credentials.private_key,
            'PAYDUNYA-TOKEN': credentials.token, accept: 'application/json',
          }, signal: AbortSignal.timeout(15000),
        });
        const payload = response.ok ? await response.json() : null;
        const balance = String(payload?.['Balance TG'] || '').match(/^\s*([\d.,]+)\s*([A-Z]{3})?\s*$/i);
        return balance
          ? `PayDunya : ${balance[1]} ${String(balance[2] || 'XOF').toUpperCase()} (estimation).`
          : 'PayDunya : solde indisponible.';
      } catch { return 'PayDunya : solde indisponible.'; }
    };
    const readMbiyo = async () => {
      try {
        const saved = await db.collection('settings').find_one({ id: 'payment_provider_mbiyo' }, { _id: 0 });
        const config = loadProviderConfig(saved, env);
        if (!config.enabled || !config.apiKey) return 'Mbiyo : désactivé ou non configuré.';
        const response = await fetchImpl(`${config.baseUrl}/balances`, {
          method: 'GET', headers: {
            authorization: `Bearer ${config.apiKey}`, accept: 'application/json',
          }, signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) return 'Mbiyo : solde indisponible.';
        const totals = sanitizeTotals(await response.json());
        return totals.length
          ? `Mbiyo : ${totals.map(item => `${item.balance} ${item.currency}`).join(', ')}`
          : 'Mbiyo : aucun solde retourné.';
      } catch { return 'Mbiyo : solde indisponible.'; }
    };
    const [paydunya, mbiyo] = await Promise.all([readPaydunya(), readMbiyo()]);
    lines.push(paydunya, 'AfriBaPay : lecture de solde non disponible via l’API intégrée.',
      'Easy Change Pay : lecture de solde non disponible via l’API intégrée.', mbiyo,
      'Le solde PayDunya est une estimation.');
    return lines.join('\n');
  }

  async function handleMessage(message, authorizedChatId) {
    if (String(message?.chat?.id ?? '') !== authorizedChatId) return;
    const { command, query } = parseTelegramCommand(message?.text);
    if (!command) return;
    if (command === 'help') {
      await sendMessage(authorizedChatId, [
        '<b>Commandes disponibles</b>',
        '/depot &lt;référence, téléphone, e-mail ou nom&gt;',
        '/retrait &lt;référence, téléphone, e-mail ou nom&gt;',
        '/echange &lt;référence, téléphone, e-mail ou nom&gt;',
        '/total &lt;identifiant ou recherche&gt; — opérations',
        '/total — soldes prestataires',
      ].join('\n'));
      return;
    }
    if (command === 'total' && !query) {
      await sendMessage(authorizedChatId, await balanceReport());
      return;
    }
    if (!query || query.length > MAX_COMMAND_LENGTH) {
      await sendMessage(authorizedChatId, 'Ajoutez une recherche (maximum 100 caractères). Utilisez /help pour les commandes.');
      return;
    }
    try {
      const results = await searchRecords(query, command);
      const label = command === 'total' ? 'Résultats des opérations'
        : `Résultats — ${KIND_LABELS[command]}`;
      const blocks = results.length
        ? results.map(({ record, collection }) => formatRecord(record, collection, command))
        : ['Aucune opération correspondante trouvée.'];
      for (const text of chunkMessages(`<b>${label}</b>`, blocks)) {
        await sendMessage(authorizedChatId, text);
      }
    } catch {
      await sendMessage(authorizedChatId, 'Recherche temporairement indisponible. Réessayez plus tard.');
    }
  }

  async function worker(chatId) {
    while (!stopping) {
      try {
        const { response, result } = await apiRequest('getUpdates', {
          offset, limit: 20, timeout: 25, allowed_updates: ['message'],
        });
        if (!response.ok || !result?.ok || !Array.isArray(result.result)) {
          logger.warn?.(`Telegram polling unavailable (HTTP ${response.status}).`);
          await new Promise(resolve => setTimeout(resolve, 5000));
          continue;
        }
        for (const update of result.result) {
          offset = Math.max(offset, Number(update.update_id || 0) + 1);
          if (update.message) {
            try { await handleMessage(update.message, chatId); } catch {
              logger.warn?.('Telegram command handling failed.');
            }
          }
        }
      } catch (error) {
        if (!stopping) logger.warn?.(`Telegram polling error (${String(error?.name || 'network')}).`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  async function preparePolling() {
    const { response, result } = await apiRequest('getWebhookInfo');
    if (!response.ok || !result?.ok) {
      logger.warn?.(`Telegram webhook check failed (HTTP ${response.status}).`);
      return false;
    }
    if (result.result?.url) {
      const removed = await apiRequest('deleteWebhook', { drop_pending_updates: false });
      if (!removed.response.ok || !removed.result?.ok) {
        logger.warn?.(`Telegram webhook removal failed (HTTP ${removed.response.status}).`);
        return false;
      }
    }
    const commandRegistration = await apiRequest('setMyCommands', {
      commands: [
        { command: 'help', description: 'Afficher les commandes disponibles' },
        { command: 'depot', description: 'Rechercher un dépôt' },
        { command: 'retrait', description: 'Rechercher un retrait' },
        { command: 'echange', description: 'Rechercher un échange' },
        { command: 'total', description: 'Soldes ou recherche globale' },
      ],
    });
    if (!commandRegistration.response.ok || !commandRegistration.result?.ok) {
      logger.warn?.(`Telegram command menu update failed (HTTP ${commandRegistration.response.status}).`);
    }
    return true;
  }

  async function acquirePollerLock() {
    if (typeof db?.pool?.getConnection !== 'function') return true;
    const connection = await db.pool.getConnection();
    try {
      const [rows] = await connection.execute(
        'SELECT GET_LOCK(?, 0) AS acquired', ['biztranspay_telegram_command_poller'],
      );
      if (Number(rows?.[0]?.acquired) !== 1) {
        connection.release();
        return false;
      }
      pollerConnection = connection;
      return true;
    } catch (error) {
      connection.release();
      logger.warn?.(`Telegram poller lock unavailable (${String(error?.code || error?.name || 'database')}).`);
      return false;
    }
  }

  async function releasePollerLock() {
    const connection = pollerConnection;
    pollerConnection = null;
    if (!connection) return;
    try {
      await connection.execute(
        'SELECT RELEASE_LOCK(?)', ['biztranspay_telegram_command_poller'],
      );
      connection.release();
    } catch {
      try { connection.destroy?.(); } catch { /* closing the connection releases its lock */ }
    }
  }

  function start() {
    const production = env.BIZTRANSPAY_MIGRATION_ENV === 'production' || env.NODE_ENV === 'production';
    const enabled = env.TELEGRAM_COMMAND_POLLING_ENABLED === undefined
      ? production : /^(1|true|yes)$/i.test(String(env.TELEGRAM_COMMAND_POLLING_ENABLED));
    const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
    const chatId = String(env.TELEGRAM_CHAT_ID || '').trim();
    if (running || !production || !enabled || !db || !token || !chatId || typeof fetchImpl !== 'function') {
      if (production && enabled && (!token || !chatId)) {
        logger.warn?.('Telegram bot disabled: configure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');
      }
      return false;
    }
    running = true;
    stopping = false;
    void (async () => {
      while (!stopping) {
        try {
          if (await acquirePollerLock()) break;
        } catch (error) {
          logger.warn?.(`Telegram poller lock unavailable (${String(error?.code || error?.name || 'database')}).`);
        }
        if (!stopping) await new Promise(resolve => setTimeout(resolve, 15000));
      }
      while (!stopping) {
        try {
          if (await preparePolling()) break;
        } catch (error) {
          logger.warn?.(`Telegram webhook check failed (${String(error?.name || 'network')}).`);
        }
        await new Promise(resolve => setTimeout(resolve, 15000));
      }
      if (!stopping) await worker(chatId);
      await releasePollerLock();
      running = false;
    })().catch(async () => {
      await releasePollerLock();
      running = false;
      logger.warn?.('Telegram bot worker stopped unexpectedly.');
    });
    return true;
  }

  function stop() {
    stopping = true;
    running = false;
  }

  return { start, stop, handleMessage, searchRecords, balanceReport };
}

module.exports = {
  createTelegramCommandBot, parseTelegramCommand, formatRecord, chunkMessages,
};
