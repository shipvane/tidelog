'use strict';

/**
 * Tests for turnaround time tracking and statistics.
 *
 * Covers:
 *  - turnaroundHours field on arrivals
 *  - GET /api/stats/turnaround endpoint
 *  - Average turnaround calculation for departed vessels
 */

const request = require('supertest');

const app = require('../server');
const db = require('../routes/db');

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

describe('turnaroundHours field on arrivals', () => {
  test('returns null when vessel has not arrived', async () => {
    const { body } = await request(app).post('/api/arrivals').send(validManifest());
    const res = await request(app).get(`/api/arrivals/${body.arrival.id}`);
    expect(res.body.arrival.turnaroundHours).toBeNull();
  });

  test('returns null when vessel has arrived but not departed', async () => {
    const { body } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app)
      .post(`/api/arrivals/${body.arrival.id}/arrive`)
      .send({ time: '2026-03-01T15:00:00Z' });

    const res = await request(app).get(`/api/arrivals/${body.arrival.id}`);
    expect(res.body.arrival.turnaroundHours).toBeNull();
  });

  test('calculates turnaroundHours when vessel has both arrived and departed', async () => {
    const { body } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app)
      .post(`/api/arrivals/${body.arrival.id}/arrive`)
      .send({ time: '2026-03-01T15:00:00Z' });
    await request(app)
      .post(`/api/arrivals/${body.arrival.id}/depart`)
      .send({ time: '2026-03-01T23:00:00Z' });

    const res = await request(app).get(`/api/arrivals/${body.arrival.id}`);
    expect(res.body.arrival.turnaroundHours).toBe(8);
  });

  test('handles fractional hours correctly', async () => {
    const { body } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app)
      .post(`/api/arrivals/${body.arrival.id}/arrive`)
      .send({ time: '2026-03-01T14:30:00Z' });
    await request(app)
      .post(`/api/arrivals/${body.arrival.id}/depart`)
      .send({ time: '2026-03-01T17:00:00Z' });

    const res = await request(app).get(`/api/arrivals/${body.arrival.id}`);
    expect(res.body.arrival.turnaroundHours).toBe(2.5);
  });

  test('includes turnaroundHours in list endpoint', async () => {
    const { body: arr1 } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app)
      .post(`/api/arrivals/${arr1.arrival.id}/arrive`)
      .send({ time: '2026-03-01T15:00:00Z' });
    await request(app)
      .post(`/api/arrivals/${arr1.arrival.id}/depart`)
      .send({ time: '2026-03-01T19:00:00Z' });

    const res = await request(app).get('/api/arrivals');
    expect(res.body.arrivals).toHaveLength(1);
    expect(res.body.arrivals[0].turnaroundHours).toBe(4);
  });

  test('includes turnaroundHours when filtering by status', async () => {
    const { body } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app)
      .post(`/api/arrivals/${body.arrival.id}/arrive`)
      .send({ time: '2026-03-01T15:00:00Z' });
    await request(app)
      .post(`/api/arrivals/${body.arrival.id}/depart`)
      .send({ time: '2026-03-01T18:30:00Z' });

    const res = await request(app).get('/api/arrivals?status=departed');
    expect(res.body.arrivals).toHaveLength(1);
    expect(res.body.arrivals[0].turnaroundHours).toBe(3.5);
  });
});

