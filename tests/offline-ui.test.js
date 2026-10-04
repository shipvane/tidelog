'use strict';

/**
 * Offline behaviour of the dashboard client (SVD-13).
 *
 * These load the REAL public/app.js into a jsdom window (not a re-implementation
 * of it) with fetch and navigator.onLine under our control, and drive it through
 * the DOM the way a browser would. That exercises the actual offline logic:
 * the connection badge, the last-synced label, and the offline write refusal.
 *
 * What jsdom CANNOT tell us (per this repo's CLAUDE.md) is whether any of this is
 * visible on screen — it has no layout. These assert state and behaviour, not
 * pixels; the offline indicator's placement is unverified here by design.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const request = require('supertest');

const { boundServer } = require('./support/server');
const app = boundServer(require('../server'));

const APP_JS = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf-8');

const openDoms = [];
afterEach(() => {
  while (openDoms.length) openDoms.pop().window.close(); // clear app.js intervals
});

function makeRes(body, { ok = true, status = 200, statusText = 'OK', fetchedAt, fromCache } = {}) {
  const headers = {
    get: (name) => {
      const n = String(name).toLowerCase();
      if (n === 'x-tidelog-fetched-at') return fetchedAt !== undefined ? String(fetchedAt) : null;
      if (n === 'x-tidelog-from-cache') return fromCache ? '1' : null;
      return null;
    },
  };
  return { ok, status, statusText, headers, json: async () => body };
}

/** Let app.js's fetch/render promise chains run to completion. */
async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((r) => setImmediate(r));
    for (let j = 0; j < 10; j += 1) await Promise.resolve();
  }
}

async function bootApp({
  online = true,
  arrivals = [],
  berths = [],
  windows = [],
  deliveries = [],
  stamps = {},
  fromCache = false,
  failData = false,
  readOnly = false,
  writeRes = null,
  html = (text) => text,
} = {}) {
  const pageRes = await request(app).get('/');
  const dom = new JSDOM(html(pageRes.text), {
    url: 'http://localhost:3000',
    runScripts: 'outside-only',
  });
  openDoms.push(dom);
  const { window } = dom;

  const calls = [];
  window.fetch = (url, opts) => {
    const u = String(url);
    calls.push({ url: u, opts });
    // writeRes lets a test make the server refuse a write (e.g. the read-only
    // 403); otherwise writes succeed as before.
    if (opts && opts.method && opts.method !== 'GET')
      return Promise.resolve(writeRes || makeRes({}));
    // failData simulates the server-down / cold-cache case: the board reads
    // reject outright, so refresh() takes its catch path (SVD-21).
    if (failData && /\/api\/(arrivals|berths|tides)/.test(u))
      return Promise.reject(new Error('network'));
    if (u.includes('/api/health')) {
      // /api/health is network-only in the SW, so it has no cache fallback:
      // offline (or on a transient failure a test opts into) it simply fails,
      // like it would in the browser.
      if (!window.navigator.onLine || window.__failHealth)
        return Promise.reject(new Error('offline'));
      return Promise.resolve(makeRes({ status: 'ok', service: 'tidelog', readOnly }));
    }
    if (u.includes('/api/arrivals'))
      return Promise.resolve(makeRes({ arrivals }, { fetchedAt: stamps.arrivals, fromCache }));
    if (u.includes('/api/berths'))
      return Promise.resolve(makeRes({ berths }, { fetchedAt: stamps.berths, fromCache }));
    if (u.includes('/api/tides'))
      return Promise.resolve(makeRes({ windows }, { fetchedAt: stamps.tides, fromCache }));
    if (u.includes('/api/webhooks')) return Promise.resolve(makeRes({ deliveries }));
    return Promise.resolve(makeRes({}));
  };

  setOnline(window, online);

  window.eval(APP_JS);
  await flush();
  return { window, calls };
}

function setOnline(window, value) {
  Object.defineProperty(window.navigator, 'onLine', { value, configurable: true });
}

function writeCount(calls) {
  return calls.filter((c) => c.opts && c.opts.method === 'POST').length;
}

