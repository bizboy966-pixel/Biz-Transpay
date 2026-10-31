import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useAuth } from '@/context/AuthContext';
import DashboardLayout from './DashboardLayout';

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  NavLink: ({ to, children, className, end, ...props }) => require('react').createElement(
    'a',
    {
      href: to,
      className: typeof className === 'function' ? className({ isActive: false }) : className,
      ...props,
    },
    children,
  ),
  Outlet: () => null,
  useLocation: () => ({ pathname: '/dashboard' }),
  useNavigate: () => mockNavigate,
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key) => key }) }));
jest.mock('@/context/AuthContext', () => ({ useAuth: jest.fn() }), { virtual: true });
jest.mock('@/components/Logo', () => ({ Logo: () => null }), { virtual: true });
jest.mock('@/components/SafeImage', () => ({ SafeImage: ({ fallback }) => fallback }), { virtual: true });
jest.mock('@/components/NotificationBell', () => () => null, { virtual: true });
jest.mock('@/components/PwaInstallPrompt', () => () => null, { virtual: true });
jest.mock('@/components/LanguageSwitcher', () => () => null, { virtual: true });
jest.mock('@/components/FloatingSupportButtons', () => () => null, { virtual: true });
jest.mock('@/components/SocialChannelsBanner', () => () => null, { virtual: true });
jest.mock('@/pageLoaders', () => ({ prefetchPageForRoute: jest.fn() }), { virtual: true });
jest.mock('sonner', () => ({ toast: { error: jest.fn() } }));

describe('hidden administrator panel entry', () => {
  let root;
  let container;
  let unlockAdminPanel;

  beforeEach(() => {
    jest.clearAllMocks();
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    unlockAdminPanel = jest.fn().mockResolvedValue({ ok: true });
    useAuth.mockReturnValue({
      user: { role: 'admin', username: 'biz_tech', full_name: 'Admin User' },
      logout: jest.fn(),
      unlockAdminPanel,
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete global.IS_REACT_ACT_ENVIRONMENT;
  });

  const render = async () => act(async () => root.render(<DashboardLayout />));
  const click = async (node) => act(async () => node.click());
  const find = (testId) => container.querySelector(`[data-testid="${testId}"]`);
  const input = async (node, value) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });

  test('four username clicks prompt for TOTP and unlock navigation after verification', async () => {
    await render();
    expect(find('menu-admin')).toBeNull();
    await click(find('btn-profile'));
    const username = find('profile-username');
    for (let index = 0; index < 4; index += 1) await click(username);

    expect(find('admin-panel-mfa-dialog')).not.toBeNull();
    await input(find('admin-panel-otp'), '246810');
    await click(find('admin-panel-mfa-submit'));
    expect(unlockAdminPanel).toHaveBeenCalledWith('246810');
    expect(mockNavigate).toHaveBeenCalledWith('/admin');
  });

  test('ordinary users do not get the hidden administrator prompt', async () => {
    useAuth.mockReturnValue({
      user: { role: 'user', username: 'customer', full_name: 'Customer' },
      logout: jest.fn(),
      unlockAdminPanel,
    });
    await render();
    await click(find('btn-profile'));
    const username = find('profile-username');
    for (let index = 0; index < 4; index += 1) await click(username);
    expect(find('admin-panel-mfa-dialog')).toBeNull();
  });
});
