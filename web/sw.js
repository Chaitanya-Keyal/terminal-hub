// Service worker for terminal-hub (scope "/"); install.sh adds it only when HUB_FALLBACK is set.
// If this machine doesn't answer (asleep or off: a network error or a hang; the proxy up but the
// hub down: 5xx), open the fallback instead, so the installed app always lands somewhere useful.
const FALLBACK = @FALLBACK_JSON@;
const OFFLINE = '/assets/offline.html';
const CACHE = 'hub-@VERSION@';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, '/assets/app-192.png'])));
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
  if (e.request.mode !== 'navigate') return; // ws, token, assets: straight through
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
