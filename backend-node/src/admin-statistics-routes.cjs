'use strict';

const { authorizeAdmin } = require('./admin-authorization.cjs');
const { getPlatformConfig } = require('./public-config-routes.cjs');
const { ASSET_SPECS, walletField } = require('./crypto-catalog-routes.cjs');

const FIAT_CURRENCIES = new Set([
  'XOF', 'XAF', 'CDF', 'USD', 'GNF', 'GMD', 'UGX', 'TZS', 'KES',
  'RWF', 'GHS', 'NGN', 'ZAR', 'ZMW', 'EGP',
]);
const SUCCESS_STATUSES = new Set([
  'completed', 'success', 'succeeded', 'confirmed', 'paid', 'approved',
]);
const MARGIN_CATEGORIES = [
  ['deposit_mobile_money', 'Dépôts · Mobile Money'],
  ['deposit_crypto', 'Dépôts · Crypto'],
  ['transfer_mobile_money', 'Transferts · Mobile Money'],
  ['transfer_crypto', 'Transferts · Crypto'],
  ['link_payment_mobile_money', 'Liens de paiement · Mobile Money'],
  ['link_payment_crypto', 'Liens de paiement · Crypto'],
  ['api_payment_mobile_money', 'Paiements API · Mobile Money'],
  ['api_payment_crypto', 'Paiements API · Crypto'],
  ['conversion', 'Conversions'],
];
const COUNTRY_CODES = {
  BJ: 'Bénin', BF: 'Burkina Faso', CM: 'Cameroun', CD: 'RD Congo',
  CG: 'Congo', CI: "Côte d’Ivoire", GA: 'Gabon', GH: 'Ghana',
  GN: 'Guinée', ML: 'Mali', NE: 'Niger', NG: 'Nigeria',
  SN: 'Sénégal', TG: 'Togo',
};
const WALLET_CACHE_MS = 60_000;

function reply(res, status, value) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function transactionDocument(row) {
  const transaction = parseObject(row?.transaction_document || row);
  return { ...transaction, metadata: parseObject(transaction.metadata) };
}

