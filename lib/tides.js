'use strict';

/**
 * Tide-window math for harbor entry planning.
 *
 * A vessel can safely transit the approach channel when the water depth
 * (charted channel depth + tide height) covers its draft plus a safety
 * margin (under-keel clearance). Given a tide table — a series of
 * `{ time, heightM }` observations or predictions — these functions compute
 * the height threshold a vessel needs and the time windows during which it
 * is met, using linear interpolation between table entries.
 */

const DEFAULT_SAFETY_MARGIN_M = 0.5;

function toMillis(value, label = 'time') {
  const millis = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(millis)) {
    throw new TypeError(`${label} is not a valid date: ${value}`);
  }
  return millis;
}

function assertPositiveNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive number`);
  }
}

function normalizeTable(entries) {
  if (!Array.isArray(entries) || entries.length < 2) {
    throw new RangeError('tide table needs at least two entries');
  }
  const points = entries.map((entry, index) => {
    if (!entry || typeof entry.heightM !== 'number' || !Number.isFinite(entry.heightM)) {
      throw new TypeError(`tide table entry ${index} has an invalid heightM`);
    }
    return { t: toMillis(entry.time, `tide table entry ${index} time`), heightM: entry.heightM };
  });
  points.sort((a, b) => a.t - b.t);
  return points;
}

/**
 * Minimum tide height (above chart datum) a vessel needs to transit the
 * channel. Negative values mean the channel is deep enough at any tide.
 */
function requiredTideHeight({ draftM, channelDepthM, safetyMarginM = DEFAULT_SAFETY_MARGIN_M }) {
  assertPositiveNumber(draftM, 'draftM');
  assertPositiveNumber(channelDepthM, 'channelDepthM');
  if (typeof safetyMarginM !== 'number' || !Number.isFinite(safetyMarginM) || safetyMarginM < 0) {
    throw new TypeError('safetyMarginM must be a non-negative number');
  }
  return draftM + safetyMarginM - channelDepthM;
}

/**
 * Tide height at an arbitrary time, linearly interpolated between the two
 * surrounding tide-table entries. Throws RangeError outside the table span.
 */
function heightAt(entries, time) {
  const points = normalizeTable(entries);
  const t = toMillis(time);
  if (t < points[0].t || t > points[points.length - 1].t) {
    throw new RangeError('time is outside the tide table span');
  }
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (t >= a.t && t <= b.t) {
      if (a.t === b.t) {
        return a.heightM;
      }
      const ratio = (t - a.t) / (b.t - a.t);
      return a.heightM + ratio * (b.heightM - a.heightM);
    }
  }
  /* istanbul ignore next -- unreachable: t is within [first, last] */
  return points[points.length - 1].heightM;
}

/** Whether a vessel with the given constraints can transit at `time`. */
function isSafeAt(entries, time, constraints) {
  return heightAt(entries, time) >= requiredTideHeight(constraints);
}

/**
 * Contiguous windows within the tide table span during which the required
 * tide height is met. Boundary crossings are solved exactly on the linear
 * segments, so window edges are precise, not step-sampled.
 *
 * Returns `[{ start, end, durationMinutes }]` with ISO-8601 timestamps.
 */
function safeWindows(entries, constraints) {
  const required = requiredTideHeight(constraints);
  const points = normalizeTable(entries);

  const raw = [];
  let openedAt = points[0].heightM >= required ? points[0].t : null;

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const aSafe = a.heightM >= required;
    const bSafe = b.heightM >= required;
    if (aSafe === bSafe || a.t === b.t) {
      continue;
    }
    const ratio = (required - a.heightM) / (b.heightM - a.heightM);
    const crossing = Math.round(a.t + ratio * (b.t - a.t));
    if (aSafe) {
      raw.push({ start: openedAt, end: crossing });
      openedAt = null;
    } else {
      openedAt = crossing;
    }
  }
  if (openedAt !== null) {
    raw.push({ start: openedAt, end: points[points.length - 1].t });
  }

  return raw
    .filter((w) => w.end > w.start)
    .map((w) => ({
      start: new Date(w.start).toISOString(),
      end: new Date(w.end).toISOString(),
      durationMinutes: Math.round((w.end - w.start) / 60000),
    }));
}

module.exports = {
  DEFAULT_SAFETY_MARGIN_M,
  requiredTideHeight,
  heightAt,
  isSafeAt,
  safeWindows,
};
