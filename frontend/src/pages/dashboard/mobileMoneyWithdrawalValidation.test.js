import {
  getMobileMoneyCountryCurrency,
  getMobileMoneyWithdrawalBlockers,
} from './mobileMoneyWithdrawalValidation';

const validWithdrawal = {
  operator: { code: 'orange_cm' },
  currency: 'XAF',
  phone: ' 690000000 ',
  amount: 500,
  min: 100,
  max: 50000,
  recipientGets: 500,
  totalDebit: 518,
  balance: 2000,
};

describe('Mobile Money withdrawal form validation', () => {
  test.each([
    ['TG', 'XOF'],
    ['CM', 'XAF'],
    ['CD', 'CDF'],
    ['GN', 'GNF'],
    ['UG', 'UGX'],
  ])('detects the %s wallet currency as %s', (country, expected) => {
    expect(getMobileMoneyCountryCurrency(country, [])).toBe(expected);
  });

  test('uses the configured country route for countries outside the built-in list', () => {
    expect(getMobileMoneyCountryCurrency('US', [
      { country: 'US', currency: 'USD' },
    ])).toBe('USD');
  });

  test('explains the fee-inclusive balance shortfall and how to proceed', () => {
    expect(getMobileMoneyWithdrawalBlockers({
      ...validWithdrawal,
      balance: 500,
    })).toEqual([
      'Solde insuffisant : 500 XAF disponibles, 518 XAF requis. Choisissez « Le bénéficiaire paie » ou ajoutez du solde.',
    ]);
  });

  test('allows continuation when the balance covers the amount and fees', () => {
    expect(getMobileMoneyWithdrawalBlockers(validWithdrawal)).toEqual([]);
  });

  test('checks the principal against balance when the beneficiary pays fees', () => {
    expect(getMobileMoneyWithdrawalBlockers({
      ...validWithdrawal,
      totalDebit: 500,
      recipientGets: 482,
      balance: 500,
    })).toEqual([]);
  });

  test('identifies empty phone, fractional amounts, and amount limits', () => {
    expect(getMobileMoneyWithdrawalBlockers({
      ...validWithdrawal,
      phone: ' ',
      amount: 99.5,
    })).toEqual([
      'Saisissez le numéro Mobile Money du bénéficiaire.',
      'Saisissez un montant entier valide en XAF.',
    ]);
    expect(getMobileMoneyWithdrawalBlockers({
      ...validWithdrawal,
      amount: 90,
    })).toEqual(['Le montant minimum est 100 XAF.']);
  });
});
