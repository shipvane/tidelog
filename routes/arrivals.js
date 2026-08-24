'use strict';

const express = require('express');

const { normalizeManifest, VESSEL_TYPES } = require('../lib/manifest');
const { findBerth } = require('../lib/berths');
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

/** List arrivals, optionally filtered by ?status=expected|arrived and/or ?type=<vesselType>. */
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
  return res.json({ assignment, berth });
});

module.exports = router;
