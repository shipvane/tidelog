'use strict';

/**
 * Tests for ticket 12 behavior: verify that berth changes (reassignments)
 * trigger berth_assigned notifications to agents.
 */

const request = require('supertest');
const app = require('../server');
const db = require('../routes/db');
const { waitForDeliveries } = require('./support/webhook-transport');

function validManifest(overrides = {}) {
  return {
    vesselName: 'MV Northern Star',
    vesselType: 'cargo',
    lengthM: 85,
    draftM: 6.2,
    imo: 'IMO 9074729',
    eta: '2026-03-01T14:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  db.reset();
});

describe('Ticket 12: Berth change detection and notification', () => {
  test('initial berth assignment fires berth_assigned event', async () => {
    // Register subscription
    await request(app).post('/api/webhooks').send({
      vesselName: 'MV Northern Star',
      url: 'https://agent.example.com/webhook',
    });

    // Create arrival
    const arrRes = await request(app).post('/api/arrivals').send(validManifest());
    const arrivalId = arrRes.body.arrival.id;

    // Assign berth
    await request(app).post(`/api/arrivals/${arrivalId}/assign-berth`).send({
      from: '2026-03-01T14:00:00Z',
      to: '2026-03-01T22:00:00Z',
    });

    // Poll for the async delivery rather than sleeping a fixed 100 ms.
    const body = await waitForDeliveries(request, app, {
      query: '?vesselName=MV%20Northern%20Star&eventType=berth_assigned',
    });
    expect(body.deliveries.length).toBeGreaterThanOrEqual(1);
  });

  test('berth reassignment fires another berth_assigned event', async () => {
    // Register subscription
    await request(app).post('/api/webhooks').send({
      vesselName: 'MV Northern Star',
      url: 'https://agent.example.com/webhook',
    });

    // Create arrival and mark as arrived
    const arrRes = await request(app).post('/api/arrivals').send(validManifest());
    const arrivalId = arrRes.body.arrival.id;
    await request(app).post(`/api/arrivals/${arrivalId}/arrive`).send({});

    // Assign initial berth
    const firstAssignRes = await request(app).post(`/api/arrivals/${arrivalId}/assign-berth`).send({
      from: '2026-03-01T14:00:00Z',
      to: '2026-03-01T22:00:00Z',
    });

    expect(firstAssignRes.status).toBe(200);

    await waitForDeliveries(request, app, {
      query: '?vesselName=MV%20Northern%20Star&eventType=berth_assigned',
    });

    // Reassign to a different berth (different time window to force different berth)
    const secondAssignRes = await request(app)
      .post(`/api/arrivals/${arrivalId}/assign-berth`)
      .send({
        from: '2026-03-01T10:00:00Z',
        to: '2026-03-01T18:00:00Z',
      });

    expect(secondAssignRes.status).toBe(200);

    // Should have at least 2 attempts (initial + reassignment, plus potential retries)
    const body = await waitForDeliveries(request, app, {
      query: '?vesselName=MV%20Northern%20Star&eventType=berth_assigned',
      min: 2,
    });
    expect(body.deliveries.length).toBeGreaterThanOrEqual(2);
  });

  test('berth change includes the vessel name (for agent identification)', async () => {
    // Create a subscription
    await request(app).post('/api/webhooks').send({
      vesselName: 'MV Northern Star',
      url: 'https://agent.example.com/webhook',
    });

    // Create arrival and assign berth
    const arrRes = await request(app).post('/api/arrivals').send(validManifest());
    const arrivalId = arrRes.body.arrival.id;

    await request(app).post(`/api/arrivals/${arrivalId}/assign-berth`).send({
      from: '2026-03-01T14:00:00Z',
      to: '2026-03-01T22:00:00Z',
    });

    const body = await waitForDeliveries(request, app);
    const entry = body.deliveries[0];

    expect(entry.vesselName).toBe('MV Northern Star');
  });

  test('subscription captures the webhook endpoint where agent is notified', async () => {
    const url = 'https://meridian-shipping.example/api/notifications/berth-changes';
    const subRes = await request(app).post('/api/webhooks').send({
      vesselName: 'MV Northern Star',
      url,
    });

    expect(subRes.body.subscription.url).toBe(url);

    // Now create an arrival and assign a berth
    const arrRes = await request(app).post('/api/arrivals').send(validManifest());
    const arrivalId = arrRes.body.arrival.id;

    await request(app).post(`/api/arrivals/${arrivalId}/assign-berth`).send({
      from: '2026-03-01T14:00:00Z',
      to: '2026-03-01T22:00:00Z',
    });

    const body = await waitForDeliveries(request, app);
    const entry = body.deliveries[0];

    expect(entry.url).toBe(url);
  });

  test('agent subscription system is in place for real-time notifications', async () => {
    // Verify that subscriptions can be created and queried
    const sub1 = await request(app).post('/api/webhooks').send({
      vesselName: 'Tarn Voyager',
      url: 'https://shipping-agent-1.example/webhooks',
    });
    expect(sub1.status).toBe(201);
    expect(sub1.body.subscription.id).toBeDefined();

    // Multiple agents can subscribe to the same vessel
    const sub2 = await request(app).post('/api/webhooks').send({
      vesselName: 'Tarn Voyager',
      url: 'https://shipping-agent-2.example/webhooks',
    });
    expect(sub2.status).toBe(201);

    // List subscriptions for the vessel
    const listRes = await request(app).get('/api/webhooks?vesselName=Tarn%20Voyager');
    expect(listRes.body.subscriptions.length).toBe(2);
  });
});
