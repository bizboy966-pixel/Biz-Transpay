import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '@/api';
import AdminUserDetail from './AdminUserDetail';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}), { virtual: true });

jest.mock('react-router-dom', () => ({
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
  useParams: () => ({ id: 'user-42' }),
  useNavigate: () => jest.fn(),
}));

jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const userDetail = {
  user: {
    full_name: 'Awa Mensah', username: 'awa', email: 'awa@example.test',
    phone: '+22890001122', country: 'TG', created_at: '2024-01-02',
    account_type: 'personal', role: 'user', balance_xof: 1250, balance_xaf: 0,
    balance_usdt: 500, is_blocked: false, is_banned: false, withdrawals_blocked: false,
  },
  recent_transactions: [],
  transactions_count: 0,
};

describe('AdminUserDetail balance wallet selector', () => {
  let container;
  let root;
  let promptSpy;
  let originalCrypto;

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  const click = async (testId) => {
    await act(async () => container.querySelector(`[data-testid="${testId}"]`).dispatchEvent(new MouseEvent('click', { bubbles: true })));
  };

  const setInput = async (testId, value, selector = 'input') => {
    const element = container.querySelector(`[data-testid="${testId}"]`);
    const proto = selector === 'select' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    await act(async () => {
      setter.call(element, value);
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { randomUUID: jest.fn(() => 'stable-action-id') },
    });
    promptSpy = jest.spyOn(window, 'prompt').mockReturnValue('CONFIRMEr');
    api.post.mockResolvedValue({});
    api.get.mockImplementation((path) => {
      if (path.endsWith('/balance-wallets')) {
        return Promise.resolve({ data: { wallets: [
          { id: 'XOF', currency: 'XOF', balance: 1250 },
          { id: 'XAF', currency: 'XAF', balance: 0 },
          { id: 'USDT.BEP20', asset_id: 'USDT.BEP20', currency: 'USDT', coin: 'USDT', network: 'BEP20', network_name: 'BNB Smart Chain', balance: 17.25 },
          { id: 'USDT.TRON', asset_id: 'USDT.TRON', currency: 'USDT', coin: 'USDT', network: 'TRC20', balance: 9 },
        ] } });
      }
      return Promise.resolve({ data: userDetail });
    });
    await act(async () => root.render(<AdminUserDetail />));
    await flush();
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container.remove();
    promptSpy?.mockRestore();
    if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
    else delete globalThis.crypto;
    jest.clearAllMocks();
  });

  test('uses the exact crypto wallet id and sends asset_id with the existing confirmation fields', async () => {
    await click('user-action-credit');
    await flush();
    expect(api.get).toHaveBeenCalledWith('/admin/users/user-42/balance-wallets');

    const select = container.querySelector('[data-testid="modal-currency"]');
    const options = [...select.options];
    expect(options.map((option) => option.value)).toEqual(['XOF', 'XAF', 'USDT.BEP20', 'USDT.TRON']);
    expect(options.map((option) => option.textContent)).toContain('USDT · BNB Smart Chain');
    expect(options.map((option) => option.textContent)).not.toContain('USD / USDT');

    await setInput('modal-currency', 'USDT.BEP20', 'select');
    expect(container.querySelector('[data-testid="selected-wallet-balance"]').textContent).toContain('17.25 USDT');
    await setInput('modal-amount', '12.5');
    const reason = container.querySelector('textarea');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(reason, 'manual adjustment');
      reason.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('modal-balance-confirm');

    expect(promptSpy).toHaveBeenCalledWith('Confirmer le crédit administrateur ?\nSaisissez CONFIRMER pour continuer.');
    expect(api.post).toHaveBeenCalledWith('/admin/users/user-42/credit', {
      amount: 12.5, currency: 'USDT', reason: 'manual adjustment',
      confirmation: 'CONFIRMER', action_id: 'stable-action-id', asset_id: 'USDT.BEP20',
    });
  });

  test('keeps XOF usable when the wallet catalog fails and offers a retry', async () => {
    api.get.mockImplementation((path) => path.endsWith('/balance-wallets')
      ? Promise.reject(new Error('catalog unavailable'))
      : Promise.resolve({ data: userDetail }));
    // Re-open the modal using a new render after replacing the endpoint response.
    await click('user-action-debit');
    await flush();
    expect(container.querySelector('[data-testid="wallets-retry"]')).not.toBeNull();
    expect([...container.querySelector('[data-testid="modal-currency"]').options].map((option) => option.value)).toEqual(['XOF', 'XAF']);
    expect(container.querySelector('[data-testid="selected-wallet-balance"]').textContent).toContain('1,250 XOF');
    await setInput('modal-amount', '3');
    expect(container.querySelector('[data-testid="modal-balance-confirm"]').disabled).toBe(false);
    await click('modal-balance-confirm');
    expect(api.post).toHaveBeenCalledWith('/admin/users/user-42/debit', {
      amount: 3, currency: 'XOF', reason: '', confirmation: 'CONFIRMER', action_id: 'stable-action-id',
    });
  });
});
