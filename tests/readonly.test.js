'use strict';

/**
 * The public demo runs with TILDELOG_READ_ONLY set; these lock in that reads
 * still work and writes are refused. server.js reads the env var at require
 * time, so each case loads a fresh module registry.
 */

const request = require('supertest');

function loadApp(readOnly) {
  jest.resetModules();
  if (readOnly) {
    process.env.TIDELOG_READ_ONLY = 'true';
  } else {
    delete process.env.TIDELOG_READ_ONLY;
  }
  return require('../server');
}

afterEach(() => {
  delete process.env.TIDELOG_READ_ONLY;
});

describe('read-only demo mode', () => {
  test('reads still work', async () => {
    const app = loadApp(true);
    await request(app).get('/api/health').expect(200);
    await request(app).get('/api/berths').expect(200);
  });

  test('writes are refused with a useful message', async () => {
    const app = loadApp(true);
    const res = await request(app).post('/api/arrivals').send({ vessel: 'MV Test' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('read_only');
    expect(res.body.message).toMatch(/read-only demo/i);
  });

  test('off by default — the app stays writable for local dev and tests', async () => {
    const app = loadApp(false);
    const res = await request(app).post('/api/arrivals').send({ vessel: 'MV Test' });
    expect(res.status).not.toBe(403);
  });
});
