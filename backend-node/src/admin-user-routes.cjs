'use strict';

const { authorizeAdmin } = require('./admin-authorization.cjs');

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

function createAdminUserRoutes({ db, sessionService, cryptoCatalog, env = process.env }) {
  async function handleRoute(req, res) {
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); }
    catch { return false; }
    if (req.method !== 'GET') return false;
    const listUsers = url.pathname === '/api/admin/users';
    const balanceMatch = /^\/api\/admin\/users\/([^/]+)\/balance-wallets$/.exec(url.pathname);
    const detailMatch = /^\/api\/admin\/users\/([^/]+)$/.exec(url.pathname);
    if (!listUsers && !balanceMatch && !detailMatch) return false;

    try {
      await authorizeAdmin(req, {
        db, sessionService, env,
        permission: 'users:read',
        action: listUsers ? 'admin_list_users'
          : (balanceMatch ? 'admin_user_balance_wallets' : 'admin_get_user'),
      });

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
