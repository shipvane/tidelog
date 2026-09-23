'use strict';

/**
 * No-real-network guard for the whole suite (SVE-151).
 *
 * This runs via jest `setupFilesAfterEnv`, so it wraps *every* test file — the
 * enforcement lives here, not in each spec, which is the whole point: a test
 * file written months from now by someone who never read the backlog item is
 * still covered without doing anything.
 *
 * Before each test it does two things:
 *   1. Replaces `global.fetch` with a spy that never settles. Real outbound
 *      requests are therefore impossible: any code that reaches the wire hangs
 *      on this promise instead of hitting a host, and the count of calls is
 *      recorded.
 *   2. Installs a fake transport into `lib/webhooks.js` so the webhook engine's
 *      fire-and-forget deliveries resolve locally (a successful 200) without
 *      ever touching `global.fetch`.
 *
 * After each test it restores `global.fetch`, drops the transport override, and
 * — the guard — fails loudly if `global.fetch` was called at all. In normal
 * operation nothing calls it, because deliveries go through the injected
 * transport; a call means a test (or code it exercised) tried to reach the real
 * network, which is exactly what must never happen.
 */

const transport = require('../support/webhook-transport');

let realFetch;

beforeEach(() => {
  realFetch = global.fetch;
  // Never settles: an accidental real request hangs here rather than going out,
  // and is caught by the afterEach guard below.
  global.fetch = jest.fn(() => new Promise(() => {}));
  transport.installDefaultTransport();
});

afterEach(() => {
  const realCalls = global.fetch && global.fetch.mock ? global.fetch.mock.calls.length : 0;
  global.fetch = realFetch;
  transport.uninstallTransport();

  if (realCalls > 0) {
    throw new Error(
      `SVE-151: a test triggered ${realCalls} real outbound fetch(). No test may ` +
        `make a real network request — route webhook deliveries through the ` +
        `injected transport (tests/support/webhook-transport.js) instead.`
    );
  }
});
