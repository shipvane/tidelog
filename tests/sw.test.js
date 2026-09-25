'use strict';

/**
 * Service worker tests (SVD-12).
 *
 * Two layers:
 *   1. Static/served checks — the SW is reachable at root scope, the precache
 *      list stays in sync with what is actually in public/, /api is never
 *      cached, and app.js registers the worker.
 *   2. Behavioural checks — the SW's own code (public/sw.js) is loaded into a
 *      fake ServiceWorkerGlobalScope and driven directly. jsdom cannot run a
 *      real SW, so these do NOT assert "it works in a browser"; they exercise
 *      the exact fetch/cache logic in a controlled harness to prove the two
 *      properties the backlog demands: the shell revalidates without closing
 *      tabs (stale-while-revalidate), and the kill switch unregisters on signal.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const { boundServer } = require('./support/server');
const app = boundServer(require('../server'));

const SW_PATH = path.join(__dirname, '../public/sw.js');
const PUBLIC_DIR = path.join(__dirname, '../public');

function readSw() {
  return fs.readFileSync(SW_PATH, 'utf-8');
}

/** Every file under public/, recursively, as the URL it is served at.
 *  index.html maps to '/' (the canonical document URL — '/' and '/index.html'
 *  are the same resource); sw.js and dotfiles are excluded. */
function publicUrls(dir = PUBLIC_DIR, prefix = '') {
  const urls = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      urls.push(...publicUrls(path.join(dir, entry.name), rel));
    } else if (entry.name === 'sw.js') {
      continue; // the SW is served on demand, never precached
    } else if (rel === '/index.html') {
      urls.push('/'); // deduped to the document root
    } else {
      urls.push(rel);
    }
  }
  return urls;
}

function precacheList() {
  const block = readSw().match(/const PRECACHE_URLS = \[([\s\S]*?)\]/);
  expect(block).not.toBeNull();
  const quoted = block[1].match(/['"]([^'"]+)['"]/g) || [];
  return quoted.map((m) => m.slice(1, -1));
}

describe('service worker — served & static', () => {
  test('sw.js is served at root scope as javascript', async () => {
    const res = await request(app).get('/sw.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
  });

  test('precache list matches every file in public/ (glob recurses; nothing forgotten)', () => {
    const precached = precacheList();
    for (const url of publicUrls()) {
      expect(precached).toContain(url);
    }
    // And nothing precached that is not real, so the install addAll cannot 404.
    for (const url of precached) {
      expect(publicUrls()).toContain(url);
    }
  });

  test('the manifest and its icons are in the precache — the shell can paint offline', () => {
    const precached = precacheList();
    expect(precached).toContain('/manifest.webmanifest');
    expect(precached).toContain('/icons/icon-192.png');
    expect(precached).toContain('/icons/icon-512.png');
    expect(precached).toContain('/icons/icon-512-maskable.png');
  });

  test('/ and /index.html are not both precached (one document, one entry)', () => {
    const precached = precacheList();
    expect(precached).toContain('/');
    expect(precached).not.toContain('/index.html');
  });

  test('sw.js routes /api/ and has a CACHE_VERSION (harbor data cached, rest network-only)', () => {
    const sw = readSw();
    expect(sw).toContain("url.pathname.startsWith('/api/')");
    expect(sw).toMatch(/const CACHE_VERSION = ['"]v[\d.]+[\w-]*['"]/);
    // SVD-13: read-only board endpoints are cached for offline reads, in a
    // separate api cache; webhooks/stats/health are not in the allowlist.
    expect(sw).toContain('API_CACHE_NAME');
    expect(sw).toContain("'/api/arrivals'");
    expect(sw).toContain("'/api/berths'");
    expect(sw).toContain("'/api/tides/'");
    expect(sw).not.toContain("'/api/webhooks'");
  });

  test('sw.js uses skipWaiting + clients.claim so a deploy reaches open tabs', () => {
    const sw = readSw();
    expect(sw).toMatch(/self\.skipWaiting\(\)/);
    expect(sw).toMatch(/self\.clients\.claim\(\)/);
  });

  test('the page loads sw-register.js, and app.js no longer registers on its own', () => {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf-8');
    expect(html).toContain('<script src="sw-register.js"></script>');
    // A second, ungated register() in app.js would bring back the flapping kill
    // switch this file exists to prevent.
    const appJs = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf-8');
    expect(appJs).not.toContain('serviceWorker.register');
  });

  test('GET /sw-kill exists and reports not-killed by default', async () => {
    const res = await request(app).get('/sw-kill');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kill: false });
  });

  test('GET /sw-kill reports kill:true when TIDELOG_SW_KILL=true', async () => {
    // The path that matters in an incident. server.js reads the env per
    // request, so setting it here is exactly what an App Runner env entry does.
    const before = process.env.TIDELOG_SW_KILL;
    process.env.TIDELOG_SW_KILL = 'true';
    try {
      const res = await request(app).get('/sw-kill');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ kill: true });
    } finally {
      if (before === undefined) delete process.env.TIDELOG_SW_KILL;
      else process.env.TIDELOG_SW_KILL = before;
    }
  });
});

