import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useAuth } from '@/context/AuthContext';
import api from '@/api';
import Login from './Login';
import Settings from './dashboard/Settings';
import AdminPinSettings from '../components/AdminPinSettings';

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  Link: ({ children }) => require('react').createElement('span', null, children),
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key) => key }) }));
jest.mock('@/context/AuthContext', () => ({ useAuth: jest.fn() }), { virtual: true });
jest.mock('@/api', () => ({ get: jest.fn(), post: jest.fn() }), { virtual: true });
jest.mock('sonner', () => ({ toast: { success: jest.fn(), info: jest.fn(), error: jest.fn() } }));
jest.mock('@/components/Logo', () => ({ Logo: () => null }), { virtual: true });
jest.mock('@/components/LanguageSwitcher', () => () => null, { virtual: true });
jest.mock('@/components/AdminPinSettings', () => require('../components/AdminPinSettings'), { virtual: true });
jest.mock('@/components/TurnstileWidget', () => ({
  __esModule: true,
  default: ({ onToken }) => require('react').createElement('button', {
    type: 'button', 'data-testid': 'test-turnstile', onClick: () => onToken('test-token'),
  }, 'Vérifier'),
  useTurnstileConfig: () => ({ enabled: true, siteKey: 'test' }),
}), { virtual: true });
jest.mock('@/constants/userPinMigration', () => ({
  USER_PIN_MIGRATION_NOTICE: 'Activez un nouveau PIN.',
}), { virtual: true });
jest.mock('@/lib/pushNotifications', () => ({
  currentPushToken: () => null, enableBrowserPush: jest.fn(), disableBrowserPush: jest.fn(),
}), { virtual: true });
jest.mock('@/i18n', () => ({ language: 'fr', changeLanguage: jest.fn() }), { virtual: true });