const EXPECTED_VESSEL = {
  id: 'a1',
  vesselName: 'MV Test',
  vesselType: 'cargo',
  lengthM: 50,
  draftM: 5,
  eta: '2026-03-01T14:00:00Z',
  status: 'expected',
};
const OPEN_BERTH = {
  id: 'B1',
  name: 'North Quay',
  lengthM: 100,
  depthM: 8,
  occupied: false,
  outOfService: false,
};
// A berth holding one arrived vessel, shaped like the real /api/berths payload
// (berthView in routes/berths.js): the legacy single `occupant` plus the
// `occupants` array whose entries carry a status (SVD-18).
const OCCUPIED_BERTH = {
  id: 'B1',
  name: 'North Quay',
  lengthM: 100,
  depthM: 8,
  occupied: true,
  outOfService: false,
  occupant: {
    arrivalId: 'a1',
    vesselName: 'MV Test',
    from: '2026-03-01T06:00:00Z',
    to: '2026-03-01T20:00:00Z',
  },
  occupants: [
    {
      arrivalId: 'a1',
      vesselName: 'MV Test',
      from: '2026-03-01T06:00:00Z',
      to: '2026-03-01T20:00:00Z',
      status: 'arrived',
    },
  ],
};
const DELIVERY = {
  id: 'd1',
  attemptedAt: '2026-03-01T14:00:00Z',
  vesselName: 'MV Test',
  eventType: 'arrival_confirmed',
  url: 'https://example.test/hook',
  ok: true,
  httpStatus: 200,
  retried: false,
};

// The server's real read-only refusal (server.js): a 403 whose body carries the
// message the UI must surface instead of the bare status code.
const READ_ONLY_403 = () =>
  makeRes(
    {
      error: 'read_only',
      message: 'This is a public read-only demo of TideLog. Clone the repo to run a writable copy.',
    },
    { ok: false, status: 403, statusText: 'Forbidden' }
  );

