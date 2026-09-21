'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const app = require('../server');

describe('Service Worker', () => {
  test('serves sw.js at the root scope', async () => {
    const res = await request(app).get('/sw.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/javascript');
  });

  test('precache list in sw.js includes files that exist in public/', () => {
    const swPath = path.join(__dirname, '../public/sw.js');
    const swContent = fs.readFileSync(swPath, 'utf-8');

    // Extract PRECACHE_URLS array from the SW
    const precacheMatch = swContent.match(/const PRECACHE_URLS = \[([\s\S]*?)\]/);
    expect(precacheMatch).not.toBeNull();
    const precacheBlock = precacheMatch[1];

    // Parse the precached URLs (they are single-quoted or double-quoted strings)
    const urlMatches = precacheBlock.match(/['"]([^'"]+)['"]/g);
    expect(urlMatches).not.toBeNull();
    const precachedUrls = urlMatches.map((m) => m.replace(/[']/g, ''));

    // Get list of actual files in public/
    const publicDir = path.join(__dirname, '../public');
    const files = fs.readdirSync(publicDir).filter((f) => !f.startsWith('.'));

    // Check that expected files are in the precache list
    expect(precachedUrls).toContain('/app.js');
    expect(precachedUrls).toContain('/styles.css');
    expect(precachedUrls).toContain('/index.html');
    expect(precachedUrls).toContain('/');

    // Verify no files in public/ are forgotten (except sw.js itself, which is excluded)
    for (const file of files) {
      if (file === 'sw.js') {
        // sw.js is excluded from precache on purpose (served on-demand, not cached)
        continue;
      }
      const filePath = `/${file}`;
      expect(precachedUrls).toContain(filePath);
    }
  });

  test('sw.js does not have cache rules for /api/*', () => {
    const swPath = path.join(__dirname, '../public/sw.js');
    const swContent = fs.readFileSync(swPath, 'utf-8');

    // Check that the SW explicitly excludes /api/ from caching
    expect(swContent).toMatch(/\/api\//);
    expect(swContent).toMatch(/fetch\(request\)/);
    // The SW should have logic that returns a network-only response for /api
    expect(swContent).toContain("url.pathname.startsWith('/api/')");
  });

  test('sw.js has a CACHE_VERSION constant to control cache busting', () => {
    const swPath = path.join(__dirname, '../public/sw.js');
    const swContent = fs.readFileSync(swPath, 'utf-8');

    // Check for CACHE_VERSION constant
    expect(swContent).toMatch(/const CACHE_VERSION = ['"]v[\d.]+[\w-]*['"]/);
  });

  test('sw.js includes documentation for the emergency kill switch', () => {
    const swPath = path.join(__dirname, '../public/sw.js');
    const swContent = fs.readFileSync(swPath, 'utf-8');

    // The SW should document how to disable it in an emergency
    expect(swContent).toMatch(/disable|emergency|unregister/i);
  });

  test('app.js registers the service worker when available', async () => {
    const appPath = path.join(__dirname, '../public/app.js');
    const appContent = fs.readFileSync(appPath, 'utf-8');

    // Check that app.js registers the SW
    expect(appContent).toContain("'serviceWorker' in navigator");
    expect(appContent).toContain('navigator.serviceWorker.register');
    expect(appContent).toContain("'/sw.js'");
    expect(appContent).toContain("scope: '/'");
  });

  test('app.js guards SW registration with feature detection', async () => {
    const appPath = path.join(__dirname, '../public/app.js');
    const appContent = fs.readFileSync(appPath, 'utf-8');

    // The registration should be guarded by checking navigator.serviceWorker availability
    expect(appContent).toMatch(/if\s*\(\s*['"]serviceWorker['"]\s+in\s+navigator\s*\)/);
  });

  test('GET / returns HTML with app shell content', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('TideLog');
  });
});
