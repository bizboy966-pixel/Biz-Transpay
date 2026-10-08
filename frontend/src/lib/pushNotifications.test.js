jest.mock('../api', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
  },
}));

jest.mock('firebase/app', () => ({
  initializeApp: jest.fn(),
  getApps: jest.fn(),
}));

jest.mock('firebase/messaging', () => ({
  getMessaging: jest.fn(),
  getToken: jest.fn(),
  onMessage: jest.fn(),
}));

import api from '../api';
import { initializeApp, getApps } from 'firebase/app';
import { getMessaging, getToken, onMessage } from 'firebase/messaging';
import { enableBrowserPush, startBrowserPush } from './pushNotifications';

describe('browser push registration', () => {
  let activeRegistration;

  beforeEach(() => {
    localStorage.removeItem('btp_push_token');
    activeRegistration = { active: { state: 'activated' } };
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: {
        permission: 'granted',
        requestPermission: jest.fn().mockResolvedValue('granted'),
      },
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: jest.fn().mockResolvedValue({ active: null }),
        ready: Promise.resolve(activeRegistration),
      },
    });
    getApps.mockReturnValue([]);
    initializeApp.mockReturnValue({ name: 'test-app' });
    getMessaging.mockReturnValue({ name: 'test-messaging' });
    getToken.mockResolvedValue('test-fcm-token');
    onMessage.mockReturnValue(jest.fn());
    api.get.mockResolvedValue({
      data: {
        configured: true,
        server_configured: true,
        config: { apiKey: 'public-key', vapidKey: 'public-vapid-key' },
      },
    });
    api.post.mockResolvedValue({ data: { ok: true } });
  });

  afterEach(() => {
    localStorage.removeItem('btp_push_token');
    jest.clearAllMocks();
  });

  it('waits for an active service worker before creating and registering the FCM token', async () => {
    await expect(startBrowserPush()).resolves.toBe('test-fcm-token');

    expect(navigator.serviceWorker.register).toHaveBeenCalledWith(
      '/firebase-messaging-sw.js',
    );
    expect(getToken).toHaveBeenCalledWith(
      { name: 'test-messaging' },
      {
        vapidKey: 'public-vapid-key',
        serviceWorkerRegistration: activeRegistration,
      },
    );
    expect(api.post).toHaveBeenCalledWith('/push/devices', {
      token: 'test-fcm-token',
    });
    expect(localStorage.getItem('btp_push_token')).toBe('test-fcm-token');
  });

  it('does not create a token until the service worker is active', async () => {
    activeRegistration = { active: null };
    navigator.serviceWorker.ready = Promise.resolve(activeRegistration);

    await expect(startBrowserPush()).rejects.toThrow(
      'Le service worker de notifications n’est pas actif.',
    );
    expect(getToken).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('requests browser permission before starting any network request', async () => {
    const order = [];
    window.Notification.permission = 'default';
    window.Notification.requestPermission = jest.fn().mockImplementation(async () => {
      order.push('permission');
      window.Notification.permission = 'granted';
      return 'granted';
    });
    api.get.mockImplementation(async () => {
      order.push('config');
      return {
        data: {
          configured: true,
          server_configured: true,
          config: { apiKey: 'public-key', vapidKey: 'public-vapid-key' },
        },
      };
    });

    await expect(enableBrowserPush()).resolves.toBe('test-fcm-token');
    expect(order).toEqual(['permission', 'config']);
  });

  it('does not contact the server if the browser permission is refused', async () => {
    window.Notification.permission = 'default';
    window.Notification.requestPermission = jest.fn().mockResolvedValue('denied');

    await expect(enableBrowserPush()).rejects.toThrow(
      'Autorisation de notifications refusée.',
    );
    expect(api.get).not.toHaveBeenCalled();
  });

  it('shares one FCM registration when login checks overlap', async () => {
    const [firstToken, secondToken] = await Promise.all([
      startBrowserPush(),
      startBrowserPush(),
    ]);

    expect(firstToken).toBe('test-fcm-token');
    expect(secondToken).toBe('test-fcm-token');
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledTimes(1);
  });
});