function amount(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function country(transaction, account) {
  const metadata = transaction.metadata;
  const candidates = [
    [metadata.country_code, metadata.country_label],
    [transaction.country_code, transaction.country_label],
    [metadata.country, metadata.country_label],
    [transaction.country, transaction.country_label],
    [account.country_code, account.country_name],
    [account.country, account.country_name],
  ];
  for (const [raw, rawLabel] of candidates) {
    const value = String(raw || '').trim();
    const label = String(rawLabel || '').trim();
    if (/^[a-z]{2}$/i.test(value) && value.toUpperCase() !== 'XX') {
      const code = value.toUpperCase();
      let display = label || COUNTRY_CODES[code];
      if (!display) {
        try {
          const localized = new Intl.DisplayNames(['fr'], { type: 'region' }).of(code);
          if (localized && localized.toUpperCase() !== code) display = localized;
        } catch { /* retain the ISO code */ }
      }
      return { code, label: display || code };
    }
    const found = Object.entries(COUNTRY_CODES).find(([, name]) =>
      name.toLocaleLowerCase('fr') === value.toLocaleLowerCase('fr')
      || name.toLocaleLowerCase('fr') === label.toLocaleLowerCase('fr'));
    if (found) return { code: found[0], label: found[1] };
  }
  return { code: 'XX', label: 'Pays non renseigné' };
}

function cryptoTransaction(tx, metadata = tx.metadata) {
  const currency = String(tx.currency || '').trim().toUpperCase();
  return !FIAT_CURRENCIES.has(currency) || [
    'catalog_asset_id', 'asset_code', 'coin', 'crypto', 'network',
  ].some(key => Boolean(metadata[key]));
}

function currencyXofRate(currency, rates) {
  const code = String(currency || '').trim().toUpperCase();
  if (code === 'XOF') return 1;
  const direct = amount(rates?.[`${code}_XOF`]);
  if (direct > 0) return direct;
  const reverse = amount(rates?.[`XOF_${code}`]);
  if (reverse > 0) return 1 / reverse;
  return null;
}

function volumeInXof(tx, conversionRates, cryptoRates) {
  const metadata = tx.metadata;
  let currency = String(tx.currency || metadata.currency || '').trim().toUpperCase();
  let nativeAmount = amount(tx.amount);
  if (nativeAmount === null) return { value: null, currency: currency || 'INCONNUE' };
  nativeAmount = Math.abs(nativeAmount);
  if (String(tx.type || '').toLowerCase() === 'exchange') {
    const destination = String(metadata.to_currency || '').trim().toUpperCase();
    if (destination) {
      currency = destination;
      nativeAmount = Math.abs(amount(metadata.received) ?? nativeAmount);
    }
  }
  if (FIAT_CURRENCIES.has(currency) || currency === 'USDT') {
    const rate = currencyXofRate(currency, conversionRates);
    return { value: rate === null ? null : nativeAmount * rate, currency };
  }
  let usdtAmount = null;
  for (const key of ['amount_net_usdt', 'total_debit_usdt', 'amount_gross_usdt', 'amount_usdt']) {
    const candidate = amount(metadata[key]);
    if (candidate !== null) {
      usdtAmount = Math.abs(candidate);
      break;
    }
  }
  if (usdtAmount === null) {
    const configuredRate = amount(metadata.usdt_rate)
      ?? amount(cryptoRates?.[String(metadata.coin || currency.split('.')[0]).toUpperCase()]);
    if (configuredRate > 0) usdtAmount = nativeAmount * configuredRate;
  }
  const xofRate = currencyXofRate('USDT', conversionRates);
  return {
    value: usdtAmount !== null && xofRate !== null ? usdtAmount * xofRate : null,
    currency: usdtAmount !== null ? 'USDT' : currency || 'INCONNUE',
  };
}

function marginCategory(tx) {
  const metadata = tx.metadata;
  const type = String(tx.type || '').trim().toLowerCase();
  const isCrypto = cryptoTransaction(tx, metadata);
  if (type === 'exchange') return 'conversion';
  if (['deposit', 'deposit_in', 'payin'].includes(type)) {
    const source = String(metadata.source || '').trim().toLowerCase();
    if (['link_payment', 'payment_link'].includes(source)
        || metadata.link_id || metadata.link_payment_id) {
      return isCrypto ? 'link_payment_crypto' : 'link_payment_mobile_money';
    }
    const isApi = ['merchant_api', 'integration_api'].includes(source)
      || ['api', 'merchant_api', 'integration_api'].includes(
        String(metadata.payment_source || '').trim().toLowerCase())
      || metadata.merchant_payment_id
      || String(metadata.idempotency_key || '').startsWith('btpi_')
      || metadata.integration_reference;
    if (isApi) return isCrypto ? 'api_payment_crypto' : 'api_payment_mobile_money';
    return isCrypto ? 'deposit_crypto' : 'deposit_mobile_money';
  }
  if (type === 'transfer') {
    const transferType = String(metadata.transfer_type || tx.transfer_type || '').trim().toLowerCase();
    if (transferType === 'biz_to_crypto') return 'transfer_crypto';
    if (transferType === 'biz_to_mobile') return 'transfer_mobile_money';
  }
  if (type === 'link_payment') return isCrypto ? 'link_payment_crypto' : 'link_payment_mobile_money';
  if (type === 'payment') return isCrypto ? 'api_payment_crypto' : 'api_payment_mobile_money';
  return null;
}

function marginValue(tx) {
  const metadata = tx.metadata;
  const fee = amount(metadata.platform_fee);
  if (fee === null) return null;
  const currency = String(tx.currency || '').trim().toUpperCase();
  if (!FIAT_CURRENCIES.has(currency) && currency !== 'USDT') {
    const storedUsdtFee = amount(metadata.platform_fee_usdt);
    if (storedUsdtFee !== null) return { currency: 'USDT', value: storedUsdtFee };
    const settlementRate = amount(metadata.usdt_rate);
    if (settlementRate > 0) return { currency: 'USDT', value: fee * settlementRate };
  }
  return { currency: currency || 'INCONNUE', value: fee };
}

function aggregateMargins(rows) {
  const categories = Object.fromEntries(MARGIN_CATEGORIES.map(([key, label]) => [
    key, { label, count: 0, _amounts: {} },
  ]));
  const totals = {};
  for (const tx of rows) {
    if (!SUCCESS_STATUSES.has(String(tx.status || '').trim().toLowerCase())) continue;
    if (tx.metadata.platform_fee === null || tx.metadata.platform_fee === undefined) continue;
    const key = marginCategory(tx);
    const value = key && marginValue(tx);
    if (!value || !Number.isFinite(value.value) || value.value === 0) continue;
    const category = categories[key];
    category.count += 1;
    category._amounts[value.currency] = (category._amounts[value.currency] || 0) + value.value;
    totals[value.currency] = (totals[value.currency] || 0) + value.value;
  }
  const moneyRows = values => Object.keys(values).sort().map(currency => ({
    currency, amount: values[currency],
  }));
  return {
    categories: Object.fromEntries(Object.entries(categories).map(([key, value]) => [
      key, { label: value.label, count: value.count, amounts: moneyRows(value._amounts) },
    ])),
    total_by_currency: moneyRows(totals),
  };
}

function aggregateTopCountries(rows, accounts, config) {
  const supported = new Set([
    'deposit', 'deposit_in', 'payin', 'withdrawal', 'payout', 'transfer',
    'exchange', 'link_payment', 'payment',
  ]);
  const totals = new Map();
  for (const tx of rows) {
    const type = String(tx.type || '').trim().toLowerCase();
    if (!supported.has(type)) continue;
    const metadata = tx.metadata;
    const direction = String(tx.direction || '').toLowerCase();
    const transferType = String(metadata.transfer_type || tx.transfer_type || '').toLowerCase();
    if (type === 'transfer' && transferType === 'biz_to_biz' && ['in', 'credit'].includes(direction)) continue;
    const place = country(tx, accounts.get(String(tx.user_id || '')) || {});
    if (!totals.has(place.code)) totals.set(place.code, {
      country_code: place.code, country: place.label, transaction_count: 0,
      volume_xof: 0, unconverted: {},
    });
    const total = totals.get(place.code);
    total.transaction_count += 1;
    if (!SUCCESS_STATUSES.has(String(tx.status || '').trim().toLowerCase())) continue;
    const volume = volumeInXof(tx, config.conversion_rates || {}, config.crypto_usdt_rates || {});
    if (volume.value === null) {
      const native = Math.abs(amount(tx.amount) || 0);
      if (native) total.unconverted[volume.currency] = (total.unconverted[volume.currency] || 0) + native;
    } else {
      total.volume_xof += volume.value;
    }
  }
  return [...totals.values()]
    .sort((a, b) => b.transaction_count - a.transaction_count
      || a.country_code.localeCompare(b.country_code))
    .slice(0, 8)
    .map(row => ({
      country_code: row.country_code,
      country: row.country,
      transaction_count: row.transaction_count,
      volume_xof: row.volume_xof,
      unconverted_volume_by_currency: Object.keys(row.unconverted).sort()
        .map(currency => ({ currency, volume: row.unconverted[currency] })),
    }));
}

function walletDescriptions() {
  const fields = [
    ['balance_xof', { kind: 'fiat', currency: 'XOF' }],
    ['balance_xaf', { kind: 'fiat', currency: 'XAF' }],
    ['balance_usdt', { kind: 'crypto', currency: 'USDT', coin: 'USDT', network: null }],
  ];
  for (const spec of ASSET_SPECS) {
    const field = walletField(spec);
    if (field) fields.push([field, {
      kind: 'crypto', currency: spec.id, coin: spec.coin, network: spec.network,
    }]);
  }
  return fields;
}

function buildWalletBalances(users, config, updatedAt) {
  const totals = new Map(walletDescriptions().map(([field]) => [field, 0]));
  for (const [field] of walletDescriptions()) {
    const value = amount(users[field]);
    if (value !== null) totals.set(field, value);
  }
  const conversionRates = config.conversion_rates || {};
  const cryptoRates = config.crypto_usdt_rates || {};
  const wallets = [];
  const missingRates = [];
  let totalXof = 0;
  let cryptoXof = 0;
  for (const [field, description] of walletDescriptions()) {
    const balance = totals.get(field) || 0;
    if (!balance) continue;
    let rate = null;
    if (description.kind === 'fiat') {
      rate = currencyXofRate(description.currency, conversionRates);
    } else {
      const coinRate = description.coin === 'USDT' ? 1 : amount(cryptoRates[description.coin]);
      const xofRate = currencyXofRate('USDT', conversionRates);
      if (coinRate > 0 && xofRate !== null) rate = coinRate * xofRate;
    }
    const equivalent = rate === null ? null : balance * rate;
    if (equivalent === null) {
      missingRates.push({
        currency: description.currency,
        coin: description.coin || null,
        network: description.network,
      });
    } else {
      totalXof += equivalent;
      if (description.kind === 'crypto') cryptoXof += equivalent;
    }
    wallets.push({
      ...description, balance,
      xof_equivalent: equivalent,
    });
  }
  return {
    total_xof_equivalent: totalXof,
    crypto_xof_equivalent: cryptoXof,
    conversion_complete: missingRates.length === 0,
    missing_rates: missingRates,
    wallets,
    updated_at: updatedAt,
    refresh_seconds: 60,
  };
}

async function aggregateCustomerWallets(collection) {
  const fields = walletDescriptions().map(([field]) => field);
  const pool = collection.store?.pool;
  if (pool && typeof pool.execute === 'function') {
    const expressions = fields.map(field => {
      if (!/^[a-z0-9_]+$/.test(field)) throw new Error('Invalid wallet field');
      const path = `$.${field}`;
      const value = `JSON_UNQUOTE(JSON_EXTRACT(raw_document, '${path}'))`;
      return `COALESCE(SUM(CASE WHEN ${value} REGEXP '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$' THEN CAST(${value} AS DECIMAL(65,18)) ELSE 0 END),0) AS \`${field}\``;
    });
    const [rows] = await pool.execute(
      `SELECT ${expressions.join(', ')} FROM \`users\``,
    );
    return rows?.[0] || {};
  }
  const projection = {
    _id: 0, ...Object.fromEntries(fields.map(field => [field, 1])),
  };
  const users = await collection.find({}, projection).to_list();
  const totals = Object.fromEntries(fields.map(field => [field, 0]));
  for (const user of users) {
    for (const field of fields) {
      const value = amount(user[field]);
      if (value !== null) totals[field] += value;
    }
  }
  return totals;
}

async function rowsForMonth(db, start, end) {
  const range = { created_at: { $gte: start.toISOString(), $lte: end.toISOString() } };
  const [storedRows, momoDeposits, cryptoDeposits] = await Promise.all([
    db.collection('transactions').find(range, { _id: 0 }).to_list(),
    db.collection('momo_deposits').find(range, { _id: 0 }).to_list(),
    db.collection('crypto_deposits').find(range, { _id: 0 }).to_list(),
  ]);
  const apiTransactionIds = new Set();
  const apiOperationIds = new Set();
  for (const deposit of momoDeposits) {
    const id = String(deposit.id || '');
    const source = String(deposit.source || '').trim().toLowerCase();
    const api = String(deposit.idempotency_key || '').startsWith('btpi_')
      || ['api', 'merchant_api', 'integration_api'].includes(source);
    if (!id || !api || ['link_payment', 'payment_link'].includes(source)) continue;
    apiTransactionIds.add(`${String(deposit.provider || 'paydunya').toLowerCase()}-deposit-${id}`);
  }
  for (const deposit of cryptoDeposits) {
    if (String(deposit.idempotency_key || '').startsWith('btpi_') && deposit.id) {
      apiOperationIds.add(`izipay:deposit:${deposit.id}`);
    }
  }
  const rows = storedRows.map(transactionDocument);
  for (const tx of rows) {
    if (apiTransactionIds.has(String(tx.id || ''))
        || apiOperationIds.has(String(tx.metadata.operation_id || ''))) {
      tx.metadata.payment_source = 'integration_api';
    }
  }
  const userIds = [...new Set(rows.map(tx => String(tx.user_id || '')).filter(Boolean))];
  const accountRows = userIds.length
    ? await db.collection('users').find({ id: { $in: userIds } }, {
      _id: 0, id: 1, country: 1, country_code: 1, country_name: 1,
    }).to_list()
    : [];
  const accounts = new Map(accountRows.map(user => [String(user.id), user]));
  return { rows, accounts };
}

function statisticsOperation(tx) {
  const type = String(tx.type || '').trim().toLowerCase();
  if (['deposit', 'deposit_in', 'payin'].includes(type)) return 'deposits';
  if (type === 'exchange') return 'exchanges';
  if (['withdrawal', 'payout'].includes(type)) return 'withdrawals';
  const metadata = tx.metadata || {};
  const transferType = String(metadata.transfer_type || tx.transfer_type || '').toLowerCase();
  const direction = String(tx.direction || '').toLowerCase();
  if (type === 'transfer'
      && ['out', 'debit'].includes(direction)
      && ['biz_to_mobile', 'biz_to_crypto'].includes(transferType)) return 'withdrawals';
  return null;
}

function statisticsBuckets(period, start, end) {
  const bucket = new Date(start);
  if (period === '24h') bucket.setUTCMinutes(0, 0, 0);
  else if (period === '1y') bucket.setUTCDate(1), bucket.setUTCHours(0, 0, 0, 0);
  else bucket.setUTCHours(0, 0, 0, 0);
  const last = new Date(end);
  if (period === '24h') last.setUTCMinutes(0, 0, 0);
  else if (period === '1y') last.setUTCDate(1), last.setUTCHours(0, 0, 0, 0);
  else last.setUTCHours(0, 0, 0, 0);
  const buckets = [];
  while (bucket <= last) {
    buckets.push(new Date(bucket));
    if (period === '24h') bucket.setUTCHours(bucket.getUTCHours() + 1);
    else if (period === '1y') bucket.setUTCMonth(bucket.getUTCMonth() + 1);
    else bucket.setUTCDate(bucket.getUTCDate() + 1);
  }
  return buckets;
}

function aggregatePeriodStatistics(rows, accounts, period, start, end) {
  const operationTypes = ['deposits', 'withdrawals', 'exchanges'];
  const timeline = new Map(statisticsBuckets(period, start, end).map(bucket => {
    const key = bucket.toISOString();
    return [key, {
      bucket: key, transaction_count: 0, deposits: 0, withdrawals: 0,
      exchanges: 0, _volumes: new Map(),
    }];
  }));
  const summary = {
    transaction_count: 0,
    volume_by_currency: new Map(),
    operations: Object.fromEntries(operationTypes.map(type => [
      type, { count: 0, volume_by_currency: new Map() },
    ])),
  };
  const countries = new Map();
  const successful = SUCCESS_STATUSES;
  const add = (map, currency, operation, value) => {
    const entry = map.get(currency) || { total: 0, deposits: 0, withdrawals: 0, exchanges: 0 };
    entry.total += value;
    entry[operation] += value;
    map.set(currency, entry);
  };
  for (const source of rows) {
    const tx = transactionDocument(source);
    const createdAt = new Date(tx.created_at || '');
    if (!Number.isFinite(createdAt.getTime()) || createdAt < start || createdAt > end) continue;
    const operation = statisticsOperation(tx);
    if (!operation) continue;
    const startBucket = new Date(createdAt);
    if (period === '24h') startBucket.setUTCMinutes(0, 0, 0);
    else if (period === '1y') startBucket.setUTCDate(1), startBucket.setUTCHours(0, 0, 0, 0);
    else startBucket.setUTCHours(0, 0, 0, 0);
    const row = timeline.get(startBucket.toISOString());
    if (!row) continue;
    row[operation] += 1;
    row.transaction_count += 1;
    summary.transaction_count += 1;
    summary.operations[operation].count += 1;

    const location = country(tx, accounts.get(String(tx.user_id || '')) || {});
    const countryRow = countries.get(location.code) || {
      country_code: location.code, country: location.label,
      transaction_count: 0, _volumes: new Map(),
    };
    countryRow.transaction_count += 1;
    countries.set(location.code, countryRow);

    if (!successful.has(String(tx.status || '').trim().toLowerCase())) continue;
    const metadata = tx.metadata || {};
    const currency = String(tx.currency || metadata.currency || '').trim().toUpperCase();
    const value = amount(tx.amount);
    if (!/^[A-Z0-9][A-Z0-9._-]{1,20}$/.test(currency) || value === null) continue;
    const absoluteAmount = Math.abs(value);
    add(summary.volume_by_currency, currency, operation, absoluteAmount);
    add(summary.operations[operation].volume_by_currency, currency, operation, absoluteAmount);
    add(row._volumes, currency, operation, absoluteAmount);
    const countryVolume = countryRow._volumes.get(currency) || 0;
    countryRow._volumes.set(currency, countryVolume + absoluteAmount);
  }
  const amountRows = map => [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, values]) => ({
      currency, total: values.total,
      ...Object.fromEntries(operationTypes.map(type => [type, values[type]])),
    }));
  return {
    summary: {
      transaction_count: summary.transaction_count,
      volume_by_currency: amountRows(summary.volume_by_currency),
      operations: Object.fromEntries(operationTypes.map(type => [type, {
        count: summary.operations[type].count,
        volume_by_currency: [...summary.operations[type].volume_by_currency.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([currency, values]) => ({ currency, volume: values.total })),
      }])),
    },
    timeline: [...timeline.values()].map(row => ({
      bucket: row.bucket,
      transaction_count: row.transaction_count,
      deposits: row.deposits,
      withdrawals: row.withdrawals,
      exchanges: row.exchanges,
      volume_by_currency: amountRows(row._volumes),
    })),
    countries: [...countries.values()].sort((a, b) =>
      b.transaction_count - a.transaction_count || a.country_code.localeCompare(b.country_code))
      .map(row => ({
        country_code: row.country_code,
        country: row.country,
        transaction_count: row.transaction_count,
        volume_by_currency: [...row._volumes.entries()].sort(([a], [b]) => a.localeCompare(b))
          .map(([currency, volume]) => ({ currency, volume })),
      })),
  };
}