// ---------------------------------------------------------------------------
// Behavioural harness: load public/sw.js into a fake SW global scope.
// ---------------------------------------------------------------------------

function toPath(input) {
  const raw = typeof input === 'string' ? input : input.url;
  return raw.startsWith('/') ? raw : new URL(raw).pathname;
}

class FakeResponse {
  constructor(body, init = {}) {
    this._body = body;
    this.ok = init.ok !== undefined ? init.ok : (init.status || 200) < 400;
    this.status = init.status || 200;
    this.statusText = init.statusText || '';
    this.type = init.type || 'basic';
    this._headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) this._headers[k.toLowerCase()] = v;
    this.headers = { get: (name) => this._headers[String(name).toLowerCase()] ?? null };
  }
  clone() {
    return new FakeResponse(this._body, {
      ok: this.ok,
      status: this.status,
      type: this.type,
      headers: this._headers,
    });
  }
  async text() {
    return this._body;
  }
  async json() {
    return JSON.parse(this._body);
  }
}

class FakeCache {
  constructor() {
    this.map = new Map();
  }
  async match(req) {
    return this.map.get(toPath(req));
  }
  async put(req, res) {
    this.map.set(toPath(req), res);
  }
  async addAll(urls) {
    for (const u of urls) this.map.set(toPath(u), new FakeResponse(`precached:${toPath(u)}`));
  }
}

function makeEvent(req) {
  return {
    request: req,
    _waits: [],
    _response: undefined,
    waitUntil(p) {
      this._waits.push(p);
    },
    respondWith(p) {
      this._response = p;
    },
  };
}

