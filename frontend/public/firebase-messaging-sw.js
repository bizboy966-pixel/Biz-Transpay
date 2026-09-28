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

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let message;
  try { message = event.data.json(); } catch { return; }
  const n = message.notification || message.data || {};
  event.waitUntil(self.registration.showNotification(n.title || 'Biz-trans', {
    body: n.body || '', data: { url: message.data?.url || n.url || '/dashboard' },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/dashboard';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const existing = list.find((client) => 'focus' in client);
    return existing ? existing.focus().then(() => existing.navigate(url)) : clients.openWindow(url);
  }));
});