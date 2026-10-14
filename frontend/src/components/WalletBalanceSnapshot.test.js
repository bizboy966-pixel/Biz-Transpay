import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import WalletBalanceSnapshot from './WalletBalanceSnapshot';

function renderSnapshot(transaction) {
  return renderToStaticMarkup(
    <WalletBalanceSnapshot transaction={transaction} />,
  );
}

describe('WalletBalanceSnapshot', () => {
  test('shows recorded before, credited amount, and after for a deposit', () => {
    const html = renderSnapshot({
      currency: 'XOF',
      metadata: {
        wallet_balance_before: 2000,
        wallet_balance_after: 4000,
        wallet_balance_currency: 'XOF',
        wallet_operation_amount: 2000,
        wallet_operation_direction: 'credit',
      },
    });

    expect(html).toContain('aria-label="Soldes avant et après la transaction"');
    expect(html).toContain('Avant');
    expect(html).toContain('Crédité');
    expect(html).toContain('Après');
    expect(html).toContain('XOF');
  });

  test('shows both exchange wallet legs from recorded database snapshots', () => {
    const html = renderSnapshot({
      currency: 'XOF',
      metadata: {
        wallet_balance_before: 1000,
        wallet_balance_after: 900,
        wallet_balance_currency: 'XOF',
        wallet_operation_amount: 100,
        wallet_operation_direction: 'exchange',
        wallet_field: 'balance_xof',
        to_wallet_field: 'balance_usdt_bep20',
        from_currency: 'XOF',
        to_currency: 'USDT.BEP20',
        wallet_balances_before: {
          balance_xof: 1000,
          balance_usdt_bep20: 2,
        },
        wallet_balances_after: {
          balance_xof: 900,
          balance_usdt_bep20: 2.1,
        },
      },
    });

    expect(html).toContain('XOF');
    expect(html).toContain('USDT.BEP20');
    expect(html).toContain('Transféré');
  });

  test('does not invent snapshots for historical transactions without them', () => {
    const html = renderSnapshot({
      currency: 'XOF',
      metadata: {},
    });

    expect(html).toContain('Le solde avant et après n’a pas été enregistré');
    expect(html).not.toContain('Crédité');
  });
});
