// Minimal service worker whose only job is PWA install-eligibility (Chrome
// and friends require a fetch handler before they'll offer "Add to Home
// Screen" / "Install"). It is deliberately NOT a real offline cache:
//
//  - This is a multiplayer game. Without a network connection to the room
//    host there is nothing useful to do offline, so there is no point
//    caching gameplay code aggressively or serving a stale build.
//  - /assets/ (models, textures, audio, the generated index.json) is never
//    cached here. Those files are large, already content-addressed by the
//    asset pipeline's SHA-256 lock, and re-fetching them from the network on
//    every load is simpler and safer than a cache invalidation strategy.
//
// Strategy: network-first for everything else, with a small same-origin
// cache purely as a fallback for a flaky connection (not for offline play).

const CACHE_NAME = 'tfps-shell-v1';

self.addEventListener('install', (event) => {
  // Take over immediately; there is no meaningful "old version still running"
  // state worth waiting out for a game client.
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then(() => undefined));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Cross-origin (CDN scripts, WebSocket upgrade, PeerJS signaling, etc.) and
  // non-GET requests pass straight through untouched.
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;

  // Never intercept assets: always hit the network, never read or write the cache.
  if (url.pathname.startsWith('/assets/')) return;

  event.respondWith(
    (async () => {
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(event.request, response.clone());
        }
        return response;
      } catch {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        throw new Error('network unavailable and no cached response for ' + url.pathname);
      }
    })(),
  );
});
