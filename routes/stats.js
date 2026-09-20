'use strict';

const express = require('express');

const db = require('./db');

const router = express.Router();

/**
 * Calculate turnaround hours for an arrival: time from arrival to departure.
 * Returns null if the vessel has not both arrived and departed.
 */
function calculateTurnaroundHours(arrival) {
  if (!arrival.arrivedAt || !arrival.departedAt) {
    return null;
  }
  const arrivedMillis = new Date(arrival.arrivedAt).getTime();
  const departedMillis = new Date(arrival.departedAt).getTime();
  if (!Number.isFinite(arrivedMillis) || !Number.isFinite(departedMillis)) {
    return null;
  }
  const turnaroundMillis = departedMillis - arrivedMillis;
  return turnaroundMillis / (3600 * 1000);
}

/**
 * Calculate average turnaround hours for all departed vessels.
 * Returns the average turnaround time (in hours) for all vessels that have
 * both arrived and departed.
 */
router.get('/turnaround', (req, res) => {
  const arrivals = [...db.state.arrivals.values()];
  const turnaroundHours = arrivals.map(calculateTurnaroundHours).filter((hours) => hours !== null);

  if (turnaroundHours.length === 0) {
    return res.json({
      averageTurnaroundHours: null,
      count: 0,
    });
  }

  const sum = turnaroundHours.reduce((acc, hours) => acc + hours, 0);
  const average = sum / turnaroundHours.length;

  return res.json({
    averageTurnaroundHours: average,
    count: turnaroundHours.length,
  });
});

module.exports = router;