function emptyChannel() {
  const status = () => ({ count: 0, amount: 0 });
  return {
    count: 0, amount_xof: 0, amount_usdt: 0,
    pending: status(), valid: status(), rejected: status(),
  };
}

function aggregateAdminHome(users, sourceRows, period) {
  const transactions = sourceRows.map(transactionDocument);
  const activeUsers = new Set();
  const totals = {
    total_deposits: 0, total_withdrawals: 0, count: 0,
    succeeded: 0, pending: 0, failed: 0,
  };
  const statusBucket = () => ({ count: 0, amount: 0 });
  const depPending = statusBucket();
  const depValid = statusBucket();
  const depRejected = statusBucket();
  const wdPending = statusBucket();
  const wdValid = statusBucket();
  const wdRejected = statusBucket();
  const depMm = emptyChannel();
  const depCrypto = emptyChannel();
  const wdMm = emptyChannel();
  const wdCrypto = emptyChannel();
  const operations = {
    link_payments: { count: 0, amount_usdt: 0 },
    api_payments: { count: 0, amount_usdt: 0 },
    biz_to_biz: { count: 0 },
    exchanges: { count: 0 },
  };
  for (const tx of transactions) {
    totals.count += 1;
    const status = String(tx.status || '').toLowerCase();
    if (status === 'completed') totals.succeeded += 1;
    else if (status === 'pending') totals.pending += 1;
    else if (['failed', 'cancelled'].includes(status)) totals.failed += 1;
    if (tx.user_id) activeUsers.add(String(tx.user_id));
    const type = String(tx.type || '').toLowerCase();
    const direction = String(tx.direction || '').toLowerCase();
    const currency = String(tx.currency || '').toUpperCase();
    const metadata = tx.metadata;
    const txAmount = amount(tx.amount) || 0;
    const bucket = (target, value) => {
      target.count += 1;
      target.amount += value;
    };
    if (type === 'deposit' || (['link_payment', 'payment'].includes(type) && direction === 'in')) {
      if (status === 'completed') {
        bucket(depValid, txAmount);
        totals.total_deposits += txAmount;
      } else if (status === 'pending') bucket(depPending, txAmount);
      else if (['failed', 'cancelled'].includes(status)) bucket(depRejected, txAmount);
      const isCrypto = currency === 'USDT' || Boolean(metadata.izipay_intent_id) || Boolean(metadata.coin);
      const channel = isCrypto ? depCrypto : depMm;
      if (status === 'completed') {
        channel.count += 1;
        if (isCrypto) channel.amount_usdt += txAmount;
        else channel.amount_xof += txAmount;
        bucket(channel.valid, txAmount);
      } else if (status === 'pending') bucket(channel.pending, txAmount);
      else if (['failed', 'cancelled'].includes(status)) bucket(channel.rejected, txAmount);
      if (type === 'link_payment' && status === 'completed') {
        operations.link_payments.count += 1;
        operations.link_payments.amount_usdt += txAmount;
      } else if (type === 'payment' && status === 'completed') {
        operations.api_payments.count += 1;
        operations.api_payments.amount_usdt += txAmount;
      }
      continue;
    }
    if (['withdrawal', 'transfer'].includes(type) && direction === 'out') {
      const transferType = String(metadata.transfer_type || '').toLowerCase();
      if (transferType === 'biz_to_biz') {
        operations.biz_to_biz.count += 1;
        continue;
      }
      if (status === 'completed') {
        bucket(wdValid, txAmount);
        totals.total_withdrawals += txAmount;
      } else if (status === 'pending') bucket(wdPending, txAmount);
      else if (['failed', 'cancelled'].includes(status)) bucket(wdRejected, txAmount);
      const isCrypto = transferType === 'biz_to_crypto' || currency === 'USDT' || Boolean(metadata.crypto);
      const channel = isCrypto ? wdCrypto : wdMm;
      if (status === 'completed') {
        channel.count += 1;
        if (isCrypto) channel.amount_usdt += txAmount;
        else channel.amount_xof += txAmount;
        bucket(channel.valid, txAmount);
      } else if (status === 'pending') bucket(channel.pending, txAmount);
      else if (['failed', 'cancelled'].includes(status)) bucket(channel.rejected, txAmount);
      continue;
    }
    if (type === 'transfer' && direction === 'in'
        && String(metadata.transfer_type || 'biz_to_biz').toLowerCase() === 'biz_to_biz') {
      operations.biz_to_biz.count += 1;
    } else if (type === 'exchange') {
      operations.exchanges.count += 1;
    }
  }
  const verified = users.filter(user => user.kyc_status === 'verified').length;
  return {
    users: {
      total: users.length,
      verified,
      kyc_pending: users.filter(user => user.kyc_status === 'pending').length,
      kyc_rejected: users.filter(user => user.kyc_status === 'rejected').length,
      not_verified: users.length - verified,
      active: activeUsers.size,
      suspended: users.filter(user => user.is_blocked === true || user.is_banned === true).length,
    },
    transactions: {
      ...totals,
      deposits: { pending: depPending, valid: depValid, rejected: depRejected },
      withdrawals: { pending: wdPending, valid: wdValid, rejected: wdRejected },
      deposits_by_channel: { mobile_money: depMm, crypto: depCrypto },
      withdrawals_by_channel: { mobile_money: wdMm, crypto: wdCrypto },
      operations,
    },
    period,
  };
}

