import { getProviderReference } from './transactionReferences';

test.each([
  'paydunya_disbursement_id', 'paydunya_invoice_token', 'paydunya_disbursement_token',
  'fedapay_payout_id', 'mbiyo_transaction_id', 'afribapay_transaction_id',
  'izipay_payout_id',
])('outgoing and historical transactions expose %s', (key) => {
  expect(getProviderReference({ metadata: { [key]: 'PROVIDER-123' } })).toBe('PROVIDER-123');
  expect(getProviderReference({ [key]: 'PROVIDER-123' })).toBe('PROVIDER-123');
});

test('never replaces a missing provider reference with the Biz-transPay reference', () => {
  expect(getProviderReference({ id: 'local-id', reference: 'BTP-LOCAL' })).toBeNull();
});
