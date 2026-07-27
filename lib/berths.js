'use strict';

/**
 * Berth assignment logic: does a vessel physically fit a berth, does a
 * proposed occupancy window clash with existing assignments, and which
 * berth should a vessel get.
 *
 * Berths are `{ id, name, lengthM, depthM }`; assignments are
 * `{ berthId, arrivalId, vesselName, from, to }` with ISO timestamps.
 */

function toMillis(value, label = 'time') {
  const millis = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(millis)) {
    throw new TypeError(`${label} is not a valid date: ${value}`);
  }
  return millis;
}

function toInterval(from, to) {
  const start = toMillis(from, 'from');
  const end = toMillis(to, 'to');
  if (start >= end) {
    throw new RangeError('interval start must be before its end');
  }
  return { start, end };
}

/** Half-open interval overlap: touching endpoints do not conflict. */
function overlaps(aFrom, aTo, bFrom, bTo) {
  const a = toInterval(aFrom, aTo);
  const b = toInterval(bFrom, bTo);
  return a.start < b.end && b.start < a.end;
}

/**
 * Whether a vessel physically fits a berth. Returns `{ fits, reasons }`
 * so callers can explain a rejection.
 */
function fitsBerth(berth, vessel) {
  for (const [obj, fields, label] of [
    [berth, ['lengthM', 'depthM'], 'berth'],
    [vessel, ['lengthM', 'draftM'], 'vessel'],
  ]) {
    for (const field of fields) {
      const value = obj ? obj[field] : undefined;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new TypeError(`${label}.${field} must be a positive number`);
      }
    }
  }

  const reasons = [];
  if (vessel.lengthM > berth.lengthM) {
    reasons.push(`vessel length ${vessel.lengthM}m exceeds berth length ${berth.lengthM}m`);
  }
  if (vessel.draftM > berth.depthM) {
    reasons.push(`vessel draft ${vessel.draftM}m exceeds berth depth ${berth.depthM}m`);
  }
  return { fits: reasons.length === 0, reasons };
}

/** Whether any existing assignment on `berthId` overlaps `[from, to)`. */
function hasConflict(assignments, berthId, from, to) {
  return assignments
    .filter((a) => a.berthId === berthId)
    .some((a) => overlaps(a.from, a.to, from, to));
}

/**
 * Pick a berth for a vessel over a window. Prefers the snuggest fit
 * (shortest fitting berth, then shallowest) so large berths stay free
 * for large vessels. Returns the berth or `null` when nothing works.
 */
function findBerth(berths, assignments, vessel, { from, to }) {
  toInterval(from, to); // validate the window before scanning
  const candidates = berths.filter(
    (berth) => fitsBerth(berth, vessel).fits && !hasConflict(assignments, berth.id, from, to)
  );
  if (candidates.length === 0) {
    return null;
  }
  return candidates.sort((a, b) => a.lengthM - b.lengthM || a.depthM - b.depthM)[0];
}

/** Assignment occupying `berthId` at time `at`, or null when vacant. */
function occupantAt(assignments, berthId, at) {
  const t = toMillis(at, 'at');
  return (
    assignments.find(
      (a) => a.berthId === berthId && toMillis(a.from, 'from') <= t && t < toMillis(a.to, 'to')
    ) || null
  );
}

module.exports = {
  overlaps,
  fitsBerth,
  hasConflict,
  findBerth,
  occupantAt,
};
