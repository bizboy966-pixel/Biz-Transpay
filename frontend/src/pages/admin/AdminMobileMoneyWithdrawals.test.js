import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '../../api';
import AdminMobileMoneyWithdrawals from './AdminMobileMoneyWithdrawals';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../../api', () => ({
  __esModule: true,
  default: { get: jest.fn(), patch: jest.fn() },
}));

jest.mock('sonner', () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));

const transferConfig = {
  mobile_money: {
    enabled: true,
    operators: [
      {
        provider: 'paydunya', country: 'TG', country_label: 'Togo',
        code: 'moov-togo', withdraw_mode: 'moov-togo',
        currency: 'XOF', name: 'Moov Money', active: true,
      },
      {
        provider: 'mbiyo', country: 'TG', country_label: 'Togo',
        code: 'mbiyo_moov_tg', network: 'moov',
        currency: 'XOF', name: 'Moov Money', active: false, min: 100, max: 0,
      },
      {
        provider: 'mbiyo', country: 'BJ', country_label: 'Bénin',
        code: 'mbiyo_mtn_bj', network: 'mtn',
        currency: 'XOF', name: 'MTN Mobile Money', active: true,
      },
      {
        provider: 'afribapay', country: 'SN', country_label: 'Sénégal',
        code: 'afribapay_orange_sn', public_code: 'orange_sn',
        operator: 'orange', currency: 'XOF', name: 'Orange Money',
        active: true,
      },
    ],
  },
  mbiyo: {
    enabled: true,
    operators: [
      {
        provider: 'mbiyo', country: 'TG', country_label: 'Togo',
        code: 'mbiyo_moov_tg', network: 'moov',
        currency: 'XOF', name: 'Moov Money', active: false,
      },
      {
        provider: 'mbiyo', country: 'BJ', country_label: 'Bénin',
        code: 'mbiyo_mtn_bj', network: 'mtn',
        currency: 'XOF', name: 'MTN Mobile Money', active: true,
      },
    ],
  },
};

describe('AdminMobileMoneyWithdrawals', () => {
  let container;
  let root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    api.get.mockResolvedValue({ data: transferConfig });
    api.patch.mockResolvedValue({ data: transferConfig });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root.unmount());
    }
    container.remove();
    jest.clearAllMocks();
  });

  test('scopes provider tabs and saves route activation in the payout catalog', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<AdminMobileMoneyWithdrawals />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Togo');
    expect(container.textContent).not.toContain('Sénégal');

    const biyaPayTab = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent.includes('Biya Pay'));
    await act(async () => biyaPayTab.click());

    expect(container.textContent).toContain('Bénin');
    expect(container.textContent).not.toContain('Sénégal');

    const mbiyoRoute = container.querySelector(
      '[data-testid="mobile-money-operator-mbiyo_moov_tg"] input[type="checkbox"]',
    );
    await act(async () => mbiyoRoute.click());

    const saveButton = container.querySelector(
      '[data-testid="btn-save-mobile-money-withdrawals"]',
    );
    await act(async () => {
      saveButton.click();
      await Promise.resolve();
    });

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith('/admin/transfer/config');
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch).toHaveBeenCalledWith(
      '/admin/transfer/config',
      expect.objectContaining({
        mobile_money: expect.objectContaining({
          operators: expect.any(Array),
        }),
      }),
    );
    const savedOperators = api.patch.mock.calls[0][1].mobile_money.operators;
    expect(savedOperators.find((operator) => operator.provider === 'paydunya').active)
      .toBe(false);
    expect(savedOperators.find((operator) => operator.provider === 'mbiyo'
      && operator.country === 'TG').active).toBe(true);
  });

  test('allows disabling every operator across providers and saving', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<AdminMobileMoneyWithdrawals />);
      await Promise.resolve();
    });

    const toggleOperator = async (providerLabel, code) => {
      const tab = Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent.includes(providerLabel));
      await act(async () => tab.click());
      const checkbox = container.querySelector(
        `[data-testid="mobile-money-operator-${code}"] input[type="checkbox"]`,
      );
      await act(async () => checkbox.click());
    };

    await toggleOperator('Pay Junior', 'moov-togo');
    await toggleOperator('Biya Pay', 'mbiyo_mtn_bj');
    await toggleOperator('Afrika Pay', 'afribapay_orange_sn');

    const saveButton = container.querySelector(
      '[data-testid="btn-save-mobile-money-withdrawals"]',
    );
    await act(async () => {
      saveButton.click();
      await Promise.resolve();
    });

    const savedOperators = api.patch.mock.calls[0][1].mobile_money.operators;
    expect(savedOperators.length).toBe(4);
    expect(savedOperators.every((operator) => operator.active === false)).toBe(true);
  });

  test('shows a zero maximum as unlimited', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<AdminMobileMoneyWithdrawals />);
      await Promise.resolve();
    });

    const biyaPayTab = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent.includes('Biya Pay'));
    await act(async () => biyaPayTab.click());

    const operator = container.querySelector(
      '[data-testid="mobile-money-operator-mbiyo_moov_tg"]',
    );
    const editButton = Array.from(operator.querySelectorAll('button'))
      .find((button) => button.textContent.includes('Modifier'));
    await act(async () => editButton.click());

    const numberInputs = operator.querySelectorAll('input[type="number"]');
    expect(numberInputs[5].value).toBe('');
  });

  test('reactivating an archived route deactivates the competing provider route', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<AdminMobileMoneyWithdrawals />);
      await Promise.resolve();
    });

    const biyaPayTab = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent.includes('Biya Pay'));
    await act(async () => biyaPayTab.click());

    const mbiyoRoute = container.querySelector(
      '[data-testid="mobile-money-operator-mbiyo_moov_tg"]',
    );
    const archiveButton = Array.from(mbiyoRoute.querySelectorAll('button'))
      .find((button) => button.textContent.includes('Archiver'));
    await act(async () => archiveButton.click());
    const reactivateButton = Array.from(mbiyoRoute.querySelectorAll('button'))
      .find((button) => button.textContent.includes('Réactiver'));
    await act(async () => reactivateButton.click());

    const reactivatedMbiyoRoute = container.querySelector(
      '[data-testid="mobile-money-operator-mbiyo_moov_tg"] input[type="checkbox"]',
    );
    expect(reactivatedMbiyoRoute.checked).toBe(true);

    const payJuniorTab = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent.includes('Pay Junior'));
    await act(async () => payJuniorTab.click());
    const paydunyaRoute = container.querySelector(
      '[data-testid="mobile-money-operator-moov-togo"] input[type="checkbox"]',
    );
    expect(paydunyaRoute.checked).toBe(false);
  });
});