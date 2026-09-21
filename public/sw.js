/**
 * TideLog Service Worker
 *
 * Implements offline app shell caching with no build step.
 * Precaches the essential files for the TideLog dashboard.
 *
 * To disable this service worker in an emergency:
 * 1. Update CACHE_VERSION below to a new value
 * 2. Deploy the change
 * 3. Once propagated, browsers will install the new version which can unregister the old one
 * 4. For immediate effect, manually unregister in DevTools Console:
 *    navigator.serviceWorker.getRegistrations().then(r => r.forEach(x => x.unregister()))
 *
 * CACHE_VERSION bumps whenever precached files change. Remember to update it!
 */

const CACHE_VERSION = 'v0.1.0-shell-1';
const CACHE_NAME = `tidelog-${CACHE_VERSION}`;

/**
 * Precached files: the app shell.
 * These are served cache-first during offline, and updated on network-first basis online.
 * Update this list and bump CACHE_VERSION whenever these files change.
 */
const PRECACHE_URLS = ['/', '/app.js', '/styles.css', '/index.html'];

/**
 * Install event: precache the app shell.
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS);
    })
  );
  // skipWaiting: Do NOT use. We want the old SW to keep serving until the page
  // refreshes, so users on the old version don't get a jarring mid-session update.
  // A new version only takes over after a full page reload, which is safer for
  // cached API state and UI coherence.
});

/**
 * Activate event: clean up old caches.
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  // clients.claim: Do NOT use reflexively. We'll let the old SW keep serving
  // until a page reload, for the same reasons as skipWaiting above.
});

/**
 * Fetch event: serve app shell from cache, everything else from network.
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // NEVER cache /api/* endpoints or /sw.js itself.
  // Harbor data is loaded dynamically and must not be served stale.
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') {
    event.respondWith(fetch(request));
    return;
  }

  // Cache-first for app shell: try cache, fall back to network.
  event.respondWith(
    caches.match(request).then((response) => {
      return response || fetch(request);
    })
  );
});
