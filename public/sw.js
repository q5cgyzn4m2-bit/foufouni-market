/* foûfoûni-Market — notifications push (pas de mise en cache des pages) */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'foûfoûni-Market', {
    body: d.body || '', icon: d.icon || '/icon-192.png', badge: d.badge || '/badge-96.png',
    image: d.image || undefined, tag: d.tag || undefined, renotify: !!d.tag, lang: 'fr', data: { url: d.url || '/' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for (const w of ws) { if ('focus' in w) { if (w.navigate) w.navigate(url).catch(() => {}); return w.focus(); } }
    return self.clients.openWindow(url);
  }));
});
