'use strict';

const request = require('supertest');
const { JSDOM } = require('jsdom');

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

function createTd(document, text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function renderArrivalsInDOM(document, arrivals) {
  const tbody = document.getElementById('arrivals-body');
  for (const arrival of arrivals) {
    const row = document.createElement('tr');

    const vessel = document.createElement('td');
    vessel.className = 'vessel';
    vessel.textContent = arrival.vesselName;
    row.appendChild(vessel);

    const type = document.createElement('td');
    const typeSpan = document.createElement('span');
    typeSpan.className = 'pill pill-type';
    typeSpan.textContent = arrival.vesselType;
    type.appendChild(typeSpan);
    row.appendChild(type);

    row.appendChild(createTd(document, `${arrival.lengthM} m`));
    row.appendChild(createTd(document, `${arrival.draftM} m`));
    row.appendChild(createTd(document, arrival.eta));

    const status = document.createElement('td');
    const statusSpan = document.createElement('span');
    statusSpan.className = `pill pill-${arrival.status}`;
    statusSpan.textContent = arrival.status;
    status.appendChild(statusSpan);
    row.appendChild(status);

    // Add Assign button cell
    const actionCell = document.createElement('td');
    if (!arrival.berth && arrival.status === 'expected') {
      const btn = document.createElement('button');
      btn.className = 'btn-assign';
      btn.type = 'button';
      btn.textContent = 'Assign';
      actionCell.appendChild(btn);
    }
    row.appendChild(actionCell);

    tbody.appendChild(row);
  }
}

beforeEach(() => {
  db.reset();
});

describe('Arrivals table UI - Assign button visibility', () => {
  test('displays Assign button for expected vessels with no berth', async () => {
    // Create a vessel that is expected with no berth
    await request(app).post('/api/arrivals').send(validManifest());

    // Fetch the HTML
    const res = await request(app).get('/');
    expect(res.status).toBe(200);

    // Parse with JSDOM
    const dom = new JSDOM(res.text);
    const { document } = dom.window;

    // Get API data
    const arrivalsRes = await request(app).get('/api/arrivals');
    const arrivals = arrivalsRes.body.arrivals;

    // Render the table
    renderArrivalsInDOM(document, arrivals);

    // Find the Assign button
    const assignBtn = document.querySelector('button.btn-assign');
    expect(assignBtn).not.toBeNull();
    expect(assignBtn.textContent).toBe('Assign');
  });

  test('does not display Assign button for arrived vessels', async () => {
    // Create a vessel and mark it as arrived
    const { body } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app)
      .post(`/api/arrivals/${body.arrival.id}/arrive`)
      .send({ time: '2026-03-01T15:30:00Z' });

    // Fetch the HTML
    const res = await request(app).get('/');
    expect(res.status).toBe(200);

    // Parse with JSDOM
    const dom = new JSDOM(res.text);
    const { document } = dom.window;

    // Get API data
    const arrivalsRes = await request(app).get('/api/arrivals');
    const arrivals = arrivalsRes.body.arrivals;

    // Render the table
    renderArrivalsInDOM(document, arrivals);

    // The Assign button should not exist
    const assignBtn = document.querySelector('button.btn-assign');
    expect(assignBtn).toBeNull();
  });

  test('does not display Assign button for vessels with berth assignment', async () => {
    // Create a vessel and assign it a berth
    const { body } = await request(app).post('/api/arrivals').send(validManifest());
    await request(app)
      .post(`/api/arrivals/${body.arrival.id}/assign-berth`)
      .send({ from: '2026-03-01T14:00:00Z', to: '2026-03-01T22:00:00Z' });

    // Fetch the HTML
    const res = await request(app).get('/');
    expect(res.status).toBe(200);

    // Parse with JSDOM
    const dom = new JSDOM(res.text);
    const { document } = dom.window;

    // Get API data
    const arrivalsRes = await request(app).get('/api/arrivals');
    const arrivals = arrivalsRes.body.arrivals;

    // Render the table
    renderArrivalsInDOM(document, arrivals);

    // The Assign button should not exist (vessel has a berth)
    const assignBtn = document.querySelector('button.btn-assign');
    expect(assignBtn).toBeNull();
  });

  test('shows multiple Assign buttons for multiple expected vessels with no berth', async () => {
    // Create two vessels that are expected with no berth
    await request(app).post('/api/arrivals').send(validManifest());
    await request(app)
      .post('/api/arrivals')
      .send(
        validManifest({
          vesselName: 'Marlin Quest',
          imo: undefined,
        })
      );

    // Fetch the HTML
    const res = await request(app).get('/');
    expect(res.status).toBe(200);

    // Parse with JSDOM
    const dom = new JSDOM(res.text);
    const { document } = dom.window;

    // Get API data
    const arrivalsRes = await request(app).get('/api/arrivals');
    const arrivals = arrivalsRes.body.arrivals;

    // Render the table
    renderArrivalsInDOM(document, arrivals);

    // Find all Assign buttons
    const assignBtns = document.querySelectorAll('button.btn-assign');
    expect(assignBtns.length).toBe(2);
    assignBtns.forEach((btn) => {
      expect(btn.textContent).toBe('Assign');
    });
  });

  test('table has 7 columns and no Berth column header', async () => {
    // Fetch the HTML
    const res = await request(app).get('/');
    expect(res.status).toBe(200);

    // Parse with JSDOM
    const dom = new JSDOM(res.text);
    const { document } = dom.window;

    // Find the arrivals table headers specifically (first table)
    const arrivalsThead = document.querySelector(
      'section[aria-labelledby="arrivals-heading"] thead'
    );
    const headers = arrivalsThead.querySelectorAll('th');
    expect(headers.length).toBe(7);

    // Verify the headers (in order)
    const headerTexts = Array.from(headers).map((h) => h.textContent.trim());
    expect(headerTexts).toEqual(['Vessel', 'Type', 'LOA', 'Draft', 'ETA', 'Status', '']);
  });

  test('displays vessel info and renders correctly without horizontal scroll', async () => {
    // Create a vessel
    await request(app).post('/api/arrivals').send(validManifest());

    // Fetch the HTML
    const res = await request(app).get('/');
    expect(res.status).toBe(200);

    // Parse with JSDOM
    const dom = new JSDOM(res.text);
    const { document } = dom.window;

    // Get API data
    const arrivalsRes = await request(app).get('/api/arrivals');
    const arrivals = arrivalsRes.body.arrivals;

    // Render the table
    renderArrivalsInDOM(document, arrivals);

    // Find the vessel row
    const vesselCell = document.querySelector('td.vessel');
    expect(vesselCell).not.toBeNull();
    expect(vesselCell.textContent).toContain('MV Northern Star');

    // Verify row has 7 cells
    const row = vesselCell.closest('tr');
    const cells = row.querySelectorAll('td');
    expect(cells.length).toBe(7);
  });
});
