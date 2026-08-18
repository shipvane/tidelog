'use strict';

/**
 * demo.shipvane.com is a legacy alias for tidelog.shipvane.com: requests
 * carrying the old Host 301 to the new domain with their path and query
 * intact, and every other host (the real domain, localhost, App Runner's own
 * hostname) is untouched.
 */

const request = require('supertest');

const app = require('../server');

describe('demo.shipvane.com alias', () => {
  it('301s the old host to tidelog.shipvane.com, path and query intact', async () => {
    const res = await request(app)
      .get('/api/berths?available=true')
      .set('Host', 'demo.shipvane.com');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('https://tidelog.shipvane.com/api/berths?available=true');
  });

  it('301s the www variant of the old host too', async () => {
    const res = await request(app).get('/').set('Host', 'www.demo.shipvane.com');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('https://tidelog.shipvane.com/');
  });

  it('serves the new domain normally', async () => {
    const res = await request(app).get('/api/health').set('Host', 'tidelog.shipvane.com');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('tidelog');
  });

  it('leaves localhost untouched (dev and tests)', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });
});
