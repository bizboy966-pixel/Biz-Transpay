'use strict';

const ROLE_PERMISSIONS = {
  USER: [],
  MERCHANT: ['merchant:api'],
  SUPPORT: ['users:read', 'support:read', 'support:write'],
  FINANCE: [
    'users:read', 'finance:read', 'transactions:read', 'transactions:write',
    'balances:write', 'fees:read', 'fees:write', 'providers:read',
  ],
  COMPLIANCE: ['users:read', 'kyc:read', 'kyc:write'],
  ADMIN: [
    'users:read', 'users:write', 'notifications:send', 'finance:read',
    'transactions:read', 'transactions:write', 'balances:write', 'fees:read',
    'fees:write', 'providers:read', 'providers:write', 'kyc:read', 'kyc:write',
    'links:read', 'links:write', 'support:read', 'support:write',
    'settings:read', 'settings:write', 'audit:read', 'admin_users:read',
  ],
  SUPER_ADMIN: ['*'],
};
const { FIAT_WALLET_CURRENCIES } = require('./supported-currencies.cjs');

const ASSETS = [
  ['USDC.POLYGON', 'USDC', 'USD Coin', 'POLYGON', 'Polygon'],
  ['USDC.SOL', 'USDC', 'USD Coin', 'SOL', 'Solana'],
  ['USDC.BEP20', 'USDC', 'USD Coin', 'BEP20', 'BNB Smart Chain (BEP20)'],
  ['USDC.ERC20', 'USDC', 'USD Coin', 'ERC20', 'Ethereum (ERC20)'],
  ['USDT.POLYGON', 'USDT', 'Tether', 'POLYGON', 'Polygon'],
  ['USDT.BEP20', 'USDT', 'Tether', 'BEP20', 'BNB Smart Chain (BEP20)'],
  ['USDT.SOL', 'USDT', 'Tether', 'SOL', 'Solana'],
  ['USDT.TRC20', 'USDT', 'Tether', 'TRC20', 'Tron (TRC20)'],
  ['USDT.TON', 'USDT', 'Tether', 'TON', 'TON'],
  ['USDT.ERC20', 'USDT', 'Tether', 'ERC20', 'Ethereum (ERC20)'],
  ['BNB.BNB', 'BNB', 'BNB', 'BNB', 'BNB (natif)'],
  ['BTC.BTC', 'BTC', 'Bitcoin', 'BTC', 'Bitcoin (natif)'],
  ['SOL.SOL', 'SOL', 'Solana', 'SOL', 'Solana (natif)'],
  ['TON.TON', 'TON', 'Toncoin', 'TON', 'TON (natif)'],
  ['TRX.TRX', 'TRX', 'TRON', 'TRX', 'TRON (natif)'],
  ['ETH.ETH', 'ETH', 'Ethereum', 'ETH', 'Ethereum (natif)'],
].map(([id, coin, name, network, network_name]) => ({
  id, coin, name, network, network_name,
  balanceField: `balance_crypto_${`${coin}_${network}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`,
}));

function isAdminAccount(user) {
  return ['admin', 'super_admin'].includes(user?.role);
}

function effectiveRole(user) {
  if (user?.role === 'super_admin') return 'SUPER_ADMIN';
  if (user?.role === 'admin') {
    const role = String(user.admin_role || 'general').toLowerCase();
    return ({ support: 'SUPPORT', finance: 'FINANCE', compliance: 'COMPLIANCE' })[role] || 'ADMIN';
  }
  return user?.account_type === 'merchant' ? 'MERCHANT' : 'USER';
}

function numberOrZero(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function normalizeDate(value, fallback) {
  if (!value) return fallback;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function publicUser(user) {
  const role = effectiveRole(user);
  const cryptoWallets = ASSETS.map(asset => ({
    id: asset.id,
    coin: asset.coin,
    name: asset.name,
    network: asset.network,
    network_name: asset.network_name,
    balance: numberOrZero(user[asset.balanceField]),
  }));
  const cryptoBalances = Object.fromEntries(
    cryptoWallets.map(wallet => [wallet.id, wallet.balance]));
  const balances = Object.fromEntries(FIAT_WALLET_CURRENCIES
    .filter(code => !['XOF', 'XAF'].includes(code))
    .map(code => [
    `balance_${code.toLowerCase()}`, numberOrZero(user[`balance_${code.toLowerCase()}`]),
  ]));

  return {
    id: user.id,
    full_name: user.full_name,
    username: user.username,
    account_type: user.account_type,
    country: user.country,
    phone: user.phone,
    email: user.email,
    kyc_status: user.kyc_status || 'not_started',
    balance_xof: numberOrZero(user.balance_xof),
    balance_xaf: numberOrZero(user.balance_xaf),
    balance_usdt: numberOrZero(user.balance_usdt),
    ...balances,
    crypto_wallets: cryptoWallets,
    crypto_wallet_balances: cryptoBalances,
    created_at: normalizeDate(user.created_at, new Date().toISOString()),
    two_fa_enabled: Boolean(user.two_fa_enabled),
    admin_pin_enabled: Boolean(isAdminAccount(user) && user.admin_pin_hash),
    user_pin_enabled: Boolean(!isAdminAccount(user) && user.user_pin_hash),
    language: user.language || 'fr',
    default_currency: user.default_currency || 'XOF',
    avatar_url: user.avatar_url ?? null,
    role: user.role || 'user',
    admin_role: user.admin_role ?? null,
    effective_role: role,
    permissions: [...(ROLE_PERMISSIONS[role] || [])].sort(),
    is_blocked: Boolean(user.is_blocked),
    is_banned: Boolean(user.is_banned),
    withdrawals_blocked: Boolean(user.withdrawals_blocked),
  };
}

function ownerEligible(user, platformOwnerEmail, claimBefore) {
  if (user.platform_owner === true) return true;
  if (!platformOwnerEmail
      || String(user.email || '').trim().toLowerCase() !== platformOwnerEmail.toLowerCase()) return false;
  const created = Date.parse(user.created_at);
  const cutoff = Date.parse(claimBefore);
  return Number.isFinite(created) && Number.isFinite(cutoff) && created <= cutoff;
}

async function ensurePlatformOwnerRole(db, user, {
  platformOwnerEmail = process.env.PLATFORM_OWNER_EMAIL || '',
  claimBefore = process.env.PLATFORM_OWNER_CLAIM_BEFORE || '',
} = {}) {
  if (!ownerEligible(user, platformOwnerEmail, claimBefore)) return user;
  const expected = {
    platform_owner: true,
    role: 'super_admin',
    kyc_status: 'verified',
    is_blocked: false,
    is_banned: false,
    withdrawals_blocked: false,
  };
  if (Object.entries(expected).every(([key, value]) => user[key] === value)
      && !user.admin_role) return user;
  const updated = await db.collection('users').update_one({ id: user.id }, {
    $set: expected, $unset: { admin_role: '' },
  });
  if (updated.matched_count !== 1) {
    const error = new Error("Impossible d'activer le propriétaire de la plateforme");
    error.status = 409;
    throw error;
  }
  const restored = { ...user, ...expected };
  delete restored.admin_role;
  return restored;
}

module.exports = {
  ROLE_PERMISSIONS, ASSETS, isAdminAccount, effectiveRole, publicUser,
  ensurePlatformOwnerRole,
};
