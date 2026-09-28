import fs from 'fs';
import path from 'path';
const vm = require('vm');
import {
  getPwaInstallState,
  initializePwaInstall,
  requestPwaInstall,
} from './pwaInstall';

const messagingWorkerPath = path.resolve(
  __dirname,
  '../../public/firebase-messaging-sw.js',
);

function loadMessagingWorker(openWindows = []) {
  const handlers = {};
  const showNotification = jest.fn().mockResolvedValue(undefined);
  const clients = {
    matchAll: jest.fn().mockResolvedValue(openWindows),
    openWindow: jest.fn().mockResolvedValue(undefined),
  };
  const self = {
    addEventListener: (type, handler) => { handlers[type] = handler; },
    clients,
    location: { origin: 'https://biz-transpay.example' },
    registration: { showNotification },
    skipWaiting: jest.fn().mockResolvedValue(undefined),
  };

  vm.runInNewContext(
    fs.readFileSync(messagingWorkerPath, 'utf8'),
    { self, URL },
  );
  return { handlers, clients, showNotification };
}

describe('PWA installation', () => {
  let stopTracking;

  beforeEach(() => {
    window.localStorage.removeItem('btp-pwa-installed');
    stopTracking = initializePwaInstall();
  });

  afterEach(() => {
    stopTracking?.();
    window.localStorage.removeItem('btp-pwa-installed');
  });

  const dispatchInstallPrompt = ({ promptResult, userChoice } = {}) => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = jest.fn().mockResolvedValue(promptResult);
    if (userChoice) event.userChoice = Promise.resolve(userChoice);
    window.dispatchEvent(event);
    return event;
  };

  it('returns unavailable when the browser has not offered an install prompt', async () => {
    await expect(requestPwaInstall()).resolves.toBe('unavailable');
  });

  it('provides a real navigation fetch handler for browser installability', () => {
    const workerPath = path.resolve(__dirname, '../../public/firebase-messaging-sw.js');
    const offlinePagePath = path.resolve(__dirname, '../../public/offline.html');
    const worker = fs.readFileSync(workerPath, 'utf8');

    expect(worker).toMatch(/addEventListener\(['"]fetch['"]/);
    expect(worker).toContain('event.respondWith(');
    expect(worker).toContain("request.mode !== 'navigate'");
    expect(fs.existsSync(offlinePagePath)).toBe(true);
  });

  it('falls back to userChoice when prompt has no result', async () => {
    dispatchInstallPrompt({
      promptResult: {},
      userChoice: { outcome: 'dismissed' },
    });

    await expect(requestPwaInstall()).resolves.toBe('dismissed');
    expect(getPwaInstallState().installed).toBe(false);
  });

  it('uses the result returned by prompt to detect an accepted installation', async () => {
    const event = dispatchInstallPrompt({
      promptResult: { outcome: 'accepted' },
      userChoice: { outcome: 'dismissed' },
    });

    await expect(requestPwaInstall()).resolves.toBe('accepted');
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(getPwaInstallState().installed).toBe(true);
  });
});

describe('background browser notifications', () => {
  it('shows an FCM notification without an open page', async () => {
    const { handlers, showNotification } = loadMessagingWorker();
    let pendingNotification;
    handlers.push({
      data: {
        json: () => ({
          notification: { title: 'Dépôt confirmé', body: '500 XOF crédités' },
          data: { url: '/dashboard/transactions' },
        }),
      },
      waitUntil: (promise) => { pendingNotification = promise; },
    });

    await pendingNotification;

    const [title, options] = showNotification.mock.calls[0];
    expect(title).toBe('Dépôt confirmé');
    expect(options.body).toBe('500 XOF crédités');
    expect(options.data.url).toBe('/dashboard/transactions');
  });

  it('shows data-only FCM messages and keeps their internal click route', async () => {
    const { handlers, showNotification } = loadMessagingWorker();
    let pendingNotification;
    handlers.push({
      data: {
        json: () => ({
          data: {
            title: 'Retrait confirmé',
            body: '500 XOF reçus',
            url: '/dashboard/transactions?tab=withdrawals',
          },
        }),
      },
      waitUntil: (promise) => { pendingNotification = promise; },
    });

    await pendingNotification;

    const [title, options] = showNotification.mock.calls[0];
    expect(title).toBe('Retrait confirmé');
    expect(options.body).toBe('500 XOF reçus');
    expect(options.data.url).toBe('/dashboard/transactions?tab=withdrawals');
  });

  it('opens the notification route when it is clicked with no open page', async () => {
    const { handlers, clients } = loadMessagingWorker();
    let pendingClick;
    const close = jest.fn();
    handlers.notificationclick({
      notification: { data: { url: '/dashboard/transactions' }, close },
      waitUntil: (promise) => { pendingClick = promise; },
    });

    await pendingClick;

    expect(close).toHaveBeenCalledTimes(1);
    expect(clients.openWindow).toHaveBeenCalledWith(
      'https://biz-transpay.example/dashboard/transactions',
    );
  });

  it('falls back to the dashboard for an external notification route', async () => {
    const { handlers, clients } = loadMessagingWorker();
    let pendingClick;
    handlers.notificationclick({
      notification: {
        data: { url: 'https://example.invalid/path' },
        close: jest.fn(),
      },
      waitUntil: (promise) => { pendingClick = promise; },
    });

    await pendingClick;

    expect(clients.openWindow).toHaveBeenCalledWith(
      'https://biz-transpay.example/dashboard',
    );
  });
});