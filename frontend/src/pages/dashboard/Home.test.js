import { act } from 'react';
import { createRoot } from 'react-dom/client';
import DashboardHome from './Home';

jest.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }) => ({
    data: [],
  }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));
jest.mock('react-router-dom', () => ({
  Link: ({ children, to, ...props }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => jest.fn(),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: key => key }),
}));
jest.mock('@/api', () => ({ __esModule: true, default: { get: jest.fn() } }), { virtual: true });
jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'wallet-owner', balance_xof: 2500, balance_xaf: 800,
      balance_gnf: 12000, balance_ugx: 5400, balance_usd: 12.5,
    },
    refresh: jest.fn(),
  }),
}), { virtual: true });
jest.mock('@/hooks/useFeatures', () => ({
  useFeatures: () => ({}),
}), { virtual: true });
jest.mock('@/pageLoaders', () => ({
  prefetchPageForRoute: jest.fn(),
}), { virtual: true });
jest.mock('@/components/DigiShopQuickAction', () => () => null, { virtual: true });
jest.mock('@/components/ReferralBanner', () => () => null, { virtual: true });
jest.mock('@/assets/wallet-reference-card.jpg', () => 'wallet-card.jpg', { virtual: true });
jest.mock('@/constants/walletCurrencies', () => ({
  DASHBOARD_FIAT_CURRENCIES: [
    'XOF', 'XAF', 'CDF', 'USD', 'GMD', 'GNF', 'UGX', 'TZS',
    'KES', 'RWF', 'GHS', 'NGN', 'ZAR', 'ZMW', 'EGP',
  ],
}), { virtual: true });
jest.mock('./TransactionDetailModal', () => () => null);
jest.mock('./TransactionListItem', () => () => null);

describe('DashboardHome fiat wallet selector', () => {
  let container;
  let root;
  let originalActEnvironment;

  beforeEach(() => {
    localStorage.clear();
    originalActEnvironment = global.IS_REACT_ACT_ENVIRONMENT;
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    global.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  });

  test('selecting another fiat currency updates the dashboard amount and remembers it', async () => {
    await act(async () => root.render(<DashboardHome />));

    const selector = container.querySelector('[data-testid="select-dashboard-fiat-wallet"]');
    expect(selector.value).toBe('XOF');
    expect([...selector.options].map(option => option.value)).toContain('UGX');
    expect([...selector.options].map(option => option.value)).toContain('USD');
    expect(container.querySelector('[data-testid="balance-value-xof"]').textContent)
      .toContain('2,500');

    await act(async () => {
      selector.value = 'UGX';
      selector.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="balance-value-ugx"]').textContent)
      .toContain('5,400');
    expect(localStorage.getItem('btp_dashboard_fiat_currency')).toBe('UGX');
    expect(container.querySelector('[data-testid="balance-value-xaf"]').textContent)
      .toContain('800');
  });
});