function createAdminStatisticsRoutes({ db, sessionService, env = process.env }) {
  let walletCache = { expiresAt: 0, snapshot: null };
  let homeCache = { expiresAt: 0, snapshot: null };

  async function handleRoute(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const isPeriodStats = req.method === 'GET' && url.pathname === '/api/admin/statistics';
    const isDashboard = req.method === 'GET' && url.pathname === '/api/admin/statistics/dashboard';
    const isWallets = req.method === 'GET' && url.pathname === '/api/admin/statistics/wallet-balances';
    const isHomeStats = req.method === 'GET' && url.pathname === '/api/admin/stats';
    const isBenefits = req.method === 'GET' && url.pathname === '/api/admin/benefits';
    const isBenefitDetails = req.method === 'GET' && url.pathname === '/api/admin/benefits/details';
    if (!isPeriodStats && !isDashboard && !isWallets && !isHomeStats && !isBenefits && !isBenefitDetails) return false;
    try {
      await authorizeAdmin(req, {
        db, sessionService, env, permission: 'finance:read',
        action: isBenefits ? 'read_admin_benefits'
          : isBenefitDetails ? 'read_admin_benefit_details'
            : isPeriodStats || isDashboard ? 'read_admin_statistics'
              : isWallets ? 'read_admin_wallet_balances' : 'read_admin_summary',
      });
      if (isPeriodStats) {
        const period = String(url.searchParams.get('period') || '7d').trim().toLowerCase();
        if (!['24h', '7d', '30d', '1y'].includes(period)) {
          reply(res, 400, { detail: 'Période invalide. Choisissez 24h, 7d, 30d ou 1y.' });
          return true;
        }
        const end = new Date();
        const start = new Date(end);
        if (period === '1y') {
          const targetYear = end.getUTCFullYear() - 1;
          const targetDay = Math.min(end.getUTCDate(), new Date(Date.UTC(
            targetYear, end.getUTCMonth() + 1, 0,
          )).getUTCDate());
          start.setUTCFullYear(targetYear);
          start.setUTCDate(targetDay);
        } else {
          const days = period === '24h' ? 1 : Number.parseInt(period, 10);
          start.setTime(end.getTime() - days * 86_400_000);
        }
        const { rows, accounts } = await rowsForMonth(db, start, end);
        const statistics = aggregatePeriodStatistics(rows, accounts, period, start, end);
        const generatedAt = new Date().toISOString();
        reply(res, 200, {
          period, from: start.toISOString(), to: end.toISOString(),
          generated_at: generatedAt, ...statistics, provider_liquidity: [],
        });
        return true;
      }
      if (isHomeStats) {
        const periodValue = String(url.searchParams.get('period') || 'month');
        const period = ['day', 'week', 'month', 'year'].includes(periodValue)
          ? periodValue : 'month';
        if (homeCache.snapshot && homeCache.expiresAt > Date.now()) {
          reply(res, 200, { ...homeCache.snapshot, period });
          return true;
        }
        const [users, transactions] = await Promise.all([
          db.collection('users').find({}, {
            _id: 0, id: 1, kyc_status: 1, is_blocked: 1, is_banned: 1,
          }).to_list(),
          db.collection('transactions').find({}, { _id: 0 }).to_list(),
        ]);
        const snapshot = aggregateAdminHome(users, transactions, period);
        homeCache = { snapshot, expiresAt: Date.now() + 15_000 };
        reply(res, 200, snapshot);
        return true;
      }
      if (isBenefits || isBenefitDetails) {
        const period = String(url.searchParams.get('period') || 'all');
        if (!['all', '7d', '30d'].includes(period)) {
          reply(res, 422, { detail: 'Période invalide.' });
          return true;
        }
        const query = {
          status: { $in: ['completed', 'paid'] },
          'metadata.platform_fee': { $exists: true, $ne: null },
        };
        if (period !== 'all') {
          const days = period === '7d' ? 7 : 30;
          query.created_at = { $gte: new Date(Date.now() - days * 86_400_000).toISOString() };
        }
        if (isBenefits) {
          const rows = (await db.collection('transactions').find(query, { _id: 0 }).to_list())
            .map(transactionDocument);
          const totals = {
            XOF: { total: 0, count: 0 },
            XAF: { total: 0, count: 0 },
            USDT: { total: 0, count: 0 },
          };
          for (const tx of rows) {
            if (!marginCategory(tx)) continue;
            const value = marginValue(tx);
            if (!value || !Number.isFinite(value.value) || !Object.hasOwn(totals, value.currency)) continue;
            totals[value.currency].total += value.value;
            totals[value.currency].count += 1;
          }
          reply(res, 200, {
            xof: totals.XOF,
            xaf: totals.XAF,
            usdt: totals.USDT,
            period,
          });
          return true;
        }

        const rawLimit = url.searchParams.get('limit');
        const rawOffset = url.searchParams.get('offset');
        const limit = rawLimit == null ? 100 : Number(rawLimit);
        const offset = rawOffset == null ? 0 : Number(rawOffset);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500
            || !Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
          reply(res, 422, { detail: 'Pagination invalide.' });
          return true;
        }
        const type = String(url.searchParams.get('type') || '').trim();
        const currency = String(url.searchParams.get('currency') || '').trim().toUpperCase();
        const search = String(url.searchParams.get('q') || '').trim();
        if (type.length > 50 || search.length > 80
            || (currency && !['XOF', 'XAF', 'USDT'].includes(currency))) {
          reply(res, 422, { detail: 'Filtre invalide.' });
          return true;
        }
        if (type) query.type = type;
        if (search) {
          const literal = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const matchingUsers = await db.collection('users').find({
            $or: [
              { full_name: { $regex: literal, $options: 'i' } },
              { email: { $regex: literal, $options: 'i' } },
              { phone: { $regex: literal, $options: 'i' } },
            ],
          }, { _id: 0, id: 1 }).to_list(200);
          query.$or = [
            { reference: { $regex: literal, $options: 'i' } },
            { description: { $regex: literal, $options: 'i' } },
            { id: search },
            ...(matchingUsers.length
              ? [{ user_id: { $in: matchingUsers.map(user => user.id) } }]
              : []),
          ];
        }
        let rows = (await db.collection('transactions').find(query, { _id: 0 })
          .sort('created_at', -1).to_list()).map(transactionDocument)
          .filter(tx => marginCategory(tx));
        if (search) {
          rows = rows.filter(tx => marginCategory(tx));
        }
        if (currency) {
          rows = rows.filter(tx => marginValue(tx)?.currency === currency);
        }
        const total = rows.length;
        const page = rows.slice(offset, offset + limit);
        const ids = [...new Set(page.map(tx => String(tx.user_id || '')).filter(Boolean))];
        const users = ids.length
          ? await db.collection('users').find({ id: { $in: ids } }, {
            _id: 0, id: 1, full_name: 1, email: 1,
          }).to_list(ids.length)
          : [];
        const byId = new Map(users.map(user => [String(user.id), user]));
        const labels = {
          deposit: 'Frais dépôt',
          withdrawal: 'Frais retrait',
          transfer: 'Frais retrait',
          link_payment: 'Frais lien',
          payment: 'Frais API',
          exchange: 'Frais conversion',
        };
        reply(res, 200, {
          total, limit, offset,
          items: page.map(tx => {
            const value = marginValue(tx) || { currency: tx.currency || '', value: 0 };
            const metadata = tx.metadata || {};
            const user = byId.get(String(tx.user_id || '')) || {};
            return {
              tx_id: tx.id,
              date: tx.created_at,
              type: tx.type,
              type_label: labels[tx.type] || tx.type,
              reference: tx.reference || null,
              user: { id: tx.user_id || null, name: user.full_name || null, email: user.email || null },
              currency: tx.currency,
              amount: Number(tx.amount) || 0,
              platform_fee: value.value,
              benefit_currency: value.currency,
              gateway_fee: Number(metadata.gateway_fee) || 0,
              fee_total: Number(metadata.fee) || 0,
              description: tx.description || null,
            };
          }),
        });
        return true;
      }
      if (isDashboard) {
        const now = new Date();
        const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const end = new Date(now);
        const [{ rows, accounts }, config] = await Promise.all([
          rowsForMonth(db, start, end),
          getPlatformConfig(db),
        ]);
        reply(res, 200, {
          period: 'month',
          from: start.toISOString(),
          to: end.toISOString(),
          generated_at: now.toISOString(),
          top_countries: aggregateTopCountries(rows, accounts, config),
          margins: aggregateMargins(rows),
        });
        return true;
      }

      const force = ['true', '1'].includes(String(url.searchParams.get('refresh') || '').toLowerCase());
      if (!force && walletCache.snapshot && walletCache.expiresAt > Date.now()) {
        reply(res, 200, walletCache.snapshot);
        return true;
      }
      const [totals, config] = await Promise.all([
        aggregateCustomerWallets(db.collection('users')),
        getPlatformConfig(db),
      ]);
      const snapshot = buildWalletBalances(totals, config, new Date().toISOString());
      walletCache = { snapshot, expiresAt: Date.now() + WALLET_CACHE_MS };
      reply(res, 200, snapshot);
      return true;
    } catch (error) {
      reply(res, error.status || 503, {
        detail: error.status ? error.message : 'Les statistiques sont temporairement indisponibles.',
      });
      return true;
    }
  }

  return { handleRoute };
}

module.exports = {
  aggregateAdminHome,
  aggregatePeriodStatistics,
  aggregateMargins,
  aggregateTopCountries,
  aggregateCustomerWallets,
  buildWalletBalances,
  createAdminStatisticsRoutes,
};
