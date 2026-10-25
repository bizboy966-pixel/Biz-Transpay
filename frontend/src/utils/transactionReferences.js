const PROVIDER_REFERENCE_KEYS = [
  'provider_reference', 'paydunya_disbursement_id', 'paydunya_reference',
  'paydunya_disbursement_token', 'paydunya_invoice_token', 'paydunya_token',
  'afribapay_transaction_id', 'afribapay_order_id', 'mbiyo_transaction_id',
  'fedapay_payout_id', 'fedapay_reference', 'fedapay_id',
  'izipay_payout_id', 'izipay_intent_id', 'provider_id',
  'provider_transaction_id', 'transaction_id',
];

export function getProviderReference(transaction) {
  const metadata = transaction?.metadata || {};
  for (const key of PROVIDER_REFERENCE_KEYS) {
    const value = [transaction?.[key], metadata[key]]
      .find((candidate) => candidate !== undefined && candidate !== null && candidate !== '');
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return null;
}
