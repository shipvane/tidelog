'use strict';

/**
 * Tests for ticket 12: Agents keep getting surprised by berth changes.
 * This test verifies that the demo data includes a seeded notification
 * that demonstrates the berth change notification feature.
 */

const request = require('supertest');
const { boundServer } = require('./support/server');
const app = boundServer(require('../server'));
const db = require('../routes/db');

beforeEach(() => {
  db.reset();
  db.seedDemoData();
});

describe('Ticket 12: Berth change notifications in demo data', () => {
  test('seeded demo data includes a berth assignment notification', async () => {
    const res = await request(app).get('/api/webhooks/deliveries');
    expect(res.status).toBe(200);
    expect(res.body.deliveries).toBeDefined();
    expect(res.body.deliveries.length).toBeGreaterThanOrEqual(1);
  });

  test('seeded notification has all required fields for display', async () => {
    const res = await request(app).get('/api/webhooks/deliveries');
    const notification = res.body.deliveries[0];

    expect(notification.id).toBeDefined();
    expect(notification.vesselName).toBeDefined();
    expect(notification.url).toBeDefined();
    expect(notification.eventType).toBe('berth_assigned');
    expect(notification.attemptedAt).toBeDefined();
    expect(notification.ok).toBe(true);
    expect(notification.httpStatus).toBe(200);
    expect(notification.retried).toBeDefined();
  });

  test('seeded notification is for a real vessel from demo data', async () => {
    const res = await request(app).get('/api/webhooks/deliveries');
    const notification = res.body.deliveries[0];

    // Verify it's for one of the seeded vessels
    expect(notification.vesselName).toBe('Tarn Voyager');

    // Verify the vessel exists in arrivals
    const arrivalsRes = await request(app).get('/api/arrivals');
    const vessels = arrivalsRes.body.arrivals.map((a) => a.vesselName);
    expect(vessels).toContain(notification.vesselName);
  });

  test('seeded subscription exists for the vessel', async () => {
    const res = await request(app).get('/api/webhooks?vesselName=Tarn%20Voyager');
    expect(res.status).toBe(200);
    expect(res.body.subscriptions.length).toBeGreaterThanOrEqual(1);
    expect(res.body.subscriptions[0].vesselName).toBe('Tarn Voyager');
  });

  test('notification URL is plausible (not placeholder)', async () => {
    const res = await request(app).get('/api/webhooks/deliveries');
    const notification = res.body.deliveries[0];

    // URL should look like a real webhook endpoint
    expect(notification.url).toMatch(/https?:\/\/.+/);
    expect(notification.url).not.toMatch(/placeholder|example\.com|test|mock/i);
    expect(notification.url).toMatch(/meridian|agent/i);
  });
});
