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

  test('sw.js never caches /api/* and has a CACHE_VERSION', () => {
    const sw = readSw();
    expect(sw).toContain("url.pathname.startsWith('/api/')");
    expect(sw).toMatch(/const CACHE_VERSION = ['"]v[\d.]+[\w-]*['"]/);
  });

  test('sw.js uses skipWaiting + clients.claim so a deploy reaches open tabs', () => {
    const sw = readSw();
    expect(sw).toMatch(/self\.skipWaiting\(\)/);
    expect(sw).toMatch(/self\.clients\.claim\(\)/);
  });

  test('app.js registers the worker behind feature detection', () => {
    const appJs = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf-8');
    expect(appJs).toMatch(/if\s*\(\s*['"]serviceWorker['"]\s+in\s+navigator\s*\)/);
    expect(appJs).toContain("navigator.serviceWorker.register('/sw.js'");
    expect(appJs).toContain("scope: '/'");
  });

  test('GET /sw-kill exists and reports not-killed by default', async () => {
    const res = await request(app).get('/sw-kill');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kill: false });
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
    this.ok = init.ok !== undefined ? init.ok : true;
    this.status = init.status || 200;
    this.statusText = init.statusText || '';
    this.type = init.type || 'basic';
  }
  clone() {
    return new FakeResponse(this._body, { ok: this.ok, status: this.status, type: this.type });
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

  test('/api/* is passed straight to network — never intercepted or cached', async () => {
    const fetchImpl = jest.fn(async () => new FakeResponse('{}', { type: 'basic' }));
    const env = buildEnv(fetchImpl);
    await warm(env);

    const ev = makeEvent({ url: 'http://localhost/api/berths', method: 'GET', mode: 'cors' });
    env.listeners.fetch(ev);
    // The handler returns before calling respondWith for /api, so the browser
    // does its own default network fetch.
    expect(ev._response).toBeUndefined();
    const cached = await env.caches.match('/api/berths');
    expect(cached).toBeUndefined();
  });
});