describe('Administrator PIN login and settings', () => {
  let root, container, mockLogin, mockRefresh;
  beforeEach(() => {
    jest.clearAllMocks();
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockLogin = jest.fn();
    mockRefresh = jest.fn().mockResolvedValue();
    useAuth.mockReturnValue({
      login: mockLogin, refresh: mockRefresh, confirmTwoFactor: jest.fn(),
      user: { role: 'admin', two_fa_enabled: true, admin_pin_enabled: true },
    });
    api.get.mockResolvedValue({ data: { configured: false } });
    api.post.mockResolvedValue({ data: { enabled: true } });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete global.IS_REACT_ACT_ENVIRONMENT;
  });
  const find = (id) => container.querySelector(`[data-testid="${id}"]`);
  const render = async (element) => act(async () => root.render(element));
  const click = async (id) => act(async () => find(id).click());
  const input = async (id, value) => {
    await act(async () => {
      const node = find(id);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const submit = async () => act(async () => {
    find('login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  const passwordStage = async () => {
    await render(<Login />);
    await input('input-identifier', 'admin@example.test');
    await input('input-password', 'admin-password');
    await click('test-turnstile');
    await submit();
  };

  test('admin with a configured PIN signs into the user dashboard after password and PIN', async () => {
    mockLogin.mockResolvedValueOnce({
      mfa_required: true, mfa_token: 'challenge', security_methods: ['pin'],
    }).mockResolvedValueOnce({ user: { role: 'admin' } });
    await passwordStage();
    expect(find('login-method-pin')).toBeNull();
    expect(find('input-login-otp')).toBeNull();
    await input('input-login-pin', '04a9271');
    expect(find('input-login-pin').value).toBe('049271');
    expect(find('input-login-pin').type).toBe('password');
    await submit();
    expect(mockLogin).toHaveBeenLastCalledWith('admin@example.test', 'admin-password',
      expect.objectContaining({ security_method: 'pin', pin: '049271', otp: undefined, mfa_token: 'challenge' }));
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard');
  });

  test('admin without a configured PIN can still sign in with the authenticator', async () => {
    mockLogin.mockResolvedValueOnce({
      mfa_required: true, mfa_token: 'challenge', security_methods: ['totp'],
    }).mockResolvedValueOnce({ user: { role: 'super_admin' } });
    await passwordStage();
    expect(find('input-login-pin')).toBeNull();
    await input('input-login-otp', '246810');
    await submit();
    expect(mockLogin).toHaveBeenLastCalledWith('admin@example.test', 'admin-password',
      expect.objectContaining({ security_method: 'totp', otp: '246810', pin: undefined }));
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard');
  });

  test('an administrator without a PIN is prompted only for authenticator verification', async () => {
    mockLogin.mockResolvedValue({ mfa_required: true, mfa_token: 'challenge', security_methods: ['totp'] });
    await passwordStage();
    expect(find('login-method-pin')).toBeNull();
    expect(find('input-login-pin')).toBeNull();
    expect(find('input-login-otp')).not.toBeNull();
  });

  test('ordinary users still sign in directly without an admin PIN screen', async () => {
    mockLogin.mockResolvedValue({ user: { role: 'user' } });
    await passwordStage();
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard');
    expect(find('login-method-pin')).toBeNull();
  });

  test('failed PIN verification stays on the PIN prompt', async () => {
    mockLogin.mockResolvedValueOnce({
      mfa_required: true, mfa_token: 'challenge', security_methods: ['pin'],
    }).mockRejectedValueOnce({ response: { data: { detail: { message: 'PIN temporairement bloqué' } } } });
    await passwordStage();
    await input('input-login-pin', '049271');
    await submit();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(find('input-login-pin')).not.toBeNull();
    expect(find('input-login-otp')).toBeNull();
  });

  test('PIN setup requires matching six-digit inputs, password and authenticator', async () => {
    await render(<AdminPinSettings enabled={false} onSaved={mockRefresh} />);
    await click('admin-pin-open');
    await input('admin-pin-pin', '049271');
    await input('admin-pin-confirmation', '049270');
    await input('admin-pin-password', 'admin-password');
    await input('admin-pin-code', '246810');
    expect(find('admin-pin-save').disabled).toBe(true);
    await input('admin-pin-confirmation', '049271');
    await click('admin-pin-save');
    expect(api.post).toHaveBeenCalledWith('/auth/admin-pin', {
      pin: '049271', current_password: 'admin-password', code: '246810',
    });
    expect(mockRefresh).toHaveBeenCalled();
    expect(find('admin-pin-pin')).toBeNull();
  });

  test('changing an existing PIN uses the same protected configuration flow', async () => {
    await render(<AdminPinSettings enabled onSaved={mockRefresh} />);
    expect(find('admin-pin-open').textContent).toBe('Modifier le PIN');
    await click('admin-pin-open');
    await input('admin-pin-pin', '305826');
    await input('admin-pin-confirmation', '305826');
    await input('admin-pin-password', 'admin-password');
    await input('admin-pin-code', '246810');
    await click('admin-pin-save');
    expect(api.post).toHaveBeenCalledWith('/auth/admin-pin', expect.objectContaining({ pin: '305826' }));
  });

  test('removal requires fresh password and authenticator proof', async () => {
    await render(<AdminPinSettings enabled onSaved={mockRefresh} />);
    await click('admin-pin-remove');
    expect(find('admin-pin-pin')).toBeNull();
    expect(find('admin-pin-save').disabled).toBe(true);
    await input('admin-pin-password', 'admin-password');
    await input('admin-pin-code', '246810');
    await click('admin-pin-save');
    expect(api.post).toHaveBeenCalledWith('/auth/admin-pin', {
      pin: null, current_password: 'admin-password', code: '246810',
    });
  });

  test('server rejection keeps the PIN form open and displays the error', async () => {
    api.post.mockRejectedValue({ response: { data: { detail: 'Code de l’authentificateur invalide' } } });
    await render(<AdminPinSettings enabled onSaved={mockRefresh} />);
    await click('admin-pin-remove');
    await input('admin-pin-password', 'admin-password');
    await input('admin-pin-code', '246810');
    await click('admin-pin-save');
    expect(container.querySelector('[role="alert"]').textContent).toContain('authentificateur invalide');
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  test('PIN settings are reserved for MFA-enrolled administrators', async () => {
    await render(<Settings />);
    expect(find('admin-pin-settings')).not.toBeNull();
    useAuth.mockReturnValue({ user: { role: 'user', two_fa_enabled: false }, refresh: mockRefresh });
    await render(<Settings />);
    expect(find('admin-pin-settings')).toBeNull();
    useAuth.mockReturnValue({ user: { role: 'admin', two_fa_enabled: false }, refresh: mockRefresh });
    await render(<Settings />);
    expect(find('admin-pin-settings')).toBeNull();
  });
});
