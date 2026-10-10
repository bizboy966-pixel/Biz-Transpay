import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '../../api';
import AdminStatistics from './AdminStatistics';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../../api', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

describe('AdminStatistics', () => {
  let container;
  let root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    api.get.mockImplementation((path) => {
      if (path === '/admin/statistics/dashboard') {
        return Promise.resolve({
          data: {
            period: 'month',
            generated_at: '2026-10-10T10:00:00+00:00',
            top_countries: [{
              country_code: 'TG',
              country: 'Togo',
              transaction_count: 12,
              volume_xof: 25000,
              unconverted_volume_by_currency: [],
            }],
            margins: {
              categories: {
                deposit_mobile_money: {
                  count: 1,
                  amounts: [{ currency: 'XOF', amount: 500 }],
                },
                conversion: {
                  count: 1,
                  amounts: [{ currency: 'XAF', amount: 5 }],
                },
              },
              total_by_currency: [{ currency: 'XOF', amount: 500 }],
            },
          },
        });
      }
      if (path === '/admin/statistics/wallet-balances') {
        return Promise.resolve({
          data: {
            total_xof_equivalent: 700000,
            conversion_complete: true,
            missing_rates: [],
            wallets: [
              { kind: 'fiat', currency: 'XOF', balance: 500000, xof_equivalent: 500000 },
              { kind: 'fiat', currency: 'XAF', balance: 200000, xof_equivalent: 200000 },
              {
                kind: 'crypto', currency: 'BTC.BTC', coin: 'BTC',
                network: 'BTC', balance: .01, xof_equivalent: 100000,
              },
            ],
            updated_at: '2026-10-10T10:00:00+00:00',
          },
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
  });

  afterEach(async () => {
    jest.useRealTimers();
    if (root) {
      await act(async () => root.unmount());
    }
    container.remove();
    root = null;
    jest.clearAllMocks();
  });

  test('shows the three requested sections and their real category labels', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<AdminStatistics />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Top 8 pays — Ce mois');
    expect(container.textContent).toContain('Togo');
    expect(container.textContent).toContain('Solde total disponible');
    expect(container.textContent).toContain('700 000 XOF');
    expect(container.textContent).toContain('Revenus Biz-transPay — Marge uniquement');
    expect(container.textContent).toContain('Paiements API · Mobile Money');
    expect(container.textContent).toContain('Paiements API · Crypto');
    expect(container.textContent).toContain('Conversions');
    expect(container.textContent).not.toContain('Tendances des opérations');
    expect(container.textContent).not.toContain('Soldes et activité par pays');
    expect(container.textContent).not.toContain('Prestataires disponibles');
    expect(api.get).toHaveBeenCalledWith(
      '/admin/statistics/dashboard',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(api.get).toHaveBeenCalledWith(
      '/admin/statistics/wallet-balances',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  test('refreshes user wallet balances every 60 seconds without reloading monthly charts', async () => {
    jest.useFakeTimers();
    await act(async () => {
      root = createRoot(container);
      root.render(<AdminStatistics />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.get.mock.calls.filter(([path]) => (
      path === '/admin/statistics/dashboard'
    ))).toHaveLength(1);

    await act(async () => {
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.get.mock.calls.filter(([path]) => (
      path === '/admin/statistics/wallet-balances'
    ))).toHaveLength(2);
    expect(api.get.mock.calls.filter(([path]) => (
      path === '/admin/statistics/dashboard'
    ))).toHaveLength(1);
    jest.useRealTimers();
  });
});
