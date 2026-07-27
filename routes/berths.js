'use strict';

const express = require('express');

const { occupantAt } = require('../lib/berths');
const db = require('./db');

const router = express.Router();

function berthView(berth, at) {
  const occupant = occupantAt(db.state.assignments, berth.id, at);
  return {
    ...berth,
    occupied: occupant !== null,
    occupant: occupant
      ? {
          arrivalId: occupant.arrivalId,
          vesselName: occupant.vesselName,
          from: occupant.from,
          to: occupant.to,
        }
      : null,
  };
}

/** Berth board: every berth with its current occupant (if any). */
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

module.exports = router;
