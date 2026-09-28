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