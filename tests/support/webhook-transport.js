'use strict';

/**
 * Test transport control for the webhook delivery engine (SVE-151).
 *
 * `lib/webhooks.js` posts deliveries through a seam that defaults to the global
 * `fetch`. In the suite that default is never used: `tests/setup/no-network.js`
 * installs a fake transport before every test (so no delivery ever touches the
 * wire) and a never-settling `global.fetch` spy that the same setup asserts is
 * never called. This module is the shared handle both that setup and individual
 * specs use to install, inspect and retune the fake transport.
 *
 * A test that needs a *failing* delivery (to exercise retry / error logging)
 * calls `setWebhookTransport(...)` with its own stub. A test that waits for a
 * fire-and-forget delivery to land uses `waitForDeliveries` rather than a fixed
 * sleep — a fixed sleep is exactly what raced in CI.
 */

const webhooks = require('../../lib/webhooks');

/**
 * The default fake transport: resolves immediately as a successful 200. That
 * keeps fire-and-forget deliveries fast (no network, no arming of the 5 s retry
 * timer) so a delivery log entry appears within a poll or two.
 */
function makeOkTransport() {
  return jest.fn(async () => ({ ok: true, status: 200 }));
}

/** A transport that rejects — used by specs that assert failure handling. */
function makeFailingTransport(message = 'ECONNREFUSED') {
  return jest.fn(async () => {
    throw new Error(message);
  });
}

let active = null;

/** Install the default OK transport. Called from `beforeEach` in the setup. */
function installDefaultTransport() {
  active = makeOkTransport();
  webhooks.__setFetch(active);
  return active;
}

/** Remove the transport override, restoring the global-`fetch` default. */
function uninstallTransport() {
  active = null;
  webhooks.__resetFetch();
}

/** Replace the active transport for the current test. */
function setWebhookTransport(fn) {
  active = fn;
  webhooks.__setFetch(fn);
  return fn;
}

/** The transport currently in force (a `jest.fn`, or whatever a test set). */
function currentTransport() {
  return active;
}

/**
 * Poll `read` against a deadline until `predicate` is satisfied, then return
 * the last value read. Replaces the fixed `setTimeout(r, 100)` waits that could
 * index into an empty delivery log and throw a `TypeError` under a slow
 * delivery. On timeout it returns the last value so the caller's assertion
 * reports the delivery log, not an undefined.
 *
 * @template T
 * @param {() => Promise<T>} read
 * @param {(value: T) => boolean} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number }} [opts]
 * @returns {Promise<T>}
 */
async function waitFor(read, predicate, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!predicate(last)) {
    if (Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await read();
  }
  return last;
}

/**
 * Wait for the delivery log (optionally filtered) to reach `min` entries and
 * return the `{ deliveries }` body. Uses a supertest agent bound to the app.
 *
 * @param {import('supertest').SuperTest<import('supertest').Test>|Function} request
 * @param {import('express').Express} app
 * @param {{ query?: string, min?: number, timeoutMs?: number }} [opts]
 */
async function waitForDeliveries(request, app, { query = '', min = 1, timeoutMs = 3000 } = {}) {
  const path = `/api/webhooks/deliveries${query}`;
  const body = await waitFor(
    async () => (await request(app).get(path)).body,
    (b) => Array.isArray(b.deliveries) && b.deliveries.length >= min,
    { timeoutMs }
  );
  return body;
}

module.exports = {
  makeOkTransport,
  makeFailingTransport,
  installDefaultTransport,
  uninstallTransport,
  setWebhookTransport,
  currentTransport,
  waitFor,
  waitForDeliveries,
};
