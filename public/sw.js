/* Notebook service worker.
 *
 * Purpose: make the app installable ("Add to Home Screen" / install prompt)
 * and serve immutable hashed build assets from cache. Deliberately minimal —
 * this is a server-centric app (auth + live API), so:
 *
 *   - index.html and all navigations are NEVER cached → deploys show up on
 *     the next reload, no stale-shell trap.
 *   - /api/* and everything non-GET always goes to the network.
 *   - only same-origin GET requests under /assets/ (Vite's content-hashed
 *     bundles, immutable by definition) are cached cache-first.
 *
 * If you change caching behavior here, bump CACHE_NAME so old caches get
 * dropped on activate.
 */

const CACHE_NAME = 'notebook-assets-v1';
const CACHEABLE_PREFIX = '/assets/';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(CACHEABLE_PREFIX)) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;

      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});