describe('SVD-13 dashboard offline behaviour', () => {
  test('a successful online refresh shows LIVE and a last-synced time', async () => {
    const { window } = await bootApp({ online: true });
    const badge = window.document.getElementById('status-badge');
    expect(badge.textContent).toBe('LIVE');
    expect(badge.className).toContain('badge-live');

    const synced = window.document.getElementById('last-synced');
    expect(synced.hidden).toBe(false);
    expect(synced.textContent).toMatch(/^Synced /);
  });

  test('going offline flips the badge to OFFLINE and keeps the last-synced time', async () => {
    const { window } = await bootApp({ online: true });
    const syncedText = window.document.getElementById('last-synced').textContent;
    expect(syncedText).toMatch(/^Synced /);

    setOnline(window, false);
    window.dispatchEvent(new window.Event('offline'));

    const badge = window.document.getElementById('status-badge');
    expect(badge.textContent).toBe('OFFLINE');
    expect(badge.className).toContain('badge-offline');
    // The data on screen is from the last online sync, and its timestamp stays.
    const synced = window.document.getElementById('last-synced');
    expect(synced.hidden).toBe(false);
    expect(synced.textContent).toBe(syncedText);
  });

  test('offline: confirming a berth assignment is refused, and the selection is kept', async () => {
    const { window, calls } = await bootApp({
      online: true,
      arrivals: [EXPECTED_VESSEL],
      berths: [OPEN_BERTH],
    });
    const { document } = window;

    // Open the modal via the rendered Assign button, then pick a berth.
    const assignBtn = document.querySelector('.btn-assign');
    expect(assignBtn).not.toBeNull();
    assignBtn.click();

    const radio = document.querySelector('input[name="berth-selection"]');
    expect(radio).not.toBeNull();
    radio.checked = true;
    radio.dispatchEvent(new window.Event('change'));

    const confirm = document.getElementById('modal-confirm');
    expect(confirm.disabled).toBe(false);

    // Go offline, then confirm.
    setOnline(window, false);
    const before = writeCount(calls);
    confirm.click();
    await flush();

    // No write was attempted...
    expect(writeCount(calls)).toBe(before);
    // ...the modal is still open with the selection intact...
    expect(document.getElementById('assign-modal').hidden).toBe(false);
    expect(confirm.disabled).toBe(false);
    expect(radio.checked).toBe(true);
    // ...and a clear offline message is shown.
    const msg = document.getElementById('modal-message');
    expect(msg.hidden).toBe(false);
    expect(msg.textContent.toLowerCase()).toContain('offline');
  });

  test('online: confirming a berth assignment DOES post to the API', async () => {
    const { window, calls } = await bootApp({
      online: true,
      arrivals: [EXPECTED_VESSEL],
      berths: [OPEN_BERTH],
    });
    const { document } = window;

    document.querySelector('.btn-assign').click();
    const radio = document.querySelector('input[name="berth-selection"]');
    radio.checked = true;
    radio.dispatchEvent(new window.Event('change'));

    const before = writeCount(calls);
    document.getElementById('modal-confirm').click();
    await flush();

    const posts = calls.filter((c) => c.opts && c.opts.method === 'POST');
    expect(posts.length).toBe(before + 1);
    expect(posts[posts.length - 1].url).toContain('/api/arrivals/a1/assign-berth');
  });

  test('"last synced" is when the OLDEST data on screen was fetched, not when the page asked', async () => {
    // The #56 review: stamping Date.now() on any successful read labelled cached
    // data as fresh. The time now comes off the responses (the SW's
    // X-TideLog-Fetched-At), and the board is only as fresh as its oldest read.
    const dayAgo = Date.now() - 86_400_000;
    const hourAgo = Date.now() - 3_600_000;
    const { window } = await bootApp({
      online: true,
      stamps: { arrivals: hourAgo, berths: dayAgo, tides: hourAgo },
    });
    expect(Number(window.localStorage.getItem('tidelog:last-synced'))).toBe(dayAgo);
  });

  test('a response with no fetch stamp came straight off the network, so it is current', async () => {
    const before = Date.now();
    const { window } = await bootApp({ online: true });
    expect(Number(window.localStorage.getItem('tidelog:last-synced'))).toBeGreaterThanOrEqual(
      before
    );
  });

  test('reconnecting pulls fresh data without a reload', async () => {
    const { window, calls } = await bootApp({ online: false });
    const readsBefore = calls.filter((c) => c.url.includes('/api/arrivals')).length;

    setOnline(window, true);
    window.dispatchEvent(new window.Event('online'));
    await flush();

    expect(calls.filter((c) => c.url.includes('/api/arrivals')).length).toBe(readsBefore + 1);
    expect(window.document.getElementById('status-badge').textContent).toBe('LIVE');
  });

  test('new app.js against an OLDER cached index.html still loads the board', async () => {
    // Shell files revalidate independently, so after this deploys a returning
    // visitor can run this app.js against an older document, which has no
    // #last-synced, no #modal-message, and (pre-SVD-20) no #readonly-notice or
    // #notifications-message. It must not throw before refreshing.
    const oldMarkup = (text) =>
      text
        .replace(/<span[^>]*id="last-synced"[^>]*><\/span>/, '')
        .replace(/<div[^>]*id="modal-message"[^>]*><\/div>/, '')
        .replace(/<div[^>]*id="readonly-notice"[^>]*><\/div>/, '')
        .replace(/<div[^>]*id="notifications-message"[^>]*><\/div>/, '')
        .replace(/<div[^>]*id="berths-message"[^>]*><\/div>/, '');
    const { window, calls } = await bootApp({
      online: true,
      readOnly: true, // even in demo mode, a missing notice must not break boot
      arrivals: [EXPECTED_VESSEL],
      berths: [OCCUPIED_BERTH], // a Depart against a missing #berths-message must not break boot
      html: oldMarkup,
    });
    expect(window.document.getElementById('last-synced')).toBeNull();
    expect(window.document.getElementById('modal-message')).toBeNull();
    expect(window.document.getElementById('readonly-notice')).toBeNull();
    expect(window.document.getElementById('notifications-message')).toBeNull();
    expect(window.document.getElementById('berths-message')).toBeNull();
    // The Depart button still renders and clicking it does not throw even though
    // the message element is gone (setBerthsMessage guards for it).
    const departBtn = window.document.querySelector('.btn-depart');
    expect(departBtn).not.toBeNull();
    departBtn.click();
    await flush();
    expect(calls.some((c) => c.url.includes('/api/arrivals'))).toBe(true);
    expect(window.document.getElementById('arrivals-body').textContent).toContain('MV Test');
    expect(window.document.getElementById('status-badge').textContent).toBe('LIVE');
  });

  test('the refusal message is announced to assistive tech', async () => {
    const { window } = await bootApp({ online: true });
    expect(window.document.getElementById('modal-message').getAttribute('role')).toBe('alert');
  });
});

