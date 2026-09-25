/**
 * TideLog service worker — offline app shell, no build step.
 *
 * This repo has no bundler and no Workbox: `public/` is served verbatim, so the
 * precache list below is hand-written and `CACHE_VERSION` is bumped by hand when
 * any shell file changes. A globbing test (tests/sw.test.js) fails the gate if a
 * file lands in `public/` that is not listed here, which is the backstop for the
 * "someone forgot to bump it" failure mode.
 *
 * Strategy:
 *   - App shell (HTML/JS/CSS/manifest/icons): stale-while-revalidate. The cached
 *     copy paints immediately (fast, works offline), and a background fetch
 *     writes the fresh copy back. On this repo a push to `main` IS the deploy
 *     with no staging, so a returning visitor MUST eventually see a new build —
 *     pure cache-first would strand them on an old shell until every tab closed.
 *   - `/api/*`: network-only, never cached. Harbor data (berths, tides) served
 *     stale is worse than an error; that is SVD-13's problem, not this slice's.
 *   - New versions activate promptly via skipWaiting/clients.claim so a deploy
 *     reaches open tabs without waiting for all of them to close.
 *
 * KILL SWITCH — this is the public demo, and a registered SW is sticky: a bad
 * one keeps serving itself, so a broken deploy is NOT fixed by the next deploy.
 * The switch runs on the SW's own fetch path (which still executes when the
 * cache is serving garbage): every navigation checks `/sw-kill` network-first,
 * and on `{ kill: true }` the SW unregisters itself and deletes every cache, so
 * the next load is unmanaged. public/sw-register.js asks the same sentinel before
 * registering, so an unmanaged page does not install the worker again; without
 * that the switch would flap on and off. No console paste, no reliance on the
 * broken SW letting a new one through.
 *
 * HOW TO PULL IT. Env reaches production only through apprunner.yaml, so add
 *
 *     - name: TIDELOG_SW_KILL
 *       value: 'true'
 *
 * under `run.env` in apprunner.yaml and push to main (the push is the deploy).
 * Returning visitors drop the worker on their next navigation. To restore it,
 * remove the entry and push again.
 *
 * CACHE_VERSION only needs a bump when PRECACHE_URLS changes. File CONTENTS
 * refresh on their own through stale-while-revalidate, so do not bump it on
 * every deploy.
 */

const CACHE_VERSION = 'v0.2.0-shell-1';
const CACHE_NAME = `tidelog-${CACHE_VERSION}`;

// The app shell. `/` is the document (index.html); it is NOT listed separately
// as `/index.html` — they are the same resource and two entries would cache one
// document twice. Everything else in public/ that a cold offline load needs to
// paint itself, including the manifest and the icons it names.
const PRECACHE_URLS = [
  '/',
  '/app.js',
  '/sw-register.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon.png',
];

// Path the kill switch polls. Kept out of the shell cache on purpose so its
// answer is always live.
const KILL_URL = '/sw-kill';

// Set once the kill switch has fired. A concurrent revalidation must not write
// back into (and so recreate) a cache the kill path is deleting.
let killed = false;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
  // Take over as soon as installed rather than waiting for every tab to close —
  // on a deploy-on-push repo the update has to reach people.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)))
      )
      .then(() => self.clients.claim())
  );
});

/**
 * Poll the kill sentinel network-first. On the kill signal, unregister this SW
 * and drop every cache so the page reloads unmanaged. Any failure (offline, or
 * the route missing) is swallowed: a SW that self-destructs whenever it cannot
 * reach the network would defeat the entire point of offline support.
 */
async function checkKillSwitch() {
  try {
    const res = await fetch(KILL_URL, { cache: 'no-store' });
    if (!res || !res.ok) return;
    const body = await res.json();
    if (body && body.kill === true) {
      // Flip the flag first so an in-flight revalidation stops writing before
      // the caches are deleted.
      killed = true;
      await self.registration.unregister();
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
    }
  } catch {
    // Unreachable sentinel — leave the SW and its cache in place.
  }
}

/**
 * Stale-while-revalidate for the shell: return the cached response at once, and
 * in the background fetch a fresh copy and write it back so the NEXT load is
 * current. `event.waitUntil` keeps the worker alive for that background write
 * (and makes it observable to tests). Falls back to the cached shell for a
 * navigation when the network is unreachable and nothing else matched.
 */
async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const networkUpdate = fetch(request)
    .then(async (response) => {
      // Await the write so event.waitUntil actually covers it: a worker can be
      // terminated after the fetch resolves but before an un-awaited put lands,
      // which would strand the next load on stale bytes. Only cache real,
      // same-origin success responses — an opaque or error response must never
      // overwrite a good cached shell file — and never once the kill switch has
      // fired, so a late write cannot recreate a just-deleted cache.
      if (!killed && response && response.ok && response.type === 'basic') {
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (event) event.waitUntil(networkUpdate);

  if (cached) return cached;

  const fresh = await networkUpdate;
  if (fresh) return fresh;

  // Offline with nothing cached: hand a navigation the app shell rather than the
  // browser's offline error page.
  if (request.mode === 'navigate') {
    const shell = await cache.match('/');
    if (shell) return shell;
  }
  return new Response('Offline', { status: 503, statusText: 'Offline' });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Once killed, stop serving entirely. This worker lives on until its pages
  // close, and a request it answered after the kill would reopen (and so
  // recreate) the cache the kill just deleted.
  if (killed) return;

  // Only manage same-origin GETs. Writes and cross-origin requests pass straight
  // through to the network untouched.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // NEVER cache /api/*, the SW itself, or the kill sentinel.
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js' || url.pathname === KILL_URL) {
    return; // default: straight to network
  }

  // The kill switch rides the fetch path: check it on every navigation, since
  // that path still runs when the cache is serving a broken shell.
  if (request.mode === 'navigate') {
    event.waitUntil(checkKillSwitch());
  }

  event.respondWith(staleWhileRevalidate(request, event));
});