function buildEnv(fetchImpl) {
  const cacheStore = new Map();
  const caches = {
    open: async (name) => {
      if (!cacheStore.has(name)) cacheStore.set(name, new FakeCache());
      return cacheStore.get(name);
    },
    keys: async () => [...cacheStore.keys()],
    delete: async (name) => cacheStore.delete(name),
    match: async (req) => {
      for (const c of cacheStore.values()) {
        const hit = await c.match(req);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const listeners = {};
  const self = {
    location: { origin: 'http://localhost' },
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    skipWaiting: jest.fn(),
    clients: { claim: jest.fn(async () => {}) },
    registration: { unregister: jest.fn(async () => {}) },
  };
  const code = readSw();
  // Deliberately eval the SW into a controlled scope; its globals
  // (self/caches/fetch/Response/URL) are injected as function parameters.
  new Function('self', 'caches', 'fetch', 'Response', 'URL', code)(
    self,
    caches,
    fetchImpl,
    FakeResponse,
    URL
  );
  return { self, caches, cacheStore, listeners };
}

async function warm(env) {
  const ev = makeEvent();
  env.listeners.install(ev);
  await Promise.all(ev._waits);
}

describe('service worker — behaviour (driven directly)', () => {
  test('stale-while-revalidate: cache serves immediately AND refreshes for next load', async () => {
    const fetchImpl = jest.fn(async () => new FakeResponse('app-js-v2', { type: 'basic' }));
    const env = buildEnv(fetchImpl);
    await warm(env); // cache now holds precached:/app.js

    const ev = makeEvent({ url: 'http://localhost/app.js', method: 'GET', mode: 'no-cors' });
    env.listeners.fetch(ev);

    // Served copy is the cached (stale) one — instant, works offline.
    const served = await ev._response;
    expect(await served.text()).toBe('precached:/app.js');

    // Background revalidation ran: the cache now holds the fresh copy, and no
    // tab had to close for it to land.
    await Promise.all(ev._waits);
    expect(fetchImpl).toHaveBeenCalled();
    const nowCached = await env.caches.match('/app.js');
    expect(await nowCached.text()).toBe('app-js-v2');
  });

  test('offline navigation falls back to the cached shell, not a network error', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('offline');
    });
    const env = buildEnv(fetchImpl);
    await warm(env);

    const ev = makeEvent({ url: 'http://localhost/harbor', method: 'GET', mode: 'navigate' });
    env.listeners.fetch(ev);
    const served = await ev._response;
    expect(await served.text()).toBe('precached:/');
  });

  test('kill switch: on { kill: true } the SW unregisters and drops every cache', async () => {
    const fetchImpl = jest.fn(async (input) => {
      if (toPath(input) === '/sw-kill') return new FakeResponse(JSON.stringify({ kill: true }));
      throw new Error('offline'); // shell fetch fails, so nothing repopulates
    });
    const env = buildEnv(fetchImpl);
    await warm(env);
    expect((await env.caches.keys()).length).toBe(1);

    const ev = makeEvent({ url: 'http://localhost/', method: 'GET', mode: 'navigate' });
    env.listeners.fetch(ev);
    await Promise.all(ev._waits);

    expect(env.self.registration.unregister).toHaveBeenCalled();
    expect((await env.caches.keys()).length).toBe(0);
  });

  test('kill switch stays dormant when the sentinel says { kill: false }', async () => {
    const fetchImpl = jest.fn(async (input) => {
      if (toPath(input) === '/sw-kill') return new FakeResponse(JSON.stringify({ kill: false }));
      return new FakeResponse('doc', { type: 'basic' });
    });
    const env = buildEnv(fetchImpl);
    await warm(env);

    const ev = makeEvent({ url: 'http://localhost/', method: 'GET', mode: 'navigate' });
    env.listeners.fetch(ev);
    await Promise.all(ev._waits);

    expect(env.self.registration.unregister).not.toHaveBeenCalled();
    expect((await env.caches.keys()).length).toBe(1);
  });

  test('non-cacheable /api/* (webhooks) is passed straight to network — never intercepted or cached', async () => {
    const fetchImpl = jest.fn(async () => new FakeResponse('{}', { type: 'basic' }));
    const env = buildEnv(fetchImpl);
    await warm(env);

    const ev = makeEvent({
      url: 'http://localhost/api/webhooks/deliveries',
      method: 'GET',
      mode: 'cors',
    });
    env.listeners.fetch(ev);
    // The handler returns before calling respondWith for a non-allowlisted /api
    // path, so the browser does its own default network fetch.
    expect(ev._response).toBeUndefined();
    const cached = await env.caches.match('/api/webhooks/deliveries');
    expect(cached).toBeUndefined();
  });

  test('harbor data (/api/berths) is cached, then served from cache when offline (SVD-13)', async () => {
    let online = true;
    const fetchImpl = jest.fn(async () => {
      if (!online) throw new Error('offline');
      return new FakeResponse('{"berths":["B1"]}', { type: 'basic' });
    });
    const env = buildEnv(fetchImpl);
    await warm(env);

    // Cold: nothing cached yet, so the board comes from the network and is
    // written into the api cache for next time.
    const first = makeEvent({ url: 'http://localhost/api/berths', method: 'GET', mode: 'cors' });
    env.listeners.fetch(first);
    const firstServed = await first._response;
    expect(await firstServed.text()).toBe('{"berths":["B1"]}');
    await Promise.all(first._waits);
    const cached = await env.caches.match('/api/berths');
    expect(await cached.text()).toBe('{"berths":["B1"]}');

    // Now offline: the same read still resolves, served from cache rather than a
    // network error — this is the whole point of SVD-13.
    online = false;
    const offline = makeEvent({ url: 'http://localhost/api/berths', method: 'GET', mode: 'cors' });
    env.listeners.fetch(offline);
    const offlineServed = await offline._response;
    expect(await offlineServed.text()).toBe('{"berths":["B1"]}');
  });

  test('online, harbor data comes from the NETWORK even when a cached copy exists', async () => {
    // The #56 review: stale-while-revalidate answered from cache while online, so
    // the board ran one refresh behind and a returning visitor saw yesterday's
    // berths under a LIVE badge. Network-first must return the fresh copy.
    let version = 'old';
    const fetchImpl = jest.fn(
      async () => new FakeResponse(`{"berths":["${version}"]}`, { type: 'basic' })
    );
    const env = buildEnv(fetchImpl);
    await warm(env);

    const first = makeEvent({ url: 'http://localhost/api/berths', method: 'GET', mode: 'cors' });
    env.listeners.fetch(first);
    await first._response;

    version = 'new';
    const second = makeEvent({ url: 'http://localhost/api/berths', method: 'GET', mode: 'cors' });
    env.listeners.fetch(second);
    expect(await (await second._response).text()).toBe('{"berths":["new"]}');
  });

  test('an offline answer carries the time the data was really fetched', async () => {
    // What makes an honest "last synced" possible: the cached copy is stamped
    // when it came off the network, and keeps that stamp when served offline.
    let online = true;
    const fetchImpl = jest.fn(async () => {
      if (!online) throw new Error('offline');
      return new FakeResponse('{"berths":[]}', { type: 'basic' });
    });
    const env = buildEnv(fetchImpl);
    await warm(env);

    const t0 = 1_700_000_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      const warmRead = makeEvent({
        url: 'http://localhost/api/berths',
        method: 'GET',
        mode: 'cors',
      });
      env.listeners.fetch(warmRead);
      expect((await warmRead._response).headers.get('X-TideLog-Fetched-At')).toBe(String(t0));

      now.mockReturnValue(t0 + 86_400_000); // a day later, and offline
      online = false;
      const later = makeEvent({ url: 'http://localhost/api/berths', method: 'GET', mode: 'cors' });
      env.listeners.fetch(later);
      const served = await later._response;
      expect(served.headers.get('X-TideLog-Fetched-At')).toBe(String(t0));
    } finally {
      now.mockRestore();
    }
  });

  test.each([
    '/api/arrivals/a1/dues',
    '/api/arrivals/export.csv',
    '/api/berths/B1/schedule',
    '/api/webhooks/deliveries',
  ])('%s is NOT intercepted or cached (only the board reads are)', async (pathname) => {
    // Dues, exports and schedules share the board's prefixes but change after a
    // write; served stale they look authoritative and are silently wrong.
    const fetchImpl = jest.fn(async () => new FakeResponse('{}', { type: 'basic' }));
    const env = buildEnv(fetchImpl);
    await warm(env);
    const ev = makeEvent({ url: `http://localhost${pathname}`, method: 'GET', mode: 'cors' });
    env.listeners.fetch(ev);
    expect(ev._response).toBeUndefined();
    expect(await env.caches.match(pathname)).toBeUndefined();
  });

  test('the tide calculations under /api/tides/ ARE cached for offline', async () => {
    const fetchImpl = jest.fn(async () => new FakeResponse('{"windows":[]}', { type: 'basic' }));
    const env = buildEnv(fetchImpl);
    await warm(env);
    const ev = makeEvent({
      url: 'http://localhost/api/tides/windows?draftM=8',
      method: 'GET',
      mode: 'cors',
    });
    env.listeners.fetch(ev);
    expect(ev._response).toBeDefined();
    await ev._response;
    expect(await env.caches.match('/api/tides/windows')).toBeDefined();
  });

  test('the kill switch also drops the api data cache, not just the shell', async () => {
    // SVD-13 lifts the "never cache /api" rule; the kill path must still leave a
    // clean slate. It deletes EVERY cache, so the api cache goes with the shell.
    const fetchImpl = jest.fn(async (input) => {
      if (toPath(input) === '/sw-kill') return new FakeResponse(JSON.stringify({ kill: true }));
      return new FakeResponse('{"berths":[]}', { type: 'basic' });
    });
    const env = buildEnv(fetchImpl);
    await warm(env);

    // Populate the api cache so there are two caches to clear.
    const api = makeEvent({ url: 'http://localhost/api/berths', method: 'GET', mode: 'cors' });
    env.listeners.fetch(api);
    await api._response;
    await Promise.all(api._waits);
    expect((await env.caches.keys()).length).toBe(2); // shell + api

    // A navigation fires the kill switch.
    const nav = makeEvent({ url: 'http://localhost/', method: 'GET', mode: 'navigate' });
    env.listeners.fetch(nav);
    await Promise.all(nav._waits);

    expect(env.self.registration.unregister).toHaveBeenCalled();
    expect((await env.caches.keys()).length).toBe(0);
  });

  test('after the kill, the worker stops serving and cannot recreate its cache', async () => {
    // The worker lives on until its pages close. A request it answered after
    // the kill would reopen the deleted cache and serve from it again.
    const fetchImpl = jest.fn(async (input) => {
      if (toPath(input) === '/sw-kill') return new FakeResponse(JSON.stringify({ kill: true }));
      return new FakeResponse('fresh', { type: 'basic' });
    });
    const env = buildEnv(fetchImpl);
    await warm(env);

    const nav = makeEvent({ url: 'http://localhost/', method: 'GET', mode: 'navigate' });
    env.listeners.fetch(nav);
    await Promise.all(nav._waits);
    expect((await env.caches.keys()).length).toBe(0);

    const later = makeEvent({ url: 'http://localhost/app.js', method: 'GET', mode: 'no-cors' });
    env.listeners.fetch(later);
    expect(later._response).toBeUndefined(); // straight to network, not the SW
    await Promise.all(later._waits);
    expect((await env.caches.keys()).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Page side: load public/sw-register.js against a fake navigator.
// ---------------------------------------------------------------------------

const REGISTER_PATH = path.join(__dirname, '../public/sw-register.js');

/** Let the registration promise chain run to the end. */
async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
}

function runRegister({ fetchImpl, withSw = true, existing = [] }) {
  const sw = {
    register: jest.fn(async () => ({})),
    getRegistrations: jest.fn(async () => existing),
  };
  const navigator = withSw ? { serviceWorker: sw } : {};
  const consoleStub = { error: jest.fn() };
  const code = fs.readFileSync(REGISTER_PATH, 'utf-8');
  new Function('navigator', 'fetch', 'console', code)(navigator, fetchImpl, consoleStub);
  return { sw, consoleStub };
}

describe('service worker registration — page side (sw-register.js)', () => {
  test('registers /sw.js at root scope when the sentinel says kill:false', async () => {
    const fetchImpl = jest.fn(async () => new FakeResponse(JSON.stringify({ kill: false })));
    const { sw } = runRegister({ fetchImpl });
    await settle();
    expect(fetchImpl).toHaveBeenCalledWith('/sw-kill', { cache: 'no-store' });
    expect(sw.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  test('kill:true means the page does NOT register, and removes any existing worker', async () => {
    // The flap this prevents: SW unregisters itself, the next unmanaged load
    // re-registers it, the one after is served from its cache again.
    const stale = { unregister: jest.fn(async () => true) };
    const fetchImpl = jest.fn(async () => new FakeResponse(JSON.stringify({ kill: true })));
    const { sw } = runRegister({ fetchImpl, existing: [stale] });
    await settle();
    expect(sw.register).not.toHaveBeenCalled();
    expect(stale.unregister).toHaveBeenCalled();
  });

  test('an unreachable sentinel fails open: offline still registers', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('offline');
    });
    const { sw } = runRegister({ fetchImpl });
    await settle();
    expect(sw.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  test('a non-OK sentinel (route missing) fails open too', async () => {
    const fetchImpl = jest.fn(async () => new FakeResponse('nope', { ok: false, status: 404 }));
    const { sw } = runRegister({ fetchImpl });
    await settle();
    expect(sw.register).toHaveBeenCalled();
  });

  test('a browser without service workers does nothing at all', async () => {
    const fetchImpl = jest.fn();
    runRegister({ fetchImpl, withSw: false });
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
