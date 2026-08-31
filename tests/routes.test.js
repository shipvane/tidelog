'use strict';

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

describe('GET /api/health', () => {
  test('reports the service is up', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'tidelog' });
  });
});

describe('/api/arrivals', () => {
  test('POST logs a valid manifest and returns the normalized arrival', async () => {
    const res = await request(app).post('/api/arrivals').send(validManifest());
    expect(res.status).toBe(201);
    expect(res.body.arrival).toMatchObject({
      id: 'ARR-001',
      vesselName: 'MV Northern Star',
      vesselType: 'cargo',
      status: 'expected',
      imo: 'IMO 9074729',
      berth: null,
    });
    expect(res.body.arrival.loggedAt).toBeDefined();
  });

  test('POST rejects an invalid manifest with the full error list', async () => {
    const res = await request(app)
      .post('/api/arrivals')
      .send({ vesselName: '', vesselType: 'submarine', lengthM: -1 });
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        'vesselName is required',
        expect.stringContaining('vesselType must be one of'),
        'lengthM must be a positive number',
        'draftM must be a positive number',
        'eta must be a valid date/time',
      ])
    );
  });

  test('GET lists logged arrivals', async () => {
    await request(app).post('/api/arrivals').send(validManifest());
    await request(app)
      .post('/api/arrivals')
      .send(validManifest({ vesselName: 'Selkie', vesselType: 'fishing', imo: undefined }));

    const res = await request(app).get('/api/arrivals');
    expect(res.status).toBe(200);
    expect(res.body.arrivals).toHaveLength(2);
    expect(res.body.arrivals.map((a) => a.vesselName)).toEqual(['MV Northern Star', 'Selkie']);
  });

  test('GET ?status= filters by arrival status', async () => {
    const { body } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app)
      .post('/api/arrivals')
      .send(validManifest({ vesselName: 'Selkie', imo: undefined }));
    await request(app).post(`/api/arrivals/${body.arrival.id}/arrive`).send({});

    const arrived = await request(app).get('/api/arrivals?status=arrived');
    expect(arrived.body.arrivals).toHaveLength(1);
    expect(arrived.body.arrivals[0].vesselName).toBe('MV Northern Star');

    const expected = await request(app).get('/api/arrivals?status=expected');
    expect(expected.body.arrivals).toHaveLength(1);
  });

  test('GET ?type= filters by vessel type', async () => {
    await request(app)
      .post('/api/arrivals')
      .send(validManifest({ vesselType: 'cargo' }));
    await request(app)
      .post('/api/arrivals')
      .send(validManifest({ vesselName: 'Selkie', vesselType: 'fishing', imo: undefined }));
    await request(app)
      .post('/api/arrivals')
      .send(validManifest({ vesselName: 'Tarn Voyager', vesselType: 'tanker', imo: undefined }));

    const tankers = await request(app).get('/api/arrivals?type=tanker');
    expect(tankers.status).toBe(200);
    expect(tankers.body.arrivals).toHaveLength(1);
    expect(tankers.body.arrivals[0].vesselName).toBe('Tarn Voyager');
    expect(tankers.body.arrivals[0].vesselType).toBe('tanker');

    const fishing = await request(app).get('/api/arrivals?type=fishing');
    expect(fishing.status).toBe(200);
    expect(fishing.body.arrivals).toHaveLength(1);
    expect(fishing.body.arrivals[0].vesselName).toBe('Selkie');
  });

  test('GET ?type= is case-insensitive', async () => {
    await request(app)
      .post('/api/arrivals')
      .send(validManifest({ vesselName: 'Selkie', vesselType: 'fishing', imo: undefined }));

    const lower = await request(app).get('/api/arrivals?type=fishing');
    const upper = await request(app).get('/api/arrivals?type=FISHING');
    const mixed = await request(app).get('/api/arrivals?type=FiShInG');

    expect(lower.body.arrivals).toHaveLength(1);
    expect(upper.body.arrivals).toHaveLength(1);
    expect(mixed.body.arrivals).toHaveLength(1);
  });

  test('GET ?type= returns 400 for invalid vessel type', async () => {
    const res = await request(app).get('/api/arrivals?type=submarine');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('type must be one of');
    expect(res.body.error).toContain('cargo');
    expect(res.body.error).toContain('tanker');
  });

  test('GET ?type= and ?status= can be combined', async () => {
    const { body: cargo1 } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app)
      .post('/api/arrivals')
      .send(validManifest({ vesselName: 'Selkie', vesselType: 'fishing', imo: undefined }));
    await request(app).post(`/api/arrivals/${cargo1.arrival.id}/arrive`).send({});

    const result = await request(app).get('/api/arrivals?type=cargo&status=arrived');
    expect(result.status).toBe(200);
    expect(result.body.arrivals).toHaveLength(1);
    expect(result.body.arrivals[0].vesselType).toBe('cargo');
    expect(result.body.arrivals[0].status).toBe('arrived');
  });

  test('GET /:id returns one arrival and 404s on unknown ids', async () => {
    const { body } = await request(app).post('/api/arrivals').send(validManifest());

    const found = await request(app).get(`/api/arrivals/${body.arrival.id}`);
    expect(found.status).toBe(200);
    expect(found.body.arrival.vesselName).toBe('MV Northern Star');

    const missing = await request(app).get('/api/arrivals/ARR-999');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('arrival not found');
  });

  test('POST /:id/arrive marks the vessel arrived with a timestamp', async () => {
    const { body } = await request(app).post('/api/arrivals').send(validManifest());

    const res = await request(app)
      .post(`/api/arrivals/${body.arrival.id}/arrive`)
      .send({ time: '2026-03-01T15:30:00Z' });
    expect(res.status).toBe(200);
    expect(res.body.arrival.status).toBe('arrived');
    expect(res.body.arrival.arrivedAt).toBe('2026-03-01T15:30:00.000Z');
  });

  test('POST /:id/arrive rejects an invalid back-dated time', async () => {
    const { body } = await request(app).post('/api/arrivals').send(validManifest());
    const res = await request(app)
      .post(`/api/arrivals/${body.arrival.id}/arrive`)
      .send({ time: 'high noon' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/arrivals/:id/assign-berth', () => {
  test('assigns the snuggest fitting berth for the stay window', async () => {
    const { body } = await request(app).post('/api/arrivals').send(validManifest());

    const res = await request(app)
      .post(`/api/arrivals/${body.arrival.id}/assign-berth`)
      .send({ from: '2026-03-01T14:00:00Z', to: '2026-03-01T22:00:00Z' });
    expect(res.status).toBe(200);
    // 85m / 6.2m draft -> B1 (90m, 7.5m) is the snuggest fit.
    expect(res.body.berth.id).toBe('B1');
    expect(res.body.assignment).toMatchObject({
      berthId: 'B1',
      arrivalId: body.arrival.id,
      vesselName: 'MV Northern Star',
    });

    const arrival = await request(app).get(`/api/arrivals/${body.arrival.id}`);
    expect(arrival.body.arrival.berth.berthId).toBe('B1');
  });

  test('defaults the window to ETA plus eight hours', async () => {
    const { body } = await request(app).post('/api/arrivals').send(validManifest());

    const res = await request(app).post(`/api/arrivals/${body.arrival.id}/assign-berth`).send({});
    expect(res.status).toBe(200);
    expect(res.body.assignment.from).toBe('2026-03-01T14:00:00.000Z');
    expect(res.body.assignment.to).toBe('2026-03-01T22:00:00.000Z');
  });

  test('409s when no berth can take the vessel', async () => {
    const { body } = await request(app)
      .post('/api/arrivals')
      .send(validManifest({ vesselName: 'Leviathan', lengthM: 400, draftM: 16, imo: undefined }));

    const res = await request(app).post(`/api/arrivals/${body.arrival.id}/assign-berth`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('no berth available');
  });

  test('avoids double-booking: second vessel gets the next berth up', async () => {
    const first = await request(app).post('/api/arrivals').send(validManifest());
    await request(app).post(`/api/arrivals/${first.body.arrival.id}/assign-berth`).send({});

    const second = await request(app)
      .post('/api/arrivals')
      .send(validManifest({ vesselName: 'Tarn Voyager', imo: undefined }));
    const res = await request(app)
      .post(`/api/arrivals/${second.body.arrival.id}/assign-berth`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.berth.id).toBe('B2'); // B1 already taken for the same window
  });

  test('400s on an inverted window and 404s on unknown arrivals', async () => {
    const { body } = await request(app).post('/api/arrivals').send(validManifest());

    const inverted = await request(app)
      .post(`/api/arrivals/${body.arrival.id}/assign-berth`)
      .send({ from: '2026-03-01T22:00:00Z', to: '2026-03-01T14:00:00Z' });
    expect(inverted.status).toBe(400);

    const missing = await request(app).post('/api/arrivals/ARR-999/assign-berth').send({});
    expect(missing.status).toBe(404);
  });
});

describe('/api/berths', () => {
  test('GET lists the berth board with occupancy flags', async () => {
    const res = await request(app).get('/api/berths');
    expect(res.status).toBe(200);
    expect(res.body.berths).toHaveLength(6);
    expect(res.body.berths[0]).toMatchObject({
      id: 'B1',
      name: 'Quayside North',
      occupied: false,
      occupant: null,
    });
  });

  test('GET shows the occupant after an assignment covering now', async () => {
    const { body } = await request(app).post('/api/arrivals').send(validManifest());
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    await request(app).post(`/api/arrivals/${body.arrival.id}/assign-berth`).send({ from, to });

    const res = await request(app).get('/api/berths');
    const b1 = res.body.berths.find((b) => b.id === 'B1');
    expect(b1.occupied).toBe(true);
    expect(b1.occupant.vesselName).toBe('MV Northern Star');
  });

  test('GET /:id/schedule returns assignments ordered by start', async () => {
    const { body } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app)
      .post(`/api/arrivals/${body.arrival.id}/assign-berth`)
      .send({ from: '2026-03-01T14:00:00Z', to: '2026-03-01T22:00:00Z' });

    const res = await request(app).get('/api/berths/B1/schedule');
    expect(res.status).toBe(200);
    expect(res.body.schedule).toHaveLength(1);
    expect(res.body.schedule[0].vesselName).toBe('MV Northern Star');
  });

  test('GET /:id/schedule 404s on an unknown berth', async () => {
    const res = await request(app).get('/api/berths/B99/schedule');
    expect(res.status).toBe(404);
  });
});

describe('/api/tides', () => {
  test('GET /table returns the channel depth and a 48h table', async () => {
    const res = await request(app).get('/api/tides/table');
    expect(res.status).toBe(200);
    expect(res.body.channelDepthM).toBe(6);
    expect(res.body.entries.length).toBeGreaterThanOrEqual(48);
    expect(res.body.entries[0]).toEqual({
      time: expect.any(String),
      heightM: expect.any(Number),
    });
  });

  test('GET /windows returns safe windows for a moderate draft', async () => {
    const res = await request(app).get('/api/tides/windows?draftM=6.5');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ draftM: 6.5, channelDepthM: 6, safetyMarginM: 0.5 });
    expect(res.body.windows.length).toBeGreaterThan(0);
    for (const w of res.body.windows) {
      expect(new Date(w.start) < new Date(w.end)).toBe(true);
      expect(w.durationMinutes).toBeGreaterThan(0);
    }
  });

  test('GET /windows returns no windows for an impossible draft', async () => {
    const res = await request(app).get('/api/tides/windows?draftM=12');
    expect(res.status).toBe(200);
    expect(res.body.windows).toEqual([]);
  });

  test('GET /windows honors a custom safety margin', async () => {
    const strict = await request(app).get('/api/tides/windows?draftM=6.5&safetyMarginM=2');
    const relaxed = await request(app).get('/api/tides/windows?draftM=6.5&safetyMarginM=0');
    expect(strict.status).toBe(200);
    expect(relaxed.status).toBe(200);
    const total = (body) => body.windows.reduce((sum, w) => sum + w.durationMinutes, 0);
    expect(total(strict.body)).toBeLessThan(total(relaxed.body));
  });

  test('GET /windows validates its query parameters', async () => {
    expect((await request(app).get('/api/tides/windows')).status).toBe(400);
    expect((await request(app).get('/api/tides/windows?draftM=abc')).status).toBe(400);
    expect((await request(app).get('/api/tides/windows?draftM=-2')).status).toBe(400);
    expect((await request(app).get('/api/tides/windows?draftM=6&safetyMarginM=-1')).status).toBe(
      400
    );
  });
});