describe('SVD-20 read-only demo mode in the UI', () => {
  test('read-only reported: the demo notice renders with its explanation, controls stay enabled', async () => {
    const { window } = await bootApp({
      online: true,
      readOnly: true,
      arrivals: [EXPECTED_VESSEL],
      berths: [OPEN_BERTH],
    });
    const { document } = window;

    const notice = document.getElementById('readonly-notice');
    expect(notice).not.toBeNull();
    expect(notice.hidden).toBe(false);
    expect(notice.textContent.toLowerCase()).toContain('read-only demo');

    // The design choice: controls stay enabled and explain on click, so the
    // Assign button is still present and usable (the refusal is shown on click).
    const assignBtn = document.querySelector('.btn-assign');
    expect(assignBtn).not.toBeNull();
    expect(assignBtn.disabled).toBe(false);
  });

  test('writable: the demo notice is not shown', async () => {
    const { window } = await bootApp({ online: true, readOnly: false });
    const notice = window.document.getElementById('readonly-notice');
    expect(notice.hidden).toBe(true);
    expect(notice.textContent).toBe('');
  });

  test('read-only: confirming an assignment shows the server message, not a 403, selection kept', async () => {
    const { window } = await bootApp({
      online: true,
      readOnly: true,
      arrivals: [EXPECTED_VESSEL],
      berths: [OPEN_BERTH],
      writeRes: READ_ONLY_403(),
    });
    const { document } = window;

    document.querySelector('.btn-assign').click();
    const radio = document.querySelector('input[name="berth-selection"]');
    radio.checked = true;
    radio.dispatchEvent(new window.Event('change'));
    const confirm = document.getElementById('modal-confirm');
    confirm.click();
    await flush();

    const msg = document.getElementById('modal-message');
    expect(msg.hidden).toBe(false);
    expect(msg.textContent.toLowerCase()).toContain('read-only demo');
    expect(msg.textContent).not.toContain('403');
    // The modal stays open with the selection intact so nothing is lost.
    expect(document.getElementById('assign-modal').hidden).toBe(false);
    expect(radio.checked).toBe(true);
  });

  test('a tab that booted offline learns it is the demo on reconnect', async () => {
    const { window } = await bootApp({ online: false, readOnly: true });
    const notice = window.document.getElementById('readonly-notice');
    // Offline boot: /api/health was unreachable, so the notice is not shown yet.
    expect(notice.hidden).toBe(true);

    setOnline(window, true);
    window.dispatchEvent(new window.Event('online'));
    await flush();

    expect(notice.hidden).toBe(false);
    expect(notice.textContent.toLowerCase()).toContain('read-only demo');
  });

  test('a transient health failure does not erase a confirmed read-only notice', async () => {
    const { window } = await bootApp({ online: true, readOnly: true });
    const notice = window.document.getElementById('readonly-notice');
    expect(notice.hidden).toBe(false); // confirmed on boot

    // A later online event whose /api/health fails transiently must keep the
    // known state, not clear it and hide the banner.
    window.__failHealth = true;
    window.dispatchEvent(new window.Event('online'));
    await flush();

    expect(notice.hidden).toBe(false);
    expect(notice.textContent.toLowerCase()).toContain('read-only demo');
  });

  test('read-only: a refused resend is reported in the panel, not swallowed', async () => {
    const { window } = await bootApp({
      online: true,
      readOnly: true,
      deliveries: [DELIVERY],
      writeRes: READ_ONLY_403(),
    });
    const { document } = window;

    const resendBtn = document.querySelector('.btn-resend');
    expect(resendBtn).not.toBeNull();
    resendBtn.click();
    await flush();

    const msg = document.getElementById('notifications-message');
    expect(msg.hidden).toBe(false);
    expect(msg.textContent.toLowerCase()).toContain('read-only demo');
    expect(msg.textContent).not.toContain('403');
  });
});

