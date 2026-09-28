import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import {
  currentPushToken,
  enableBrowserPush,
  PUSH_OPT_IN_DISMISSED_KEY,
} from '../lib/pushNotifications';
import { toast } from 'sonner';
import PushOptInPrompt from './PushOptInPrompt';

jest.mock('../api', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));
jest.mock('../context/AuthContext', () => ({
  __esModule: true,
  useAuth: jest.fn(),
}));
jest.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/dashboard' }),
}));
jest.mock('../lib/pushNotifications', () => ({
  __esModule: true,
  currentPushToken: jest.fn(),
  enableBrowserPush: jest.fn(),
  startBrowserPush: jest.fn(),
  PUSH_OPT_IN_DISMISSED_KEY: 'btp_push_opt_in_dismissed',
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key) => ({
      'push.title': 'Activez les notifications.',
      'push.body': 'Autorisez Bitranspa à vous envoyer des notifications.',
      'push.allow': 'Activer les notifications',
      'push.later': 'Plus tard',
      'push.enabled': 'Notifications activées',
      'push.error': 'Impossible d’activer les notifications.',
      'push.blocked': 'Les notifications sont bloquées.',
    }[key] || key),
  }),
}));
jest.mock('sonner', () => ({
  toast: { success: jest.fn() },
}));

const originalNotification = Object.getOwnPropertyDescriptor(window, 'Notification');
const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');

describe('PushOptInPrompt', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    sessionStorage.clear();
    jest.clearAllMocks();
    useAuth.mockReturnValue({ user: { id: 'merchant-1' }, loading: false });
    currentPushToken.mockReturnValue(null);
    enableBrowserPush.mockResolvedValue('push-token');
    api.get.mockResolvedValue({ data: { configured: true } });
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: { permission: 'default' },
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {},
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    delete global.IS_REACT_ACT_ENVIRONMENT;
    if (originalNotification) {
      Object.defineProperty(window, 'Notification', originalNotification);
    } else {
      delete window.Notification;
    }
    if (originalServiceWorker) {
      Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker);
    } else {
      delete navigator.serviceWorker;
    }
  });

  const renderPrompt = async () => {
    await act(async () => {
      root.render(<PushOptInPrompt />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  it('shows the prompt as soon as the user is authenticated', async () => {
    useAuth.mockReturnValue({ user: null, loading: false });
    await renderPrompt();
    expect(container.querySelector('[data-testid="push-opt-in-modal"]')).toBeNull();
    expect(api.get).not.toHaveBeenCalled();

    useAuth.mockReturnValue({ user: { id: 'merchant-1' }, loading: false });
    await act(async () => {
      root.render(<PushOptInPrompt />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-testid="push-opt-in-modal"]')?.textContent)
      .toContain('Activez les notifications.');
    expect(container.textContent).toContain('Autorisez Bitranspa à vous envoyer des notifications.');
  });

  it('lets the user defer the prompt and keeps the profile option available', async () => {
    await renderPrompt();
    await act(async () => {
      container.querySelector('[data-testid="push-opt-in-later"]').click();
    });
    expect(container.querySelector('[data-testid="push-opt-in-modal"]')).toBeNull();
    expect(sessionStorage.getItem(PUSH_OPT_IN_DISMISSED_KEY)).toBe('1');
  });

  it('requests opt-in only after the user presses the activation button', async () => {
    await renderPrompt();
    expect(enableBrowserPush).not.toHaveBeenCalled();
    await act(async () => {
      container.querySelector('[data-testid="push-opt-in-enable"]').click();
    });
    expect(enableBrowserPush).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="push-opt-in-modal"]')).toBeNull();
    expect(toast.success).toHaveBeenCalledWith('Notifications activées');
  });

  it('does not display the prompt if browser notifications were already denied', async () => {
    window.Notification.permission = 'denied';
    await renderPrompt();
    expect(api.get).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="push-opt-in-modal"]')).toBeNull();
  });
});