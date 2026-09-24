'use strict';

const http = require('http');

/**
 * Bind an Express app to ONE persistent HTTP server for the whole test file and
 * return that listening server for supertest to reuse (SVE-153).
 *
 * Why this exists — the ~13% suite flake. `request(app)` hands supertest the
 * bare Express app, and supertest then does `http.createServer(app).listen(0)`
 * for *every single request* (node_modules/supertest/lib/test.js:39 and :63).
 * A route-heavy suite makes thousands of these ephemeral listen/close cycles,
 * and under that churn an occasional response is lost — supertest resolves with
 * an empty `res.body`, so `res.body.arrival` reads back `undefined` — or a
 * request never completes and trips the 5 s jest timeout. Those are exactly the
 * shapes SVE-153 was failing on, in tests that fire no webhooks and touch no
 * network. It reproduced with a single worker running a single file (1/40),
 * which rules out cross-worker and cross-file state: the cause is the
 * per-request server, not the in-memory store.
 *
 * A server that is already listening has a truthy `.address()`, so supertest's
 * `serverAddress` skips the per-request `listen(0)` and reuses this one socket
 * for the file. Requests go out byte-for-byte unchanged; callers keep writing
 * `request(app)`.
 *
 * The helper registers its own `beforeAll`/`afterAll`, so a file adopts it by
 * changing one line:
 *   const app = boundServer(require('../server'));
 *
 * @param {import('express').Express} expressApp
 * @returns {import('http').Server} a listening server, safe to pass to supertest
 */
function boundServer(expressApp) {
  const server = http.createServer(expressApp);
  // Block bodies on purpose: `server.listen(...)`/`server.close(...)` return the
  // server, and jest rejects a hook that both takes `done` and returns a value.
  beforeAll((done) => {
    server.listen(0, done);
  });
  afterAll((done) => {
    server.close(done);
  });
  return server;
}

module.exports = { boundServer };