describe('SVD-21 the LIVE badge reflects the data, not navigator.onLine', () => {
  test('online with fresh network reads shows LIVE', async () => {
    const { window } = await bootApp({ online: true, fromCache: false });
    const badge = window.document.getElementById('status-badge');
    expect(badge.textContent).toBe('LIVE');
    expect(badge.className).toContain('badge-live');
  });

  test('online but reads served from the SW cache shows STALE, not LIVE', async () => {
    // navigator.onLine is true (captive portal, flaky wifi, server down), but the
    // SW fell back to cache and stamped X-TideLog-From-Cache. The board is not
    // live, and the badge must not claim it is.
    const { window } = await bootApp({ online: true, fromCache: true });
    const badge = window.document.getElementById('status-badge');
    expect(badge.textContent).toBe('STALE');
    expect(badge.className).toContain('badge-stale');
    // The data IS on screen, just stale, so last-synced still shows.
    expect(window.document.getElementById('last-synced').hidden).toBe(false);
  });

  test('a refresh whose reads fail outright (server down, cold cache) is not LIVE', async () => {
    const { window } = await bootApp({ online: true, failData: true });
    const badge = window.document.getElementById('status-badge');
    expect(badge.textContent).not.toBe('LIVE');
    expect(badge.textContent).toBe('STALE');
  });

  test('going offline flips to OFFLINE at once, even after a LIVE render', async () => {
    const { window } = await bootApp({ online: true, fromCache: false });
    expect(window.document.getElementById('status-badge').textContent).toBe('LIVE');

    setOnline(window, false);
    window.dispatchEvent(new window.Event('offline'));

    expect(window.document.getElementById('status-badge').textContent).toBe('OFFLINE');
  });

  test('reconnecting does not restore LIVE until fresh reads actually land', async () => {
    // After LIVE → offline → online, the online handler renders before the new
    // reads return. The pre-offline LIVE verdict must not carry over, or a slow
    // or hanging read would leave a misleading LIVE standing. It stays STALE
    // until the reads succeed.
    const { window } = await bootApp({ online: true, fromCache: false });
    expect(window.document.getElementById('status-badge').textContent).toBe('LIVE');

    setOnline(window, false);
    window.dispatchEvent(new window.Event('offline'));
    expect(window.document.getElementById('status-badge').textContent).toBe('OFFLINE');

    // Reconnect, but make the board reads hang (never resolve), so the refresh
    // the online handler kicks off is still pending.
    window.fetch = (url, opts) => {
      const u = String(url);
      if (opts && opts.method && opts.method !== 'GET') return Promise.resolve(makeRes({}));
      if (/\/api\/(arrivals|berths|tides)/.test(u)) return new Promise(() => {});
      if (u.includes('/api/webhooks')) return Promise.resolve(makeRes({ deliveries: [] }));
      return Promise.resolve(makeRes({}));
    };
    setOnline(window, true);
    window.dispatchEvent(new window.Event('online'));
    await flush();

    // Online again, but no fresh read has returned — not LIVE.
    expect(window.document.getElementById('status-badge').textContent).toBe('STALE');
  });

  test('a stale LIVE badge does not survive a later failed refresh', async () => {
    // Today a failed refresh() keeps the last render and leaves the badge as it
    // was, so "LIVE" could outlive the connection that earned it. It must drop to
    // STALE once a refresh no longer reaches the server.
    const { window, calls } = await bootApp({ online: true, fromCache: false });
    expect(window.document.getElementById('status-badge').textContent).toBe('LIVE');

    // Flip the mock so the next board reads reject, then trigger a refresh the way
    // the page does (the type filter calls refresh()).
    calls.length = 0;
    window.fetch = (url, opts) => {
      const u = String(url);
      if (opts && opts.method && opts.method !== 'GET') return Promise.resolve(makeRes({}));
      if (/\/api\/(arrivals|berths|tides)/.test(u)) return Promise.reject(new Error('network'));
      if (u.includes('/api/webhooks')) return Promise.resolve(makeRes({ deliveries: [] }));
      return Promise.resolve(makeRes({}));
    };
    window.document.getElementById('type-filter').dispatchEvent(new window.Event('change'));
    await flush();

    expect(window.document.getElementById('status-badge').textContent).toBe('STALE');
  });

  test('reads that were in flight across a drop cannot restore LIVE on reconnect', async () => {
    // Copilot on #59: the offline handler clears the LIVE verdict, but a refresh
    // already in flight could land afterwards and set it again, so reconnecting
    // showed LIVE before any read had reached the server since the drop.
    const { window } = await bootApp({ online: true, fromCache: false });
    expect(window.document.getElementById('status-badge').textContent).toBe('LIVE');

    // Start a refresh whose board reads are held open.
    const pending = [];
    window.fetch = (url, opts) => {
      const u = String(url);
      if (opts && opts.method && opts.method !== 'GET') return Promise.resolve(makeRes({}));
      if (/\/api\/(arrivals|berths|tides)/.test(u))
        return new Promise((resolve) => pending.push({ u, resolve }));
      if (u.includes('/api/webhooks')) return Promise.resolve(makeRes({ deliveries: [] }));
      return Promise.resolve(makeRes({}));
    };
    window.document.getElementById('type-filter').dispatchEvent(new window.Event('change'));
    await flush();
    expect(pending.length).toBe(3);

    // The connection drops while those reads are in flight...
    setOnline(window, false);
    window.dispatchEvent(new window.Event('offline'));
    expect(window.document.getElementById('status-badge').textContent).toBe('OFFLINE');

    // ...then they land, fresh from the network but from before the drop.
    for (const p of pending) {
      const key = p.u.includes('arrivals')
        ? 'arrivals'
        : p.u.includes('berths')
          ? 'berths'
          : 'windows';
      p.resolve(makeRes({ [key]: [] }, { fromCache: false }));
    }
    await flush();

    // Reconnect with the new reads still pending: nothing has reached the server
    // since the drop, so the badge must not say LIVE.
    window.fetch = (url, opts) => {
      const u = String(url);
      if (opts && opts.method && opts.method !== 'GET') return Promise.resolve(makeRes({}));
      if (/\/api\/(arrivals|berths|tides)/.test(u)) return new Promise(() => {});
      if (u.includes('/api/webhooks')) return Promise.resolve(makeRes({ deliveries: [] }));
      return Promise.resolve(makeRes({}));
    };
    setOnline(window, true);
    window.dispatchEvent(new window.Event('online'));
    await flush();
    expect(window.document.getElementById('status-badge').textContent).not.toBe('LIVE');
  });

  // Refreshes overlap (timer, type filter, reconnect) and can land out of order.
  // These hold each refresh's board reads open so the order is exact.
  function holdBoardReads(window) {
    const held = [];
    window.fetch = (url, opts) => {
      const u = String(url);
      if (opts && opts.method && opts.method !== 'GET') return Promise.resolve(makeRes({}));
      if (/\/api\/(arrivals|berths|tides)/.test(u))
        return new Promise((resolve, reject) => held.push({ u, resolve, reject }));
      if (u.includes('/api/webhooks')) return Promise.resolve(makeRes({ deliveries: [] }));
      return Promise.resolve(makeRes({}));
    };
    return held;
  }
  function boardBody(u, vesselName) {
    if (u.includes('arrivals')) return { arrivals: [{ ...EXPECTED_VESSEL, vesselName }] };
    if (u.includes('berths')) return { berths: [] };
    return { windows: [] };
  }
  function startRefresh(window) {
    window.document.getElementById('type-filter').dispatchEvent(new window.Event('change'));
  }

  test('an older refresh failing after a newer one succeeded does not downgrade it', async () => {
    const { window } = await bootApp({ online: true, fromCache: false });
    const older = holdBoardReads(window);
    startRefresh(window);
    await flush();
    const newer = holdBoardReads(window);
    startRefresh(window);
    await flush();
    expect(older.length).toBe(3);
    expect(newer.length).toBe(3);

    for (const r of newer) r.resolve(makeRes(boardBody(r.u, 'MV Newer'), { fromCache: false }));
    await flush();
    expect(window.document.getElementById('status-badge').textContent).toBe('LIVE');

    for (const r of older) r.reject(new Error('network'));
    await flush();
    expect(window.document.getElementById('status-badge').textContent).toBe('LIVE');
    expect(window.document.getElementById('arrivals-body').textContent).toContain('MV Newer');
  });

  test('an older cached result landing after a newer fresh one cannot replace it under LIVE', async () => {
    // Copilot on #59: refresh A starts before a drop, reconnect refresh B lands
    // fresh, then A lands from cache. A must not replace B's board while the
    // badge still says LIVE.
    const { window } = await bootApp({ online: true, fromCache: false });
    const a = holdBoardReads(window);
    startRefresh(window);
    await flush();

    setOnline(window, false);
    window.dispatchEvent(new window.Event('offline'));
    const b = holdBoardReads(window);
    setOnline(window, true);
    window.dispatchEvent(new window.Event('online')); // starts refresh B
    await flush();
    expect(b.length).toBe(3);

    for (const r of b) r.resolve(makeRes(boardBody(r.u, 'MV Fresh'), { fromCache: false }));
    await flush();
    expect(window.document.getElementById('status-badge').textContent).toBe('LIVE');

    for (const r of a) r.resolve(makeRes(boardBody(r.u, 'MV Cached'), { fromCache: true }));
    await flush();
    const board = window.document.getElementById('arrivals-body').textContent;
    expect(board).toContain('MV Fresh');
    expect(board).not.toContain('MV Cached');
    expect(window.document.getElementById('status-badge').textContent).toBe('LIVE');
  });
});

