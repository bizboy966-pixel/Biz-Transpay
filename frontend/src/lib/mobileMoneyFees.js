const WHOLE_UNIT_CURRENCIES = new Set(['XOF', 'XAF', 'GNF']);

export function roundMobileMoney(value, currency) {
  const number = Number(value) || 0;
  return WHOLE_UNIT_CURRENCIES.has(String(currency || '').toUpperCase())
    ? Math.round(number)
    : Math.round(number * 100) / 100;
}

function normalizeIncrement(value, increment, currency) {
  const step = Number(increment) || 0;
  if (step <= 0) return roundMobileMoney(value, currency);
  return roundMobileMoney(Math.round(value / step) * step, currency);
}

export function mobileMoneyFeePreview(amount, operator, bearer) {
  const currency = operator?.currency || 'XOF';
  const increment = Number(operator?.amount_increment) || 0;
  const base = normalizeIncrement(amount, increment, currency);
  const gateway = roundMobileMoney(
    base * Number(operator?.gateway_fee_pct || 0) / 100
      + Number(operator?.gateway_fee_fixed || 0),
    currency,
  );
  const platform = roundMobileMoney(
    base * Number(operator?.platform_fee_pct || 0) / 100
      + Number(operator?.platform_fee_fixed || 0),
    currency,
  );
  let totalFee = roundMobileMoney(gateway + platform, currency);
  const clientPays = bearer === 'client' || bearer === 'sender';
  if (clientPays) {
    const totalToPay = normalizeIncrement(base + totalFee, increment, currency);
    totalFee = roundMobileMoney(Math.max(0, totalToPay - base), currency);
    return { base, totalFee, totalToPay, creditedAmount: base };
  }
  return {
    base,
    totalFee,
    totalToPay: base,
    creditedAmount: Math.max(0, roundMobileMoney(base - totalFee, currency)),
  };
}