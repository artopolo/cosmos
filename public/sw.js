/* Cosmos service worker: app-shell caching only.
   Cross-origin requests (Supabase API + storage) are never intercepted. */
const CACHE = 'cosmos-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;

  if (event.request.mode === 'navigate') {
    // network-first for the shell, cached fallback for offline launches
    const shell = self.registration.scope; // works at any base path
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(shell, copy));
          return res;
        })
        .catch(() => caches.match(shell)),
    );
    return;
  }

  // hashed build assets are immutable: cache-first
  event.respondWith(
    caches.match(event.request).then(
      (hit) =>
        hit ||
        fetch(event.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return res;
        }),
    ),
  );
});