describe('static dashboard', () => {
  test('serves the dashboard at /', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('TideLog');
  });
});

describe('GET /api/arrivals/export.csv', () => {
  test('returns 200 with text/csv content-type', async () => {
    const res = await request(app).get('/api/arrivals/export.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
  });

  test('sets a Content-Disposition attachment header with a dated filename', async () => {
    const res = await request(app).get('/api/arrivals/export.csv');
    const disposition = res.headers['content-disposition'];
    expect(disposition).toMatch(/^attachment; filename="/);
    // filename should be arrivals-YYYY-MM-DD.csv
    expect(disposition).toMatch(/arrivals-\d{4}-\d{2}-\d{2}\.csv"/);
  });

  test('returns only the header row when the log is empty', async () => {
    const res = await request(app).get('/api/arrivals/export.csv');
    const lines = res.text.split('\r\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      'id,vesselName,vesselType,lengthM,draftM,imo,eta,status,berthId,berthFrom,berthTo,loggedAt,arrivedAt'
    );
  });

  test('returns one data row per logged arrival', async () => {
    await request(app).post('/api/arrivals').send(validManifest());
    await request(app)
      .post('/api/arrivals')
      .send(validManifest({ vesselName: 'Selkie', vesselType: 'fishing', imo: undefined }));

    const res = await request(app).get('/api/arrivals/export.csv');
    const lines = res.text.split('\r\n');
    // header + 2 data rows
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('MV Northern Star');
    expect(lines[2]).toContain('Selkie');
  });

  test('data row contains vessel name, type, dimensions, ETA, and status', async () => {
    await request(app).post('/api/arrivals').send(validManifest());

    const res = await request(app).get('/api/arrivals/export.csv');
    const [, dataRow] = res.text.split('\r\n');
    expect(dataRow).toContain('MV Northern Star');
    expect(dataRow).toContain('cargo');
    expect(dataRow).toContain('85');
    expect(dataRow).toContain('6.2');
    expect(dataRow).toContain('2026-03-01T14:00:00.000Z');
    expect(dataRow).toContain('expected');
    expect(dataRow).toContain('IMO 9074729');
  });

  test('data row includes berth columns after assignment', async () => {
    const { body } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app)
      .post(`/api/arrivals/${body.arrival.id}/assign-berth`)
      .send({ from: '2026-03-01T14:00:00Z', to: '2026-03-01T22:00:00Z' });

    const res = await request(app).get('/api/arrivals/export.csv');
    const [, dataRow] = res.text.split('\r\n');
    expect(dataRow).toContain('B1');
    expect(dataRow).toContain('2026-03-01T14:00:00.000Z');
    expect(dataRow).toContain('2026-03-01T22:00:00.000Z');
  });

  test('data row includes arrivedAt timestamp after the vessel arrives', async () => {
    const { body } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app)
      .post(`/api/arrivals/${body.arrival.id}/arrive`)
      .send({ time: '2026-03-01T15:30:00Z' });

    const res = await request(app).get('/api/arrivals/export.csv');
    const [, dataRow] = res.text.split('\r\n');
    expect(dataRow).toContain('arrived');
    expect(dataRow).toContain('2026-03-01T15:30:00.000Z');
  });

  test('uses CRLF line endings throughout the document', async () => {
    await request(app).post('/api/arrivals').send(validManifest());
    const res = await request(app).get('/api/arrivals/export.csv');
    // Strip CRLF pairs; no bare LF should remain
    expect(res.text.replace(/\r\n/g, '')).not.toContain('\n');
  });
});
