'use strict';

// PWA (1/3): installable shell. The failure this guards against is not a broken
// manifest — it is a manifest that parses but points at an icon that 404s, which
// the browser swallows silently and only shows as a missing install icon. So we
// parse the manifest and actually fetch every icon it names.

const request = require('supertest');

const app = require('../server');

describe('PWA installable shell', () => {
  it('serves the web app manifest with a manifest content type', async () => {
    const res = await request(app).get('/manifest.webmanifest');
    expect(res.status).toBe(200);
    // express.static maps .webmanifest -> application/manifest+json via mime-db.
    expect(res.headers['content-type']).toMatch(/manifest\+json|application\/json/);
  });

  it('has the fields an installable PWA needs', async () => {
    const res = await request(app).get('/manifest.webmanifest');
    const manifest = JSON.parse(res.text);
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(manifest.background_color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('declares a maskable icon separate from the "any" icons', async () => {
    const res = await request(app).get('/manifest.webmanifest');
    const manifest = JSON.parse(res.text);
    const purposes = manifest.icons.map((i) => i.purpose);
    expect(purposes).toContain('any');
    expect(purposes).toContain('maskable');
    // Android crops a full-bleed design under its adaptive mask, so the maskable
    // icon must be its own file, not an alias of an "any" icon.
    const maskable = manifest.icons.find((i) => i.purpose === 'maskable');
    const any = manifest.icons.filter((i) => i.purpose === 'any').map((i) => i.src);
    expect(any).not.toContain(maskable.src);
  });

  it('serves every icon the manifest names as a real PNG', async () => {
    const res = await request(app).get('/manifest.webmanifest');
    const manifest = JSON.parse(res.text);
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      const iconRes = await request(app).get(icon.src);
      expect(iconRes.status).toBe(200);
      expect(iconRes.headers['content-type']).toBe('image/png');
      expect(Number(iconRes.headers['content-length'])).toBeGreaterThan(0);
    }
  });

  it('serves the apple-touch-icon referenced by index.html', async () => {
    const res = await request(app).get('/icons/apple-touch-icon.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('links the manifest and iOS meta tags from index.html', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<link[^>]+rel="manifest"[^>]+href="\/manifest\.webmanifest"/);
    expect(res.text).toMatch(
      /<link[^>]+rel="apple-touch-icon"[^>]+href="\/icons\/apple-touch-icon\.png"/
    );
    expect(res.text).toMatch(/name="apple-mobile-web-app-capable"/);
    expect(res.text).toMatch(/name="apple-mobile-web-app-status-bar-style"/);
    expect(res.text).toMatch(/name="apple-mobile-web-app-title"/);
    expect(res.text).toMatch(/name="theme-color"/);
  });
});