describe('SVD-18 Depart action on occupied berths', () => {
  // An occupant as the real /api/berths payload shapes it (berthView): a status
  // alongside the identity fields. The Depart button is gated on this status.
  function occupant(arrivalId, vesselName, status) {
    return { arrivalId, vesselName, to: '2026-03-01T20:00:00Z', status };
  }
  function berthWith(occupants) {
    return {
      id: 'B1',
      name: 'North Quay',
      lengthM: 100,
      depthM: 8,
      occupied: occupants.length > 0,
      outOfService: false,
      occupant: occupants[0] || null,
      occupants,
    };
  }
  function departButtons(document) {
    return [...document.querySelectorAll('.btn-depart')];
  }
  const A_409 = () =>
    makeRes(
      { error: 'only arrived or overdue vessels can be departed' },
      { ok: false, status: 409, statusText: 'Conflict' }
    );

  test('Depart shows only for arrived/overdue occupants, not expected', async () => {
    const { window } = await bootApp({
      online: true,
      berths: [
        berthWith([
          occupant('arr-arrived', 'MV Arrived', 'arrived'),
          occupant('arr-overdue', 'MV Overdue', 'overdue'),
          occupant('arr-expected', 'MV Expected', 'expected'),
        ]),
      ],
    });
    const { document } = window;
    // All three vessels are listed on the tile...
    const board = document.getElementById('berth-list').textContent;
    expect(board).toContain('MV Arrived');
    expect(board).toContain('MV Overdue');
    expect(board).toContain('MV Expected');
    // ...but only the two departable ones get a button.
    expect(departButtons(document)).toHaveLength(2);
  });

  test('clicking Depart posts to /depart for the right arrival and refreshes', async () => {
    const { window, calls } = await bootApp({
      online: true,
      berths: [berthWith([occupant('arr-1', 'MV One', 'arrived')])],
    });
    const { document } = window;

    const before = writeCount(calls);
    const readsBefore = calls.filter((c) => c.url.includes('/api/arrivals')).length;
    departButtons(document)[0].click();
    await flush();

    const posts = calls.filter((c) => c.opts && c.opts.method === 'POST');
    expect(writeCount(calls)).toBe(before + 1);
    expect(posts[posts.length - 1].url).toContain('/api/arrivals/arr-1/depart');
    // refresh() ran: the board was re-read after the successful write.
    expect(calls.filter((c) => c.url.includes('/api/arrivals')).length).toBeGreaterThan(
      readsBefore
    );
  });

  test('a rafted berth lists both occupants; departing one targets only that arrival', async () => {
    const { window, calls } = await bootApp({
      online: true,
      berths: [
        berthWith([
          occupant('raft-1', 'Raft One', 'arrived'),
          occupant('raft-2', 'Raft Two', 'arrived'),
        ]),
      ],
    });
    const { document } = window;

    const buttons = departButtons(document);
    expect(buttons).toHaveLength(2);
    expect(document.getElementById('berth-list').textContent).toContain('Raft One');
    expect(document.getElementById('berth-list').textContent).toContain('Raft Two');

    buttons[0].click();
    await flush();

    const posts = calls.filter((c) => c.opts && c.opts.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toContain('/api/arrivals/raft-1/depart');
    // The other occupant's control is untouched and still points at its own id.
    expect(document.getElementById('berth-list').textContent).toContain('Raft Two');
  });

  test('a filtered-out vessel keeps its berth tile and its Depart button', async () => {
    // The berths endpoint is not filtered by the arrivals type dropdown, so the
    // board must render occupants regardless of the filter (SVD-18).
    const { window, calls } = await bootApp({
      online: true,
      berths: [berthWith([occupant('arr-1', 'MV One', 'arrived')])],
    });
    const { document } = window;
    expect(departButtons(document)).toHaveLength(1);

    const filter = document.getElementById('type-filter');
    filter.value = 'tanker';
    filter.dispatchEvent(new window.Event('change'));
    await flush();

    // The arrivals read is now type-scoped, but the berth tile still lists the
    // occupant and still offers Depart.
    expect(calls.some((c) => c.url.includes('type=tanker'))).toBe(true);
    expect(document.getElementById('berth-list').textContent).toContain('MV One');
    expect(departButtons(document)).toHaveLength(1);
  });

  test('offline: Depart is refused with a clear message, no write attempted', async () => {
    const { window, calls } = await bootApp({
      online: true,
      berths: [berthWith([occupant('arr-1', 'MV One', 'arrived')])],
    });
    const { document } = window;

    setOnline(window, false);
    const before = writeCount(calls);
    departButtons(document)[0].click();
    await flush();

    expect(writeCount(calls)).toBe(before);
    const msg = document.getElementById('berths-message');
    expect(msg.hidden).toBe(false);
    expect(msg.textContent.toLowerCase()).toContain('offline');
  });

  test('read-only: Depart shows the server message, not a bare 403', async () => {
    const { window } = await bootApp({
      online: true,
      readOnly: true,
      berths: [berthWith([occupant('arr-1', 'MV One', 'arrived')])],
      writeRes: READ_ONLY_403(),
    });
    const { document } = window;

    departButtons(document)[0].click();
    await flush();

    const msg = document.getElementById('berths-message');
    expect(msg.hidden).toBe(false);
    expect(msg.textContent.toLowerCase()).toContain('read-only demo');
    expect(msg.textContent).not.toContain('403');
  });

  test('a 409 from the server (wrong status) is shown, not swallowed', async () => {
    const { window } = await bootApp({
      online: true,
      berths: [berthWith([occupant('arr-1', 'MV One', 'arrived')])],
      writeRes: A_409(),
    });
    const { document } = window;

    departButtons(document)[0].click();
    await flush();

    const msg = document.getElementById('berths-message');
    expect(msg.hidden).toBe(false);
    expect(msg.textContent).toContain('only arrived or overdue vessels can be departed');
    expect(msg.textContent).not.toContain('409');
  });

  test('a dropped connection mid-request is reported, not swallowed', async () => {
    // The POST itself rejects (online, but the server became unreachable) —
    // departVessel's catch branch must surface a connection message.
    const { window } = await bootApp({
      online: true,
      berths: [berthWith([occupant('arr-1', 'MV One', 'arrived')])],
    });
    const { document } = window;

    window.fetch = (url, opts) => {
      const u = String(url);
      if (opts && opts.method === 'POST' && u.includes('/depart'))
        return Promise.reject(new Error('network'));
      if (u.includes('/api/webhooks')) return Promise.resolve(makeRes({ deliveries: [] }));
      return Promise.resolve(makeRes({}));
    };

    const btn = departButtons(document)[0];
    btn.click();
    await flush();

    const msg = document.getElementById('berths-message');
    expect(msg.hidden).toBe(false);
    expect(msg.textContent.toLowerCase()).toContain('connection');
    // The failed request re-enables the button so the operator can retry.
    expect(btn.disabled).toBe(false);
  });

  test('each Depart button names its vessel for assistive tech', async () => {
    const { window } = await bootApp({
      online: true,
      berths: [
        berthWith([
          occupant('raft-1', 'Raft One', 'arrived'),
          occupant('raft-2', 'Raft Two', 'arrived'),
        ]),
      ],
    });
    const labels = departButtons(window.document).map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Depart Raft One', 'Depart Raft Two']);
  });

  test('a double-click cannot fire two departures: the button disables while pending', async () => {
    const { window } = await bootApp({
      online: true,
      berths: [berthWith([occupant('arr-1', 'MV One', 'arrived')])],
    });
    const { document } = window;

    // Hold the departure POST open so the request stays in flight, counting how
    // many are actually sent.
    let departPosts = 0;
    window.fetch = (url, opts) => {
      const u = String(url);
      if (opts && opts.method === 'POST' && u.includes('/depart')) {
        departPosts += 1;
        return new Promise(() => {});
      }
      if (u.includes('/api/webhooks')) return Promise.resolve(makeRes({ deliveries: [] }));
      return Promise.resolve(makeRes({}));
    };

    const btn = departButtons(document)[0];
    btn.click();
    await flush();
    expect(btn.disabled).toBe(true);
    btn.click(); // the double-click
    await flush();

    expect(departPosts).toBe(1);
  });
});
