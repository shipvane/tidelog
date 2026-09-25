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

function makeRes(body, { ok = true, status = 200, statusText = 'OK' } = {}) {
  return { ok, status, statusText, json: async () => body };
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
} = {}) {
  const pageRes = await request(app).get('/');
  const dom = new JSDOM(pageRes.text, { url: 'http://localhost:3000', runScripts: 'outside-only' });
  openDoms.push(dom);
  const { window } = dom;

  const calls = [];
  window.fetch = (url, opts) => {
    const u = String(url);
    calls.push({ url: u, opts });
    if (opts && opts.method && opts.method !== 'GET') return Promise.resolve(makeRes({}));
    if (u.includes('/api/arrivals')) return Promise.resolve(makeRes({ arrivals }));
    if (u.includes('/api/berths')) return Promise.resolve(makeRes({ berths }));
    if (u.includes('/api/tides')) return Promise.resolve(makeRes({ windows }));
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
});