describe('GET /api/stats/turnaround', () => {
  test('returns null average and zero count when no departed vessels', async () => {
    const res = await request(app).get('/api/stats/turnaround');
    expect(res.status).toBe(200);
    expect(res.body.averageTurnaroundHours).toBeNull();
    expect(res.body.count).toBe(0);
  });

  test('returns correct average for a single departed vessel', async () => {
    const { body } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app)
      .post(`/api/arrivals/${body.arrival.id}/arrive`)
      .send({ time: '2026-03-01T14:00:00Z' });
    await request(app)
      .post(`/api/arrivals/${body.arrival.id}/depart`)
      .send({ time: '2026-03-01T18:00:00Z' });

    const res = await request(app).get('/api/stats/turnaround');
    expect(res.status).toBe(200);
    expect(res.body.averageTurnaroundHours).toBe(4);
    expect(res.body.count).toBe(1);
  });

  test('calculates average for multiple departed vessels', async () => {
    // First vessel: 4 hours
    const { body: arr1 } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app)
      .post(`/api/arrivals/${arr1.arrival.id}/arrive`)
      .send({ time: '2026-03-01T14:00:00Z' });
    await request(app)
      .post(`/api/arrivals/${arr1.arrival.id}/depart`)
      .send({ time: '2026-03-01T18:00:00Z' });

    // Second vessel: 6 hours
    const { body: arr2 } = await request(app)
      .post('/api/arrivals')
      .send(validManifest({ vesselName: 'Selkie', vesselType: 'fishing', imo: undefined }));
    await request(app)
      .post(`/api/arrivals/${arr2.arrival.id}/arrive`)
      .send({ time: '2026-03-01T14:00:00Z' });
    await request(app)
      .post(`/api/arrivals/${arr2.arrival.id}/depart`)
      .send({ time: '2026-03-01T20:00:00Z' });

    const res = await request(app).get('/api/stats/turnaround');
    expect(res.status).toBe(200);
    expect(res.body.averageTurnaroundHours).toBe(5); // (4 + 6) / 2
    expect(res.body.count).toBe(2);
  });

  test('only counts departed vessels in the average', async () => {
    // Departed: 4 hours
    const { body: arr1 } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app)
      .post(`/api/arrivals/${arr1.arrival.id}/arrive`)
      .send({ time: '2026-03-01T14:00:00Z' });
    await request(app)
      .post(`/api/arrivals/${arr1.arrival.id}/depart`)
      .send({ time: '2026-03-01T18:00:00Z' });

    // Arrived but not departed
    const { body: arr2 } = await request(app)
      .post('/api/arrivals')
      .send(validManifest({ vesselName: 'Tarn Voyager', imo: undefined }));
    await request(app)
      .post(`/api/arrivals/${arr2.arrival.id}/arrive`)
      .send({ time: '2026-03-01T14:00:00Z' });

    // Expected (never arrived)
    await request(app)
      .post('/api/arrivals')
      .send(
        validManifest({
          vesselName: 'Coble Runner',
          vesselType: 'tug',
          imo: undefined,
          eta: '2026-03-02T10:00:00Z',
        })
      );

    const res = await request(app).get('/api/stats/turnaround');
    expect(res.status).toBe(200);
    expect(res.body.averageTurnaroundHours).toBe(4);
    expect(res.body.count).toBe(1);
  });

  test('handles fractional hours in average calculation', async () => {
    // First vessel: 2.5 hours
    const { body: arr1 } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app)
      .post(`/api/arrivals/${arr1.arrival.id}/arrive`)
      .send({ time: '2026-03-01T14:00:00Z' });
    await request(app)
      .post(`/api/arrivals/${arr1.arrival.id}/depart`)
      .send({ time: '2026-03-01T16:30:00Z' });

    // Second vessel: 3.5 hours
    const { body: arr2 } = await request(app)
      .post('/api/arrivals')
      .send(validManifest({ vesselName: 'Selkie', vesselType: 'fishing', imo: undefined }));
    await request(app)
      .post(`/api/arrivals/${arr2.arrival.id}/arrive`)
      .send({ time: '2026-03-01T14:00:00Z' });
    await request(app)
      .post(`/api/arrivals/${arr2.arrival.id}/depart`)
      .send({ time: '2026-03-01T17:30:00Z' });

    const res = await request(app).get('/api/stats/turnaround');
    expect(res.status).toBe(200);
    expect(res.body.averageTurnaroundHours).toBe(3); // (2.5 + 3.5) / 2
    expect(res.body.count).toBe(2);
  });

  test('handles overdue vessels that depart', async () => {
    // Expected vessel (past threshold) -> marked overdue -> departs
    const pastEta = new Date(Date.now() - 3 * 3600_000).toISOString();
    const { body: arr1 } = await request(app)
      .post('/api/arrivals')
      .send(validManifest({ eta: pastEta }));
    await request(app).post(`/api/arrivals/${arr1.arrival.id}/overdue`).send();
    await request(app)
      .post(`/api/arrivals/${arr1.arrival.id}/depart`)
      .send({ time: '2026-03-01T20:00:00Z' });

    // In this case, there's no arrivedAt, so turnaround is not calculated
    const res = await request(app).get('/api/stats/turnaround');
    expect(res.status).toBe(200);
    expect(res.body.averageTurnaroundHours).toBeNull();
    expect(res.body.count).toBe(0);
  });
});
