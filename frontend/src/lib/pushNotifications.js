import api from '@/api';
import { initializeApp, getApps } from 'firebase/app';
import { getMessaging, getToken, onMessage } from 'firebase/messaging';

const TOKEN_KEY = 'btp_push_token';
export const PUSH_OPT_IN_DISMISSED_KEY = 'btp_push_opt_in_dismissed';
let unsubscribeForeground = null;

export async function startBrowserPush({ requestPermission = false } = {}) {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return null;
  const { data } = await api.get('/push/config');
  if (!data?.configured || !data.config) return null;
  if (Notification.permission !== 'granted' && !requestPermission) return null;
  if (requestPermission && await Notification.requestPermission() !== 'granted') throw new Error('Autorisation de notifications refusée.');
  const app = getApps().length ? getApps()[0] : initializeApp(data.config);
  const messaging = getMessaging(app);
  const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
  const token = await getToken(messaging, { vapidKey: data.config.vapidKey, serviceWorkerRegistration: registration });
  if (!token) return null;
  if (unsubscribeForeground) unsubscribeForeground();
  unsubscribeForeground = onMessage(messaging, ({ notification, data: payload }) => {
    window.dispatchEvent(new CustomEvent('btp-foreground-push', {
      detail: { title: notification?.title || payload?.title, body: notification?.body || payload?.body, url: payload?.url },
    }));
  });
  await api.post('/push/devices', { token });
  localStorage.setItem(TOKEN_KEY, token);
  return token;
}

export function disposeBrowserPush() {
  if (unsubscribeForeground) unsubscribeForeground();
  unsubscribeForeground = null;
}

// Messaging is initialized only after opt-in; importing the SDK does not
// request notification permission or create a Firebase app.
export async function enableBrowserPush() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    throw new Error('Ce navigateur ne prend pas en charge les notifications push.');
  }
  const { data } = await api.get('/push/config');
  if (!data?.configured || !data.config) throw new Error('Les notifications push ne sont pas encore configurées.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Autorisation de notifications refusée.');
  const token = await startBrowserPush();
  if (!token) throw new Error('Impossible de créer le jeton de notifications.');
  return token;
}

export async function disableBrowserPush() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    await api.delete('/push/devices', { data: { token } });
    localStorage.removeItem(TOKEN_KEY);
  }
  disposeBrowserPush();
}

export function currentPushToken() { return localStorage.getItem(TOKEN_KEY); }