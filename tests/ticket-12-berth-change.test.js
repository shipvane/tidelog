'use strict';

/**
 * Tests for ticket 12 behavior: verify that berth changes (reassignments)
 * trigger berth_assigned notifications to agents.
 *
 * Delivery is async and fire-and-forget: the route responds before the POST
 * settles, and the POST is a real outbound `fetch` to a `.example` host that
 * cannot resolve. The old version slept a fixed 100ms and then indexed the
 * delivery log unguarded, giving a 10s request budget 100ms and throwing
 * `TypeError: Cannot read properties of undefined` when it lost the race.
 *
 * The fix: stub the transport (`setTransport`) so the suite makes no network
 * call at all, and poll the delivery log against a deadline instead of
 * sleeping. To prove the suite is immune to the CI failure, the global `fetch`
 * is replaced with one that never settles — the exact "outbound request hangs"
 * condition — and `afterEach` asserts it was never called.
 */

const request = require('supertest');
const app = require('../server');
const db = require('../routes/db');
const { setTransport } = require('../lib/webhooks');

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

/**
 * Poll the delivery log until at least `minCount` entries match, or a deadline
 * passes. Returns the entries seen on the last read (never throws on empty), so
 * callers assert on `.length` for a readable failure instead of a `TypeError`.
 */
async function waitForDeliveries(query = '', minCount = 1, deadlineMs = 2000) {
  const deadline = Date.now() + deadlineMs;
  let deliveries = [];
  for (;;) {
    const res = await request(app).get(`/api/webhooks/deliveries${query}`);
    deliveries = res.body.deliveries;
    if (deliveries.length >= minCount || Date.now() >= deadline) {
      return deliveries;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

let realFetch;
let hangingFetch;

beforeAll(() => {
  realFetch = global.fetch;
  // Reproduce the CI condition exactly: a real outbound request that never
  // settles. If any code path reaches the network, the awaiting test times out.
  hangingFetch = jest.fn(() => new Promise(() => {}));
  global.fetch = hangingFetch;
});

afterAll(() => {
  global.fetch = realFetch;
  setTransport(); // restore the default global-fetch transport
});

beforeEach(() => {
  db.reset();
  hangingFetch.mockClear();
  // Deliver through an in-memory transport so the suite makes zero network calls
  // and no 5s retry timer is ever armed.
  setTransport(async () => ({ ok: true, status: 200 }));
});

afterEach(() => {
  // No test in this suite may perform a real outbound request.
  expect(hangingFetch).not.toHaveBeenCalled();
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

    // Wait for async delivery to land in the log
    const deliveries = await waitForDeliveries(
      '?vesselName=MV%20Northern%20Star&eventType=berth_assigned',
      1
    );
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
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

    await waitForDeliveries('?vesselName=MV%20Northern%20Star&eventType=berth_assigned', 1);

    // Reassign to a different berth (different time window to force different berth)
    const secondAssignRes = await request(app)
      .post(`/api/arrivals/${arrivalId}/assign-berth`)
      .send({
        from: '2026-03-01T10:00:00Z',
        to: '2026-03-01T18:00:00Z',
      });

    expect(secondAssignRes.status).toBe(200);

    // Check that berth_assigned events were fired
    // Should have at least 2 attempts (initial + reassignment, plus potential retries)
    const deliveries = await waitForDeliveries(
      '?vesselName=MV%20Northern%20Star&eventType=berth_assigned',
      2
    );
    expect(deliveries.length).toBeGreaterThanOrEqual(2);
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

    const deliveries = await waitForDeliveries('', 1);
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    const entry = deliveries[0];

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

    const deliveries = await waitForDeliveries('', 1);
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    const entry = deliveries[0];

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
