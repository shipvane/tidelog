'use strict';

/**
 * Configuration constants for harbor operations.
 */

/** Threshold in hours: a vessel is overdue if still expected beyond ETA + this value. */
const OVERDUE_THRESHOLD_HOURS = 2;

module.exports = {
  OVERDUE_THRESHOLD_HOURS,
};
