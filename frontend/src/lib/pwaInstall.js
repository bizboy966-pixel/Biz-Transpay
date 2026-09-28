const INSTALLED_KEY = 'btp-pwa-installed';
const installListeners = new Set();

let deferredInstallPrompt = null;
let installedInThisBrowser = false;

function emitInstallState() {
  const state = getPwaInstallState();
  installListeners.forEach((listener) => listener(state));
}

function browserReportsInstalled() {
  if (typeof window === 'undefined') return false;

  try {
    if (window.localStorage.getItem(INSTALLED_KEY) === 'true') return true;
  } catch {
    // Private browsing may prevent local storage; use browser display mode below.
  }

  return Boolean(
    window.matchMedia?.('(display-mode: standalone)').matches
      || window.navigator.standalone === true
  );
}

export function getPwaInstallState() {
  const installed = installedInThisBrowser || browserReportsInstalled();
  if (installed) installedInThisBrowser = true;
  return { installed, canPrompt: Boolean(deferredInstallPrompt) };
}

export function subscribePwaInstall(listener) {
  installListeners.add(listener);
  listener(getPwaInstallState());
  return () => installListeners.delete(listener);
}

export function markPwaInstalled() {
  installedInThisBrowser = true;
  deferredInstallPrompt = null;
  try {
    window.localStorage.setItem(INSTALLED_KEY, 'true');
  } catch {
    // Standalone display mode still suppresses the prompt when storage is blocked.
  }
  emitInstallState();
}

export async function requestPwaInstall() {
  const promptEvent = deferredInstallPrompt;
  if (!promptEvent) return 'unavailable';

  deferredInstallPrompt = null;
  emitInstallState();
  await promptEvent.prompt();
  const choice = await promptEvent.userChoice;
  if (choice?.outcome === 'accepted') markPwaInstalled();
  else emitInstallState();
  return choice?.outcome || 'dismissed';
}

export function initializePwaInstall() {
  if (typeof window === 'undefined') return () => {};

  const handleBeforeInstallPrompt = (event) => {
    event.preventDefault();
    if (getPwaInstallState().installed) return;
    deferredInstallPrompt = event;
    emitInstallState();
  };
  const handleAppInstalled = () => markPwaInstalled();

  window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
  window.addEventListener('appinstalled', handleAppInstalled);
  if ('serviceWorker' in window.navigator) {
    window.navigator.serviceWorker
      .register('/firebase-messaging-sw.js')
      .catch(() => {});
  }

  return () => {
    window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.removeEventListener('appinstalled', handleAppInstalled);
  };
}