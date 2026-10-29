self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open('biz-transpay-pwa-v1');
      const response = await fetch('/offline.html', { cache: 'reload' });
      if (response.ok) await cache.put('/offline.html', response);
    } catch {
      // Caching is optional; the worker can still activate with its inline fallback.
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin) return;

  event.respondWith(fetch(request).catch(async () => {
    let offlinePage = null;
    try {
      const cache = await caches.open('biz-transpay-pwa-v1');
      offlinePage = await cache.match('/offline.html');
    } catch {
      // Fall through to the inline response if Cache Storage is unavailable.
    }
    return offlinePage || new Response(
      '<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hors connexion</title><body><main><h1>Connexion indisponible</h1><p>Vérifiez votre connexion puis réessayez.</p></main></body></html>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }));
});

function safeNotificationPath(value) {
  try {
    const target = new URL(value || '/dashboard', self.location.origin);
    if (target.origin !== self.location.origin) return '/dashboard';
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return '/dashboard';
  }
}

// The push event is handled here, outside the page lifecycle, so an open
// Biz-transPay tab or PWA window is not required to display the notification.
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
    const wrapped = payload?.data?.FCM_MSG || payload?.FCM_MSG || payload?.message;
    if (wrapped) payload = typeof wrapped === 'string' ? JSON.parse(wrapped) : wrapped;
  } catch {
    return;
  }

  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const notification = payload?.notification
    || data.notification
    || data;
  const rawUrl = data.url
    || notification.click_action
    || payload?.fcmOptions?.link
    || payload?.fcm_options?.link
    || '/dashboard';

  event.waitUntil(self.registration.showNotification(
    notification.title || data.title || payload?.title || 'Biz-transPay',
    {
      body: notification.body || data.body || payload?.body || '',
      data: { url: safeNotificationPath(rawUrl) },
    },
  ));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(
    safeNotificationPath(event.notification.data?.url),
    self.location.origin,
  ).href;
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = list.find((client) => (
      client.url
      && new URL(client.url).origin === self.location.origin
      && typeof client.focus === 'function'
    ));
    if (existing) {
      try {
        await existing.focus();
        if (typeof existing.navigate === 'function') {
          await existing.navigate(url);
          return;
        }
      } catch {
        // If a client cannot be focused or navigated, open the target directly.
      }
    }
    await self.clients.openWindow(url);
  })());
});