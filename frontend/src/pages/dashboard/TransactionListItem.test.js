import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TransactionListItem from './TransactionListItem';

function renderItem(overrides = {}) {
  const tx = {
    id: 'history-item-1',
    type: 'payment',
    direction: 'in',
    currency: 'USDT.BEP20',
    amount: 4.83,
    status: 'completed',
    created_at: '2026-10-13T12:00:00.000Z',
    metadata: {},
    ...overrides,
  };
  return renderToStaticMarkup(
    <TransactionListItem tx={tx} onClick={() => {}} />,
  );
}

describe('TransactionListItem crypto logos', () => {
  test.each([
    ['USDT.BEP20', 'usdt'],
    ['USDC.POLYGON', 'usdc'],
    ['BNB.BNB', 'bnb'],
    ['BTC.BTC', 'btc'],
    ['SOL.SOL', 'sol'],
    ['TON.TON', 'ton'],
    ['TRX.TRX', 'trx'],
    ['ETH.ETH', 'eth'],
  ])('shows the local %s asset logo', (currency, symbol) => {
    const html = renderItem({
      currency,
      metadata: {
        payment_source: 'api',
        asset_code: currency,
        coin: currency.split('.')[0],
        network: currency.split('.')[1],
      },
    });

    expect(html).toContain(`src="/crypto-logos/${symbol}.svg"`);
    expect(html).toContain(`data-testid="crypto-logo-${symbol}"`);
  });

  test('shows the same asset logo for incoming and outgoing BEP20 payments', () => {
    for (const direction of ['in', 'out']) {
      expect(renderItem({
        direction,
        currency: 'USDT.BEP20',
        metadata: { payment_source: 'api', network: 'BEP20' },
      })).toContain('src="/crypto-logos/usdt.svg"');
    }
  });

  test('uses the crypto logo even when an API record also has provider metadata', () => {
    const html = renderItem({
      metadata: {
        payment_source: 'api',
        operator: 'payment-api-provider',
        asset_code: 'USDT.BEP20',
        coin: 'USDT',
        network: 'BEP20',
      },
    });

    expect(html).toContain('src="/crypto-logos/usdt.svg"');
    expect(html).not.toContain('src="/operator-logos/');
  });

  test('keeps the existing Mobile Money operator logo', () => {
    const html = renderItem({
      currency: 'XOF',
      metadata: {
        operator: 'tmoney_tg',
        operator_name: 'T-Money Togo',
        country: 'TG',
      },
    });

    expect(html).toContain('src="/operator-logos/tg-tmoney.svg"');
    expect(html).not.toContain('crypto-logo-');
  });
});
