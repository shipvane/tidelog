'use strict';

/**
 * PWA (Progressive Web App) tests:
 * - manifest.webmanifest is served with the correct content type
 * - all icon paths referenced in the manifest are fetchable (200 status)
 * - manifest contains required PWA properties
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const { boundServer } = require('./support/server');
const app = boundServer(require('../server'));

describe('PWA - manifest and icons', () => {
  test('GET /manifest.webmanifest returns 200 with application/manifest+json', async () => {
    const res = await request(app).get('/manifest.webmanifest');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/manifest+json');
  });

  test('manifest.webmanifest contains required PWA properties', async () => {
    const res = await request(app).get('/manifest.webmanifest');
    expect(res.status).toBe(200);

    const manifest = res.body;
    expect(manifest.name).toBe('TideLog');
    expect(manifest.short_name).toBe('TideLog');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBe('#0b1f33');
    expect(manifest.background_color).toBe('#f4f7fa');
  });

  test('manifest.webmanifest contains exactly three icons with correct purposes', async () => {
    const res = await request(app).get('/manifest.webmanifest');
    expect(res.status).toBe(200);

    const manifest = res.body;
    expect(manifest.icons).toHaveLength(3);

    // Verify 192x192 (any)
    expect(manifest.icons[0]).toEqual({
      src: '/icons/icon-192.png',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any',
    });

    // Verify 512x512 (any)
    expect(manifest.icons[1]).toEqual({
      src: '/icons/icon-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any',
    });

    // Verify 512x512 (maskable)
    expect(manifest.icons[2]).toEqual({
      src: '/icons/icon-512-maskable.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    });
  });

  test('all icon paths in manifest are fetchable with 200 status', async () => {
    const res = await request(app).get('/manifest.webmanifest');
    expect(res.status).toBe(200);

    const manifest = res.body;
    expect(manifest.icons).toBeDefined();

    for (const icon of manifest.icons) {
      const iconRes = await request(app).get(icon.src);
      expect(iconRes.status).toBe(200);
      expect(iconRes.headers['content-type']).toContain('image/png');
    }
  });

  test('all icon files exist on disk', async () => {
    const iconDir = path.join(__dirname, '..', 'public', 'icons');
    const requiredIcons = [
      'icon-192.png',
      'icon-512.png',
      'icon-512-maskable.png',
      'apple-touch-icon.png',
    ];

    for (const iconFile of requiredIcons) {
      const filePath = path.join(iconDir, iconFile);
      expect(fs.existsSync(filePath)).toBe(true);
    }
  });

  test('icon-192.png exists and is fetchable at /icons/icon-192.png', async () => {
    const res = await request(app).get('/icons/icon-192.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
  });

  test('icon-512.png exists and is fetchable at /icons/icon-512.png', async () => {
    const res = await request(app).get('/icons/icon-512.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
  });

  test('icon-512-maskable.png exists and is fetchable at /icons/icon-512-maskable.png', async () => {
    const res = await request(app).get('/icons/icon-512-maskable.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
  });

  test('apple-touch-icon.png exists and is fetchable at /icons/apple-touch-icon.png', async () => {
    const res = await request(app).get('/icons/apple-touch-icon.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
  });
});

describe('PWA - iOS meta tags', () => {
  test('index.html contains apple-mobile-web-app-capable meta tag', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('apple-mobile-web-app-capable');
    expect(res.text).toContain('content="yes"');
  });

  test('index.html contains apple-mobile-web-app-status-bar-style meta tag', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('apple-mobile-web-app-status-bar-style');
    expect(res.text).toContain('black-translucent');
  });

  test('index.html contains apple-mobile-web-app-title meta tag with "TideLog"', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('apple-mobile-web-app-title');
    expect(res.text).toContain('content="TideLog"');
  });

  test('index.html contains apple-touch-icon link', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('rel="apple-touch-icon"');
    expect(res.text).toContain('href="icons/apple-touch-icon.png"');
  });

  test('index.html contains manifest link', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('rel="manifest"');
    expect(res.text).toContain('href="manifest.webmanifest"');
  });

  test('index.html contains theme-color meta tag', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('name="theme-color"');
    expect(res.text).toContain('content="#0b1f33"');
  });

  test('index.html contains favicon link to real icon file', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('rel="icon"');
    expect(res.text).toContain('href="icons/icon-192.png"');
    // Should NOT contain the old data-URI favicon
    expect(res.text).not.toContain('data:image/svg+xml');
  });

  // --- asset-level validation (Copilot review on #38) ---------------------
  // The tests above prove the icon PATHS serve a PNG. They do not prove the
  // file is the size the manifest advertises, so a 32x32 dropped in as
  // icon-512.png would pass every one of them. Read the real dimensions out of
  // the PNG header: bytes 0-7 are the signature, then the IHDR chunk carries
  // width and height as big-endian uint32 at offsets 16 and 20. No dependency,
  // and no trusting the manifest's own claim about itself.
  const pngSize = (relPath) => {
    const buf = fs.readFileSync(path.join(__dirname, '..', 'public', relPath));
    expect(buf.subarray(1, 4).toString()).toBe('PNG');
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  };

  test('each icon file is actually the size the manifest advertises', async () => {
    const res = await request(app).get('/manifest.webmanifest');
    for (const icon of JSON.parse(res.text).icons) {
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(pngSize(icon.src)).toEqual({ width: w, height: h });
    }
  });

  test('apple-touch-icon is 180x180', () => {
    expect(pngSize('icons/apple-touch-icon.png')).toEqual({ width: 180, height: 180 });
  });

  test('the maskable icon is a distinct file, not an alias of the "any" icon', () => {
    const any = fs.readFileSync(path.join(__dirname, '..', 'public', 'icons', 'icon-512.png'));
    const maskable = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'icons', 'icon-512-maskable.png')
    );
    // Same dimensions, different bytes: the maskable carries its own safe-zone
    // padding. Aliasing one file for both purposes is the usual shortcut, and
    // Android's adaptive mask then crops the artwork.
    expect(maskable.equals(any)).toBe(false);
  });
});
