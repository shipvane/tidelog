'use strict';

const express = require('express');

const { safeWindows, DEFAULT_SAFETY_MARGIN_M } = require('../lib/tides');
const db = require('./db');

const router = express.Router();

/** The raw tide table the harbor is working from. */
router.get('/table', (req, res) => {
  res.json({ channelDepthM: db.CHANNEL_DEPTH_M, entries: db.state.tideTable });
});

/**
 * Safe entry windows for a vessel draft:
 * GET /api/tides/windows?draftM=6.5[&safetyMarginM=0.5]
 */
router.get('/windows', (req, res) => {
  const draftM = Number(req.query.draftM);
  if (!Number.isFinite(draftM) || draftM <= 0) {
    return res.status(400).json({ error: 'draftM query parameter must be a positive number' });
  }

  let safetyMarginM = DEFAULT_SAFETY_MARGIN_M;
  if (req.query.safetyMarginM !== undefined) {
    safetyMarginM = Number(req.query.safetyMarginM);
    if (!Number.isFinite(safetyMarginM) || safetyMarginM < 0) {
      return res
        .status(400)
        .json({ error: 'safetyMarginM query parameter must be a non-negative number' });
    }
  }

  const windows = safeWindows(db.state.tideTable, {
    draftM,
    channelDepthM: db.CHANNEL_DEPTH_M,
    safetyMarginM,
  });
  return res.json({ draftM, channelDepthM: db.CHANNEL_DEPTH_M, safetyMarginM, windows });
});

module.exports = router;
