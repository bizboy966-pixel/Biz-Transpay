'use strict';

const FIAT_WALLET_CURRENCIES = Object.freeze([
  'XOF', 'XAF', 'CDF', 'USD', 'GMD', 'GNF', 'UGX', 'TZS',
  'KES', 'RWF', 'GHS', 'NGN', 'ZAR', 'ZMW', 'EGP',
]);

const FIAT_WALLET_CURRENCY_SET = new Set(FIAT_WALLET_CURRENCIES);

const MOBILE_MONEY_COUNTRY_CURRENCY = Object.freeze({
  TG: 'XOF', SN: 'XOF', CI: 'XOF', ML: 'XOF', BF: 'XOF', BJ: 'XOF', NE: 'XOF',
  CM: 'XAF', CG: 'XAF', CD: 'CDF', GM: 'GMD', GN: 'GNF', UG: 'UGX',
  TZ: 'TZS', KE: 'KES', RW: 'RWF', GH: 'GHS', NG: 'NGN', ZA: 'ZAR',
  ZM: 'ZMW', EG: 'EGP', US: 'USD',
});

module.exports = {
  FIAT_WALLET_CURRENCIES,
  FIAT_WALLET_CURRENCY_SET,
  MOBILE_MONEY_COUNTRY_CURRENCY,
};
