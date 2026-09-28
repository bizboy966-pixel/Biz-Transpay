import {
  getPwaInstallState,
  initializePwaInstall,
  requestPwaInstall,
} from './pwaInstall';

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