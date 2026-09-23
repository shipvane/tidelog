'use strict';

/**
 * The public demo runs with TILDELOG_READ_ONLY set; these lock in that reads
 * still work and writes are refused. server.js reads the env var at require
 * time, so each case loads a fresh module registry.
 */

const http = require('http');

const request = require('supertest');

// This file can't use tests/support/server.js's boundServer: each case builds a
// fresh app under a different TIDELOG_READ_ONLY, so the server is created
// per-test rather than once per file. It follows the same principle though —
// one listening server per app, reused across that case's requests, instead of
// supertest's per-request `listen(0)` (SVE-153) — and closes it in afterEach.
const openServers = [];

async function loadApp(readOnly) {
  jest.resetModules();
  if (readOnly) {
    process.env.TIDELOG_READ_ONLY = 'true';
  } else {
    delete process.env.TIDELOG_READ_ONLY;
  }
  const app = require('../server');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  openServers.push(server);
  return server;
}

afterEach(async () => {
  delete process.env.TIDELOG_READ_ONLY;
  await Promise.all(
    openServers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
  );
});

describe('read-only demo mode', () => {
  test('reads still work', async () => {
    const app = await loadApp(true);
    await request(app).get('/api/health').expect(200);
    await request(app).get('/api/berths').expect(200);
  });

  test('writes are refused with a useful message', async () => {
    const app = await loadApp(true);
    const res = await request(app).post('/api/arrivals').send({ vessel: 'MV Test' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('read_only');
    expect(res.body.message).toMatch(/read-only demo/i);
  });

  test('off by default — the app stays writable for local dev and tests', async () => {
    const app = await loadApp(false);
    const res = await request(app).post('/api/arrivals').send({ vessel: 'MV Test' });
    expect(res.status).not.toBe(403);
  });
});
