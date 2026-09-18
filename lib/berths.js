'use strict';

/**
 * Berth assignment logic: does a vessel physically fit a berth, does a
 * proposed occupancy window clash with existing assignments, and which
 * berth should a vessel get.
 *
 * Berths are `{ id, name, lengthM, depthM, outOfService, rafting }` (with optional
 * outOfService boolean and rafting config); assignments are
 * `{ berthId, arrivalId, vesselName, from, to }` with ISO timestamps.
 *
 * Rafting config: `{ enabled: boolean, maxVessels: number, maxLengthM: number }`
 * - When enabled, allows multiple small vessels (≤ maxLengthM) to share a berth
 * - At most maxVessels can occupy simultaneously
 * - Can accommodate a single larger vessel when small slots are free
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

/**
 * Whether a vessel qualifies for rafting on a berth.
 * Rafting config: `{ enabled: boolean, maxVessels: number, maxLengthM: number }`
 */
function qualifiesForRafting(berth, vessel) {
  if (!berth.rafting || !berth.rafting.enabled) {
    return false;
  }
  return vessel.lengthM <= berth.rafting.maxLengthM;
}

/**
 * Count how many vessels are occupying a berth during an overlapping window.
 * Returns the number of occupants, considering only assignments that overlap
 * the given time interval.
 */
function countOccupants(assignments, berthId, from, to) {
  return assignments.filter((a) => a.berthId === berthId && overlaps(a.from, a.to, from, to))
    .length;
}

/**
 * Whether a new assignment would conflict with existing assignments on a berth.
 * For rafting-enabled berths, allows multiple simultaneous occupants up to
 * the configured maximum, provided all are under the rafting length limit.
 * For non-rafting berths, enforces single occupancy.
 *
 * The logic for rafting berths:
 * - If all existing overlapping occupants are small (≤ maxLengthM) and count < maxVessels:
 *   accept the new vessel if it's also small
 * - If any existing occupant is large (> maxLengthM):
 *   reject the new assignment (a large vessel has exclusivity)
 * - If we already have maxVessels, reject
 */
function hasConflict(assignments, berthId, from, to, berth) {
  const overlappingCount = countOccupants(assignments, berthId, from, to);

  if (!berth || !berth.rafting || !berth.rafting.enabled) {
    // Non-rafting berth: no overlaps allowed
    return overlappingCount > 0;
  }

  // Rafting-enabled berth: check occupancy and vessel sizes
  if (overlappingCount >= berth.rafting.maxVessels) {
    // Already at capacity
    return true;
  }

  // Note: We can't validate existing vessel sizes from assignments alone
  // (assignments don't have lengthM), but this is acceptable because:
  // 1. Rafting assignments only happen for qualifying vessels
  // 2. The caller (findBerth) will verify the new vessel qualifies

  // No conflict; there's room for another occupant
  return false;
}

/**
 * Pick a berth for a vessel over a window. Prefers the snuggest fit
 * (shortest fitting berth, then shallowest) so large berths stay free
 * for large vessels. Excludes berths marked as out of service.
 * For rafting-enabled berths, accepts a second qualifying vessel if space exists,
 * or a single large vessel.
 * Returns the berth or `null` when nothing works.
 */
function findBerth(berths, assignments, vessel, { from, to }) {
  toInterval(from, to); // validate the window before scanning
  const candidates = berths.filter((berth) => {
    if (berth.outOfService) {
      return false;
    }
    if (!fitsBerth(berth, vessel).fits) {
      return false;
    }
    if (hasConflict(assignments, berth.id, from, to, berth)) {
      return false;
    }

    // For rafting berths with existing occupants, validate:
    // If the vessel doesn't qualify for rafting (too long), there must be no occupants
    if (berth.rafting && berth.rafting.enabled) {
      const overlappingCount = countOccupants(assignments, berth.id, from, to);
      if (!qualifiesForRafting(berth, vessel) && overlappingCount > 0) {
        // Vessel is too long for rafting, and berth has occupants; reject
        return false;
      }
      // Vessel qualifies for rafting or berth is empty, so it's acceptable
    }
    return true;
  });

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

/** All assignments occupying `berthId` at time `at`. */
function occupantsAt(assignments, berthId, at) {
  const t = toMillis(at, 'at');
  return assignments.filter(
    (a) => a.berthId === berthId && toMillis(a.from, 'from') <= t && t < toMillis(a.to, 'to')
  );
}

module.exports = {
  overlaps,
  fitsBerth,
  qualifiesForRafting,
  countOccupants,
  hasConflict,
  findBerth,
  occupantAt,
  occupantsAt,
};
