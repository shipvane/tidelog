'use strict';

const express = require('express');

const { occupantsAt } = require('../lib/berths');
const db = require('./db');

const router = express.Router();

function berthView(berth, at) {
  const occupants = occupantsAt(db.state.assignments, berth.id, at);
  const occupied = occupants.length > 0;
  const occupant = occupants.length > 0 ? occupants[0] : null;

  return {
    ...berth,
    occupied,
    occupant: occupant
      ? {
          arrivalId: occupant.arrivalId,
          vesselName: occupant.vesselName,
          from: occupant.from,
          to: occupant.to,
        }
      : null,
    // Include all occupants for rafting support
    occupants: occupants.map((o) => ({
      arrivalId: o.arrivalId,
      vesselName: o.vesselName,
      from: o.from,
      to: o.to,
    })),
  };
}

/** Berth board: every berth with its current occupant(s) (if any). */
router.get('/', (req, res) => {
  const at = new Date().toISOString();
  res.json({ berths: db.state.berths.map((berth) => berthView(berth, at)) });
});

/** Upcoming and current assignments for one berth, ordered by start. */
router.get('/:id/schedule', (req, res) => {
  const berth = db.state.berths.find((b) => b.id === req.params.id);
  if (!berth) {
    return res.status(404).json({ error: 'berth not found' });
  }
  const schedule = db.state.assignments
    .filter((a) => a.berthId === berth.id)
    .sort((a, b) => new Date(a.from) - new Date(b.from));
  return res.json({ berth, schedule });
});

/**
 * Toggle a berth's maintenance mode (outOfService flag).
 * POST body optionally includes `reason` for the maintenance.
 * Returns the updated berth.
 */
router.post('/:id/maintenance', (req, res) => {
  const berth = db.state.berths.find((b) => b.id === req.params.id);
  if (!berth) {
    return res.status(404).json({ error: 'berth not found' });
  }

  // Toggle the outOfService flag
  berth.outOfService = !berth.outOfService;

  // Optionally store the reason if toggling into maintenance
  if (berth.outOfService && req.body && req.body.reason) {
    berth.maintenanceReason = req.body.reason;
  } else if (!berth.outOfService) {
    // Clear the reason when exiting maintenance
    delete berth.maintenanceReason;
  }

  return res.json({ berth });
});

module.exports = router;
