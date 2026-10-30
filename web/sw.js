// Service worker for terminal-hub (scope "/"); install.sh fills in the @PLACEHOLDERS@.
// - Notifications: the page shows them through this (phones only allow that), and a tap on one
//   opens its session, in the open page if there is one.
// - With HUB_FALLBACK set: if this machine doesn't answer (asleep or off: a network error or a
//   hang; the proxy up but the hub down: 5xx), open the fallback, so the installed app always
//   lands somewhere useful.
const FALLBACK = @FALLBACK_JSON@; // '' when there's none
const OFFLINE = '/assets/offline.html';
const CACHE = 'hub-@VERSION@';

self.addEventListener('install', (e) => {
  if (FALLBACK) e.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, '/assets/app-192.png'])));
  self.skipWaiting();
});
self.addEventListener('activate', (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
);

self.addEventListener('fetch', (e) => {
  if (!FALLBACK || e.request.mode !== 'navigate') return; // ws, token, assets: straight through
  e.respondWith(
    (async () => {
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 4000));
      try {
        const res = await Promise.race([fetch(e.request), timeout]);
        if (res && res.status < 500) return res;
      } catch {}
      return (await caches.match(OFFLINE)) || Response.redirect(FALLBACK, 302);
    })()
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { target, url } = e.notification.data ?? {};
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((pages) => {
      const page = pages[0];
      if (!page) return self.clients.openWindow(url ?? '/');
      page.postMessage({ hub: 'open', target });
      return page.focus();
    })
  );
});
