import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import TransactionDetailModal from './TransactionDetailModal';

jest.mock('@/api', () => ({ get: jest.fn() }), { virtual: true });
jest.mock('@/components/PaymentBrand', () => ({
  CountryBadge: () => null, OperatorLogo: () => null,
}), { virtual: true });
jest.mock('@/components/WalletBalanceSnapshot', () => ({
  __esModule: true, default: ({ transaction }) => (
    <div data-testid="recorded-after">{transaction.metadata?.wallet_balance_after ?? 'absent'}</div>
  ),
}), { virtual: true });

const api = require('@/api');
let container;
let root;
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  api.get.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const tx = {
  id: 'outgoing-1', reference: 'BTP-LOCAL', direction: 'out', type: 'transfer',
  amount: 500, currency: 'XOF', status: 'completed',
  created_at: '2026-10-25T10:00:00Z',
  metadata: { paydunya_disbursement_id: 'PAYOUT-123' },
};

test('shows the saved outgoing provider reference immediately and loads authoritative details', async () => {
  let resolveDetails;
  api.get.mockReturnValueOnce(new Promise((resolve) => { resolveDetails = resolve; }));
  act(() => root.render(<TransactionDetailModal tx={tx} onClose={() => {}} />));
  expect(container.textContent).toContain('PAYOUT-123');
  await act(async () => resolveDetails({
    data: { ...tx, metadata: { ...tx.metadata, wallet_balance_before: 500, wallet_balance_after: 0 } },
  }));
  expect(container.querySelector('[data-testid="recorded-after"]').textContent).toBe('0');
  expect(api.get).toHaveBeenCalledWith('/transactions/outgoing-1');
});

test('keeps existing details visible and reports a failed complementary lookup', async () => {
  api.get.mockRejectedValueOnce(new Error('unavailable'));
  await act(async () => root.render(<TransactionDetailModal tx={tx} onClose={() => {}} />));
  expect(container.textContent).toContain('Les détails complémentaires sont indisponibles');
  expect(container.textContent).toContain('PAYOUT-123');
});
