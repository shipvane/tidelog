'use strict';

/**
 * Tests for SVD-10: Agent notifications for port call events.
 *
 * Covers:
 *  - Webhook subscription CRUD (register / list / delete)
 *  - Event firing on: arrival_confirmed, berth_assigned, vessel_overdue, departure_logged
 *  - Delivery log (created on event dispatch, queryable)
 *  - Manual resend endpoint
 *  - Validation on subscription registration
 *  - lib/webhooks.js unit tests (attemptDelivery, deliverToSubscription, fireEvent)
 */

const request = require('supertest');

const app = require('../server');
const db = require('../routes/db');
const {
  fireEvent,
  deliverToSubscription,
  attemptDelivery,
  setTransport,
} = require('../lib/webhooks');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Register a subscription and return the response. */
async function registerSub(vesselName = 'MV Northern Star', url = 'http://agent.example/hook') {
  return request(app).post('/api/webhooks').send({ vesselName, url });
}

/**
 * Poll the delivery log until at least `minCount` entries match, or a deadline
 * passes. Returns the entries seen on the last read, so callers assert on
 * `.length` for a readable failure rather than a `TypeError` on an empty log.
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
  // Any real outbound request would never settle; if a test reaches the network
  // it times out. This is the CI condition the old fixed-sleep tests lost to.
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
  // Default: deliveries succeed in-memory, so no retry timer is armed and the
  // suite makes zero network calls. Failure-path tests override this locally.
  setTransport(async () => ({ ok: true, status: 200 }));
});

afterEach(() => {
  // No test in this suite may perform a real outbound request.
  expect(hangingFetch).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Subscription management
// ---------------------------------------------------------------------------

describe('POST /api/webhooks — register subscription', () => {
  test('creates a subscription and returns it', async () => {
    const res = await registerSub('Selkie', 'https://hooks.example.com/selkie');
    expect(res.status).toBe(201);
    expect(res.body.subscription).toMatchObject({
      id: 'WH-0001',
      vesselName: 'Selkie',
      url: 'https://hooks.example.com/selkie',
    });
    expect(res.body.subscription.createdAt).toBeDefined();
  });

  test('increments subscription ids', async () => {
    const a = await registerSub('Vessel A', 'http://a.example/hook');
    const b = await registerSub('Vessel B', 'http://b.example/hook');
    expect(a.body.subscription.id).toBe('WH-0001');
    expect(b.body.subscription.id).toBe('WH-0002');
  });

  test('rejects missing vesselName', async () => {
    const res = await request(app).post('/api/webhooks').send({ url: 'http://agent.example/hook' });
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(expect.arrayContaining(['vesselName is required']));
  });

  test('rejects missing url', async () => {
    const res = await request(app).post('/api/webhooks').send({ vesselName: 'Selkie' });
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(expect.arrayContaining(['url is required']));
  });

  test('rejects a non-http/https url', async () => {
    const res = await request(app)
      .post('/api/webhooks')
      .send({ vesselName: 'Selkie', url: 'ftp://bad.example/hook' });
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(expect.arrayContaining(['url must use http or https']));
  });

  test('rejects a malformed url', async () => {
    const res = await request(app)
      .post('/api/webhooks')
      .send({ vesselName: 'Selkie', url: 'not-a-url' });
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(expect.arrayContaining(['url must be a valid URL']));
  });

  test('allows multiple subscriptions for the same vessel', async () => {
    await registerSub('Selkie', 'http://agent1.example/hook');
    await registerSub('Selkie', 'http://agent2.example/hook');
    const list = await request(app).get('/api/webhooks?vesselName=Selkie');
    expect(list.body.subscriptions).toHaveLength(2);
  });
});

describe('GET /api/webhooks — list subscriptions', () => {
  test('returns all subscriptions when no filter given', async () => {
    await registerSub('Selkie', 'http://a.example/hook');
    await registerSub('Tarn Voyager', 'http://b.example/hook');
    const res = await request(app).get('/api/webhooks');
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(2);
  });

  test('filters by vesselName query param', async () => {
    await registerSub('Selkie', 'http://a.example/hook');
    await registerSub('Tarn Voyager', 'http://b.example/hook');
    const res = await request(app).get('/api/webhooks?vesselName=Selkie');
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(1);
    expect(res.body.subscriptions[0].vesselName).toBe('Selkie');
  });

  test('returns empty array when no subscriptions match', async () => {
    const res = await request(app).get('/api/webhooks?vesselName=Unknown');
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toEqual([]);
  });
});

describe('DELETE /api/webhooks/:id — remove subscription', () => {
  test('removes the subscription and returns it', async () => {
    const { body } = await registerSub();
    const subId = body.subscription.id;

    const res = await request(app).delete(`/api/webhooks/${subId}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted.id).toBe(subId);

    const list = await request(app).get('/api/webhooks');
    expect(list.body.subscriptions).toHaveLength(0);
  });

  test('404s on an unknown subscription id', async () => {
    const res = await request(app).delete('/api/webhooks/WH-9999');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('subscription not found');
  });
});

// ---------------------------------------------------------------------------
// Arrival flow — POST /:id/arrive fires arrival_confirmed
// ---------------------------------------------------------------------------

describe('POST /api/arrivals/:id/arrive — arrival_confirmed event', () => {
  test('fires arrival_confirmed and logs a delivery attempt', async () => {
    await registerSub('MV Northern Star', 'https://agent.example/hook');
    const { body: arrBody } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app).post(`/api/arrivals/${arrBody.arrival.id}/arrive`).send({});

    // Wait for the fire-and-forget delivery to land in the log.
    const deliveries = await waitForDeliveries(
      '?vesselName=MV%20Northern%20Star&eventType=arrival_confirmed',
      1
    );
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expect(deliveries[0].eventType).toBe('arrival_confirmed');
    expect(deliveries[0].vesselName).toBe('MV Northern Star');
  });

  test('does not log a delivery when no subscription exists for the vessel', async () => {
    const { body: arrBody } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app).post(`/api/arrivals/${arrBody.arrival.id}/arrive`).send({});

    // No matching subscription means fireEvent schedules nothing, so nothing can
    // ever appear; a fixed sleep would only slow the suite down.
    const logRes = await request(app).get('/api/webhooks/deliveries');
    expect(logRes.body.deliveries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Berth assignment — fires berth_assigned
// ---------------------------------------------------------------------------

describe('POST /api/arrivals/:id/assign-berth — berth_assigned event', () => {
  test('fires berth_assigned and logs a delivery attempt', async () => {
    await registerSub('MV Northern Star', 'https://agent.example/hook');
    const { body: arrBody } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app)
      .post(`/api/arrivals/${arrBody.arrival.id}/assign-berth`)
      .send({ from: '2026-03-01T14:00:00Z', to: '2026-03-01T22:00:00Z' });

    const deliveries = await waitForDeliveries('?eventType=berth_assigned', 1);
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    const entry = deliveries[0];
    expect(entry.eventType).toBe('berth_assigned');
    expect(entry.vesselName).toBe('MV Northern Star');
  });
});

// ---------------------------------------------------------------------------
// New route: POST /api/arrivals/:id/overdue — fires vessel_overdue
// ---------------------------------------------------------------------------

describe('POST /api/arrivals/:id/overdue — vessel overdue', () => {
  test('marks vessel overdue and returns updated arrival', async () => {
    const { body: arrBody } = await request(app).post('/api/arrivals').send(validManifest());
    const res = await request(app).post(`/api/arrivals/${arrBody.arrival.id}/overdue`).send();
    expect(res.status).toBe(200);
    expect(res.body.arrival.status).toBe('overdue');
  });

  test('fires vessel_overdue webhook event', async () => {
    await registerSub('MV Northern Star', 'https://agent.example/hook');
    const { body: arrBody } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app).post(`/api/arrivals/${arrBody.arrival.id}/overdue`).send();

    const deliveries = await waitForDeliveries('?eventType=vessel_overdue', 1);
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expect(deliveries[0].eventType).toBe('vessel_overdue');
  });

  test('409 if vessel is not expected', async () => {
    const { body: arrBody } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app).post(`/api/arrivals/${arrBody.arrival.id}/arrive`).send({});
    const res = await request(app).post(`/api/arrivals/${arrBody.arrival.id}/overdue`).send();
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('expected');
  });

  test('404 for unknown arrival', async () => {
    const res = await request(app).post('/api/arrivals/ARR-999/overdue').send();
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// New route: POST /api/arrivals/:id/depart — fires departure_logged
// ---------------------------------------------------------------------------

describe('POST /api/arrivals/:id/depart — departure logged', () => {
  test('marks vessel departed with a timestamp', async () => {
    const { body: arrBody } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app).post(`/api/arrivals/${arrBody.arrival.id}/arrive`).send({});

    const res = await request(app)
      .post(`/api/arrivals/${arrBody.arrival.id}/depart`)
      .send({ time: '2026-03-01T20:00:00Z' });
    expect(res.status).toBe(200);
    expect(res.body.arrival.status).toBe('departed');
    expect(res.body.arrival.departedAt).toBe('2026-03-01T20:00:00.000Z');
    expect(res.body.arrival.berth).toBeNull();
  });

  test('defaults departedAt to now when no time provided', async () => {
    const { body: arrBody } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app).post(`/api/arrivals/${arrBody.arrival.id}/arrive`).send({});
    const res = await request(app).post(`/api/arrivals/${arrBody.arrival.id}/depart`).send({});
    expect(res.status).toBe(200);
    expect(res.body.arrival.departedAt).toBeDefined();
  });

  test('releases the berth assignment on departure', async () => {
    const { body: arrBody } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app).post(`/api/arrivals/${arrBody.arrival.id}/arrive`).send({});
    await request(app)
      .post(`/api/arrivals/${arrBody.arrival.id}/assign-berth`)
      .send({ from: '2026-03-01T14:00:00Z', to: '2026-03-01T22:00:00Z' });

    await request(app).post(`/api/arrivals/${arrBody.arrival.id}/depart`).send({});

    const res = await request(app).get(`/api/arrivals/${arrBody.arrival.id}`);
    expect(res.body.arrival.berth).toBeNull();
  });

  test('fires departure_logged webhook event', async () => {
    await registerSub('MV Northern Star', 'https://agent.example/hook');
    const { body: arrBody } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app).post(`/api/arrivals/${arrBody.arrival.id}/arrive`).send({});
    await request(app).post(`/api/arrivals/${arrBody.arrival.id}/depart`).send({});

    const deliveries = await waitForDeliveries('?eventType=departure_logged', 1);
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expect(deliveries[0].eventType).toBe('departure_logged');
  });

  test('409 if vessel is still expected', async () => {
    const { body: arrBody } = await request(app).post('/api/arrivals').send(validManifest());
    const res = await request(app).post(`/api/arrivals/${arrBody.arrival.id}/depart`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('arrived');
  });

  test('allows departure from overdue status', async () => {
    const { body: arrBody } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app).post(`/api/arrivals/${arrBody.arrival.id}/overdue`).send();
    const res = await request(app).post(`/api/arrivals/${arrBody.arrival.id}/depart`).send({});
    expect(res.status).toBe(200);
    expect(res.body.arrival.status).toBe('departed');
  });

  test('rejects an invalid departure time', async () => {
    const { body: arrBody } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app).post(`/api/arrivals/${arrBody.arrival.id}/arrive`).send({});
    const res = await request(app)
      .post(`/api/arrivals/${arrBody.arrival.id}/depart`)
      .send({ time: 'not-a-date' });
    expect(res.status).toBe(400);
  });

  test('404 for unknown arrival', async () => {
    const res = await request(app).post('/api/arrivals/ARR-999/depart').send({});
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Delivery log API
// ---------------------------------------------------------------------------

describe('GET /api/webhooks/deliveries', () => {
  test('returns an empty array when nothing has been fired', async () => {
    const res = await request(app).get('/api/webhooks/deliveries');
    expect(res.status).toBe(200);
    expect(res.body.deliveries).toEqual([]);
  });

  test('entries appear newest first', async () => {
    // Directly push two fake entries into the log to test ordering without
    // waiting for real async deliveries.
    db.state.deliveryLog.push({
      id: 'DLV-FIRST',
      subscriptionId: 'WH-0001',
      vesselName: 'Selkie',
      url: 'http://x.example',
      eventType: 'arrival_confirmed',
      attemptedAt: '2026-03-01T10:00:00Z',
      ok: true,
      httpStatus: 200,
      error: null,
      retried: false,
    });
    db.state.deliveryLog.push({
      id: 'DLV-SECOND',
      subscriptionId: 'WH-0001',
      vesselName: 'Selkie',
      url: 'http://x.example',
      eventType: 'berth_assigned',
      attemptedAt: '2026-03-01T11:00:00Z',
      ok: true,
      httpStatus: 200,
      error: null,
      retried: false,
    });

    const res = await request(app).get('/api/webhooks/deliveries');
    expect(res.body.deliveries[0].id).toBe('DLV-SECOND');
    expect(res.body.deliveries[1].id).toBe('DLV-FIRST');
  });

  test('filters by eventType', async () => {
    db.state.deliveryLog.push({
      id: 'DLV-A',
      subscriptionId: 'WH-0001',
      vesselName: 'Selkie',
      url: 'http://x.example',
      eventType: 'arrival_confirmed',
      attemptedAt: '2026-03-01T10:00:00Z',
      ok: true,
      httpStatus: 200,
      error: null,
      retried: false,
    });
    db.state.deliveryLog.push({
      id: 'DLV-B',
      subscriptionId: 'WH-0001',
      vesselName: 'Selkie',
      url: 'http://x.example',
      eventType: 'berth_assigned',
      attemptedAt: '2026-03-01T11:00:00Z',
      ok: true,
      httpStatus: 200,
      error: null,
      retried: false,
    });

    const res = await request(app).get('/api/webhooks/deliveries?eventType=arrival_confirmed');
    expect(res.body.deliveries).toHaveLength(1);
    expect(res.body.deliveries[0].id).toBe('DLV-A');
  });

  test('filters by vesselName', async () => {
    db.state.deliveryLog.push({
      id: 'DLV-S',
      subscriptionId: 'WH-0001',
      vesselName: 'Selkie',
      url: 'http://x.example',
      eventType: 'arrival_confirmed',
      attemptedAt: '2026-03-01T10:00:00Z',
      ok: true,
      httpStatus: 200,
      error: null,
      retried: false,
    });
    db.state.deliveryLog.push({
      id: 'DLV-T',
      subscriptionId: 'WH-0002',
      vesselName: 'Tarn Voyager',
      url: 'http://y.example',
      eventType: 'arrival_confirmed',
      attemptedAt: '2026-03-01T10:05:00Z',
      ok: true,
      httpStatus: 200,
      error: null,
      retried: false,
    });

    const res = await request(app).get('/api/webhooks/deliveries?vesselName=Selkie');
    expect(res.body.deliveries).toHaveLength(1);
    expect(res.body.deliveries[0].id).toBe('DLV-S');
  });

  test('respects the limit query param', async () => {
    for (let i = 0; i < 10; i++) {
      db.state.deliveryLog.push({
        id: `DLV-${i}`,
        subscriptionId: 'WH-0001',
        vesselName: 'Selkie',
        url: 'http://x.example',
        eventType: 'arrival_confirmed',
        attemptedAt: new Date().toISOString(),
        ok: true,
        httpStatus: 200,
        error: null,
        retried: false,
      });
    }
    const res = await request(app).get('/api/webhooks/deliveries?limit=3');
    expect(res.body.deliveries).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Manual resend
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/deliveries/:id/resend', () => {
  test('202s and accepts the resend for a known delivery id', async () => {
    db.state.deliveryLog.push({
      id: 'DLV-ORIG',
      subscriptionId: 'WH-0001',
      vesselName: 'Selkie',
      url: 'http://127.0.0.1:1/no-server',
      eventType: 'arrival_confirmed',
      attemptedAt: '2026-03-01T10:00:00Z',
      ok: false,
      httpStatus: null,
      error: 'ECONNREFUSED',
      retried: false,
    });

    const res = await request(app).post('/api/webhooks/deliveries/DLV-ORIG/resend');
    expect(res.status).toBe(202);
    expect(res.body.message).toContain('resend accepted');
    expect(res.body.deliveryId).toBe('DLV-ORIG');
  });

  test('404s for an unknown delivery id', async () => {
    const res = await request(app).post('/api/webhooks/deliveries/DLV-NOPE/resend');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('delivery not found');
  });

  test('resend attempt appears in the delivery log', async () => {
    db.state.deliveryLog.push({
      id: 'DLV-ORIG2',
      subscriptionId: 'WH-0001',
      vesselName: 'Selkie',
      url: 'http://127.0.0.1:1/no-server',
      eventType: 'berth_assigned',
      attemptedAt: '2026-03-01T10:00:00Z',
      ok: false,
      httpStatus: null,
      error: 'ECONNREFUSED',
      retried: false,
    });

    await request(app).post('/api/webhooks/deliveries/DLV-ORIG2/resend');

    // Original + at least one resend attempt.
    const deliveries = await waitForDeliveries('', 2);
    expect(deliveries.length).toBeGreaterThanOrEqual(2);
    const resendEntry = deliveries.find((e) => e.eventType === 'berth_assigned');
    expect(resendEntry).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// lib/webhooks.js unit tests
// ---------------------------------------------------------------------------

describe('attemptDelivery', () => {
  test('returns ok:false and an error string when the transport rejects', async () => {
    // A rejected transport stands in for an unreachable host, deterministically
    // and without a real socket. attemptDelivery must translate it into a logged
    // failure, not throw.
    setTransport(async () => {
      throw new Error('ECONNREFUSED (stubbed transport)');
    });
    const result = await attemptDelivery('https://agent.example/hook', { test: true });
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });
});

describe('deliverToSubscription', () => {
  test('pushes a log entry on failure, then retries once after RETRY_DELAY_MS', async () => {
    // Fake timers let us cross the real 5s RETRY_DELAY_MS instantly, so the retry
    // semantics are exercised without a slow test or a leaked pending timer.
    jest.useFakeTimers();
    try {
      setTransport(async () => {
        throw new Error('ECONNREFUSED (stubbed transport)');
      });
      const sub = { id: 'WH-0001', vesselName: 'Selkie', url: 'https://agent.example/hook' };
      const event = {
        eventType: 'arrival_confirmed',
        vesselName: 'Selkie',
        firedAt: new Date().toISOString(),
      };

      const earlyLog = [];
      const deliveryPromise = deliverToSubscription(sub, event, earlyLog);

      // Flush the first (failed) attempt's microtasks.
      await jest.advanceTimersByTimeAsync(0);
      expect(earlyLog.length).toBe(1);
      expect(earlyLog[0].subscriptionId).toBe('WH-0001');
      expect(earlyLog[0].eventType).toBe('arrival_confirmed');
      expect(earlyLog[0].ok).toBe(false);
      expect(earlyLog[0].retried).toBe(false);

      // Cross the retry delay and let the retry attempt settle.
      await jest.advanceTimersByTimeAsync(5_000);
      await deliveryPromise;
      expect(earlyLog.length).toBe(2);
      expect(earlyLog[1].retried).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('fireEvent', () => {
  test('does nothing when no subscriptions match the vessel', () => {
    const eventLog = [];
    const subs = [{ id: 'WH-0001', vesselName: 'Other Vessel', url: 'http://x.example/hook' }];
    expect(() =>
      fireEvent(subs, eventLog, 'MV Northern Star', 'arrival_confirmed', {})
    ).not.toThrow();
  });

  test('only delivers to matching vessel subscriptions', async () => {
    const eventLog = [];
    const subs = [
      { id: 'WH-0001', vesselName: 'Selkie', url: 'https://agent-1.example/hook' },
      { id: 'WH-0002', vesselName: 'Tarn Voyager', url: 'https://agent-2.example/hook' },
    ];
    fireEvent(subs, eventLog, 'Selkie', 'arrival_confirmed', {});

    // Poll the local log until Selkie's delivery lands, or a deadline passes.
    const deadline = Date.now() + 2000;
    while (eventLog.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Only Selkie's subscription should have been attempted.
    const selkieEntries = eventLog.filter((e) => e.subscriptionId === 'WH-0001');
    const tarnEntries = eventLog.filter((e) => e.subscriptionId === 'WH-0002');
    expect(selkieEntries.length).toBeGreaterThanOrEqual(1);
    expect(tarnEntries).toHaveLength(0);
  });
});
