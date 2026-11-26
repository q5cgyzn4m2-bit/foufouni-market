/* foûfoûni-Market — notifications push + mode hors ligne de la caisse (réseau d'abord, copie de secours si pas de réseau) */
const OFF = 'ffm-offline';
const OFF_API = ['/api/me', '/api/admin/state', '/api/public/catalog'];
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url); if (u.origin !== self.location.origin) return;
  const nav = r.mode === 'navigate', asset = u.pathname === '/adapter.js' || u.pathname === '/manifest.webmanifest' || /^\/icon-\d+\.png$/.test(u.pathname), api = OFF_API.includes(u.pathname);
  if (!nav && !asset && !api) return;
  const key = nav ? '/' : u.pathname;
  e.respondWith(fetch(r).then(res => {
    if (res.ok && (!nav || u.pathname === '/' || u.pathname === '/index.html')) { const cp = res.clone(); caches.open(OFF).then(c => c.put(key, cp)).catch(() => {}); }
    return res;
  }).catch(() => caches.open(OFF).then(c => c.match(key)).then(m => m || (nav ? caches.open(OFF).then(c => c.match('/')) : null)).then(m => m || Response.error())));
});
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
