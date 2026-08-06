'use strict';

const express = require('express');

const { normalizeManifest, VESSEL_TYPES } = require('../lib/manifest');
const { findBerth } = require('../lib/berths');
const { arrivalsToCsv } = require('../lib/csv');
const { fireEvent } = require('../lib/webhooks');
const db = require('./db');

const router = express.Router();

const DEFAULT_STAY_HOURS = 8;

function assignmentFor(arrivalId) {
  return db.state.assignments.find((a) => a.arrivalId === arrivalId) || null;
}

function withBerth(arrival) {
  const assignment = assignmentFor(arrival.id);
  return {
    ...arrival,
    berth: assignment
      ? { berthId: assignment.berthId, from: assignment.from, to: assignment.to }
      : null,
  };
}

/** List arrivals, optionally filtered by ?status=expected|arrived|departed|overdue
 *  and/or ?type=<vesselType>. */
router.get('/', (req, res) => {
  let arrivals = [...db.state.arrivals.values()];

  if (req.query.status) {
    arrivals = arrivals.filter((a) => a.status === req.query.status);
  }

  if (req.query.type) {
    const type = req.query.type.toLowerCase().trim();
    if (!VESSEL_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${VESSEL_TYPES.join(', ')}` });
    }
    arrivals = arrivals.filter((a) => a.vesselType === type);
  }

  res.json({ arrivals: arrivals.map(withBerth) });
});

/**
 * Export the current arrival log as a CSV file for archiving.
 *
 * Returns one row per arrival with columns: id, vesselName, vesselType,
 * lengthM, draftM, imo, eta, status, berthId, berthFrom, berthTo,
 * loggedAt, arrivedAt.
 *
 * Responds with Content-Type: text/csv and a Content-Disposition header
 * that suggests a dated filename so the harbor office can save the day sheet.
 */
router.get('/export.csv', (req, res) => {
  const arrivals = [...db.state.arrivals.values()].map(withBerth);
  const csv = arrivalsToCsv(arrivals);

  const dateStamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filename = `arrivals-${dateStamp}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

/** Log a new expected arrival from a manifest. */
router.post('/', (req, res) => {
  const result = normalizeManifest(req.body);
  if (!result.ok) {
    return res.status(400).json({ errors: result.errors });
  }
  const arrival = db.createArrival({
    ...result.value,
    status: 'expected',
    loggedAt: new Date().toISOString(),
  });
  return res.status(201).json({ arrival: withBerth(arrival) });
});

router.get('/:id', (req, res) => {
  const arrival = db.state.arrivals.get(req.params.id);
  if (!arrival) {
    return res.status(404).json({ error: 'arrival not found' });
  }
  return res.json({ arrival: withBerth(arrival) });
});

/** Mark an expected vessel as arrived (optionally back-dated via body.time). */
router.post('/:id/arrive', (req, res) => {
  const arrival = db.state.arrivals.get(req.params.id);
  if (!arrival) {
    return res.status(404).json({ error: 'arrival not found' });
  }
  let arrivedAt = new Date();
  if (req.body && req.body.time !== undefined) {
    arrivedAt = new Date(req.body.time);
    if (!Number.isFinite(arrivedAt.getTime())) {
      return res.status(400).json({ error: 'time must be a valid date/time' });
    }
  }
  arrival.status = 'arrived';
  arrival.arrivedAt = arrivedAt.toISOString();

  fireEvent(db.state.subscriptions, db.state.deliveryLog, arrival.vesselName, 'arrival_confirmed', {
    arrivalId: arrival.id,
    arrivedAt: arrival.arrivedAt,
    eta: arrival.eta,
  });

  return res.json({ arrival: withBerth(arrival) });
});

/**
 * Flag an expected vessel as overdue (still expected, past ETA).
 * Fires a vessel_overdue webhook event.
 */
router.post('/:id/overdue', (req, res) => {
  const arrival = db.state.arrivals.get(req.params.id);
  if (!arrival) {
    return res.status(404).json({ error: 'arrival not found' });
  }
  if (arrival.status !== 'expected') {
    return res.status(409).json({ error: 'only expected vessels can be marked overdue' });
  }
  arrival.status = 'overdue';

  fireEvent(db.state.subscriptions, db.state.deliveryLog, arrival.vesselName, 'vessel_overdue', {
    arrivalId: arrival.id,
    eta: arrival.eta,
    overdueAt: new Date().toISOString(),
  });

  return res.json({ arrival: withBerth(arrival) });
});

/**
 * Log the departure of an arrived (or overdue) vessel.
 * Fires a departure_logged webhook event.
 */
router.post('/:id/depart', (req, res) => {
  const arrival = db.state.arrivals.get(req.params.id);
  if (!arrival) {
    return res.status(404).json({ error: 'arrival not found' });
  }
  if (!['arrived', 'overdue'].includes(arrival.status)) {
    return res.status(409).json({ error: 'only arrived or overdue vessels can be departed' });
  }

  let departedAt = new Date();
  if (req.body && req.body.time !== undefined) {
    departedAt = new Date(req.body.time);
    if (!Number.isFinite(departedAt.getTime())) {
      return res.status(400).json({ error: 'time must be a valid date/time' });
    }
  }
  arrival.status = 'departed';
  arrival.departedAt = departedAt.toISOString();

  // Release the berth assignment when the vessel departs.
  db.state.assignments = db.state.assignments.filter((a) => a.arrivalId !== arrival.id);

  fireEvent(db.state.subscriptions, db.state.deliveryLog, arrival.vesselName, 'departure_logged', {
    arrivalId: arrival.id,
    departedAt: arrival.departedAt,
  });

  return res.json({ arrival: withBerth(arrival) });
});

/**
 * Assign a berth for a stay window (defaults: from = ETA, to = from + 8h).
 * 409 when no berth fits the vessel and window.
 */
router.post('/:id/assign-berth', (req, res) => {
  const arrival = db.state.arrivals.get(req.params.id);
  if (!arrival) {
    return res.status(404).json({ error: 'arrival not found' });
  }

  const body = req.body || {};
  const fromMillis = new Date(body.from ?? arrival.eta).getTime();
  if (!Number.isFinite(fromMillis)) {
    return res.status(400).json({ error: 'from must be a valid date/time' });
  }
  const toMillis = body.to
    ? new Date(body.to).getTime()
    : fromMillis + DEFAULT_STAY_HOURS * 3600_000;
  if (!Number.isFinite(toMillis)) {
    return res.status(400).json({ error: 'to must be a valid date/time' });
  }
  if (fromMillis >= toMillis) {
    return res.status(400).json({ error: 'from must be before to' });
  }
  const from = new Date(fromMillis).toISOString();
  const to = new Date(toMillis).toISOString();

  // Ignore the vessel's own current assignment when re-assigning.
  const others = db.state.assignments.filter((a) => a.arrivalId !== arrival.id);
  const berth = findBerth(db.state.berths, others, arrival, { from, to });
  if (!berth) {
    return res.status(409).json({ error: 'no berth available for this vessel and window' });
  }

  const assignment = {
    berthId: berth.id,
    arrivalId: arrival.id,
    vesselName: arrival.vesselName,
    from,
    to,
  };
  db.state.assignments = [...others, assignment];

  fireEvent(db.state.subscriptions, db.state.deliveryLog, arrival.vesselName, 'berth_assigned', {
    arrivalId: arrival.id,
    berthId: berth.id,
    berthName: berth.name,
    from,
    to,
  });

  return res.json({ assignment, berth });
});

module.exports = router;
