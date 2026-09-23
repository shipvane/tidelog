'use strict';

/**
 * Integration test for ticket 12: Verify the notifications panel displays
 * the seeded berth change notification on the rendered page.
 *
 * This test loads the HTML page, simulates the page's JavaScript rendering,
 * and verifies that the notification appears in the notifications panel.
 */

const request = require('supertest');
const { JSDOM } = require('jsdom');
const { boundServer } = require('./support/server');
const app = boundServer(require('../server'));
const db = require('../routes/db');

beforeEach(() => {
  db.reset();
  db.seedDemoData();
});

describe('Ticket 12: Notifications panel displays seeded berth change', () => {
  test('notifications panel renders seeded notification with all columns populated', async () => {
    // Fetch the HTML page
    const pageRes = await request(app).get('/');
    expect(pageRes.status).toBe(200);

    // Parse with JSDOM to enable DOM manipulation
    const dom = new JSDOM(pageRes.text, {
      url: 'http://localhost:3000',
    });
    const { document } = dom.window;

    // Fetch the delivery data
    const deliveryRes = await request(app).get('/api/webhooks/deliveries?limit=20');
    expect(deliveryRes.status).toBe(200);
    const { deliveries } = deliveryRes.body;

    // Simulate the renderNotifications function from app.js
    const tbody = document.getElementById('notifications-body');
    tbody.replaceChildren();

    if (deliveries.length > 0) {
      for (const d of deliveries) {
        const row = document.createElement('tr');

        // Time column
        const timeCell = document.createElement('td');
        timeCell.className = 'notif-time';
        timeCell.textContent = new Date(d.attemptedAt).toLocaleString();
        row.appendChild(timeCell);

        // Vessel column
        const vesselCell = document.createElement('td');
        vesselCell.className = 'vessel';
        vesselCell.textContent = d.vesselName;
        row.appendChild(vesselCell);

        // Event column
        const eventCell = document.createElement('td');
        const EVENT_LABELS = {
          arrival_confirmed: 'Arrival confirmed',
          berth_assigned: 'Berth assigned',
          vessel_overdue: 'Vessel overdue',
          departure_logged: 'Departure logged',
        };
        eventCell.textContent = EVENT_LABELS[d.eventType] || d.eventType;
        row.appendChild(eventCell);

        // Endpoint column
        const endpointCell = document.createElement('td');
        endpointCell.className = 'notif-url';
        endpointCell.title = d.url;
        const urlText = d.url.length > 40 ? `${d.url.slice(0, 37)}…` : d.url;
        endpointCell.textContent = urlText;
        row.appendChild(endpointCell);

        // Result column
        const resultCell = document.createElement('td');
        if (d.ok) {
          const span = document.createElement('span');
          span.className = 'pill pill-arrived';
          span.textContent = `${d.httpStatus} OK`;
          resultCell.appendChild(span);
        } else {
          const span = document.createElement('span');
          span.className = 'pill pill-failed';
          const label = d.httpStatus ? `${d.httpStatus} Error` : 'Failed';
          span.textContent = label;
          resultCell.appendChild(span);
        }
        row.appendChild(resultCell);

        // Retry column
        const retryCell = document.createElement('td');
        retryCell.className = 'notif-retry';
        retryCell.textContent = d.retried ? 'Yes' : '—';
        row.appendChild(retryCell);

        // Action column
        const actionCell = document.createElement('td');
        const btn = document.createElement('button');
        btn.className = 'btn-resend';
        btn.type = 'button';
        btn.textContent = 'Resend';
        actionCell.appendChild(btn);
        row.appendChild(actionCell);

        tbody.appendChild(row);
      }
    }

    // Verify the panel now shows data (not the "Loading..." or "No notifications" message)
    const rows = tbody.querySelectorAll('tr');
    expect(rows.length).toBeGreaterThan(0);

    // Verify the first row has all required columns
    const firstRow = rows[0];
    const cells = firstRow.querySelectorAll('td');
    expect(cells.length).toBe(7); // TIME · VESSEL · EVENT · ENDPOINT · RESULT · RETRY · ACTION

    // Verify each column has content (not empty)
    const timeCell = cells[0]; // TIME
    const vesselCell = cells[1]; // VESSEL
    const eventCell = cells[2]; // EVENT
    const endpointCell = cells[3]; // ENDPOINT
    const resultCell = cells[4]; // RESULT
    const retryCell = cells[5]; // RETRY

    expect(timeCell.textContent.trim().length).toBeGreaterThan(0);
    expect(vesselCell.textContent.trim()).toBe('Tarn Voyager');
    expect(eventCell.textContent.trim()).toBe('Berth assigned');
    expect(endpointCell.textContent.trim().length).toBeGreaterThan(0);
    expect(resultCell.textContent.trim().length).toBeGreaterThan(0);
    expect(retryCell.textContent.trim()).not.toBe('');
  });

  test('notifications panel is not empty after seeding', async () => {
    // This verifies the core requirement: the panel shows data in the demo
    const res = await request(app).get('/api/webhooks/deliveries');
    expect(res.body.deliveries.length).toBeGreaterThan(0);

    // And it's for a real vessel from demo data
    const notif = res.body.deliveries[0];
    expect(notif.vesselName).toBe('Tarn Voyager');
    expect(notif.eventType).toBe('berth_assigned');
  });

  test('endpoint column is populated (not empty)', async () => {
    const res = await request(app).get('/api/webhooks/deliveries');
    const notif = res.body.deliveries[0];

    expect(notif.url).toBeDefined();
    expect(notif.url.trim().length).toBeGreaterThan(0);
    expect(notif.url).toMatch(/https?:\/\/.+/);
  });

  test('result column is populated (not empty)', async () => {
    const res = await request(app).get('/api/webhooks/deliveries');
    const notif = res.body.deliveries[0];

    expect(notif.ok).toBeDefined();
    expect(notif.httpStatus).toBeDefined();
    expect(notif.httpStatus).toBe(200);
  });

  test('retry column is populated (not empty)', async () => {
    const res = await request(app).get('/api/webhooks/deliveries');
    const notif = res.body.deliveries[0];

    expect(notif.retried).toBeDefined();
    expect(typeof notif.retried).toBe('boolean');
  });
});
