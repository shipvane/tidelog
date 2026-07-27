'use strict';

/**
 * Arrival manifest validation and normalization.
 *
 * A manifest is the paperwork a vessel (or its agent) files ahead of
 * arrival. `normalizeManifest` validates the raw payload and returns a
 * cleaned record — trimmed name, canonical IMO format, lower-cased vessel
 * type, numeric dimensions, ISO ETA — or a list of human-readable errors.
 */

const VESSEL_TYPES = [
  'cargo',
  'container',
  'tanker',
  'fishing',
  'passenger',
  'tug',
  'yacht',
  'other',
];

/**
 * IMO number check: seven digits where the last is a checksum — the sum of
 * the first six digits multiplied by weights 7..2, modulo 10. Accepts an
 * optional "IMO " prefix and surrounding whitespace.
 */
function isValidImo(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return false;
  }
  const digits = String(value)
    .trim()
    .replace(/^IMO\s*/i, '');
  if (!/^\d{7}$/.test(digits)) {
    return false;
  }
  let sum = 0;
  for (let i = 0; i < 6; i += 1) {
    sum += Number(digits[i]) * (7 - i);
  }
  return sum % 10 === Number(digits[6]);
}

function formatImo(value) {
  return `IMO ${String(value)
    .trim()
    .replace(/^IMO\s*/i, '')}`;
}

/**
 * Validate and normalize a raw arrival manifest.
 * Returns `{ ok: true, errors: [], value }` or `{ ok: false, errors, value: null }`.
 */
function normalizeManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['manifest body must be an object'], value: null };
  }

  const errors = [];
  const value = {};

  const name = typeof raw.vesselName === 'string' ? raw.vesselName.trim().replace(/\s+/g, ' ') : '';
  if (!name) {
    errors.push('vesselName is required');
  } else {
    value.vesselName = name;
  }

  const type = typeof raw.vesselType === 'string' ? raw.vesselType.trim().toLowerCase() : '';
  if (!type) {
    errors.push('vesselType is required');
  } else if (!VESSEL_TYPES.includes(type)) {
    errors.push(`vesselType must be one of: ${VESSEL_TYPES.join(', ')}`);
  } else {
    value.vesselType = type;
  }

  for (const field of ['lengthM', 'draftM']) {
    const rawNumber =
      typeof raw[field] === 'string' && raw[field].trim() !== '' ? Number(raw[field]) : raw[field];
    if (typeof rawNumber !== 'number' || !Number.isFinite(rawNumber) || rawNumber <= 0) {
      errors.push(`${field} must be a positive number`);
    } else {
      value[field] = rawNumber;
    }
  }

  if (raw.imo === undefined || raw.imo === null || raw.imo === '') {
    value.imo = null;
  } else if (!isValidImo(raw.imo)) {
    errors.push('imo must be a valid 7-digit IMO number');
  } else {
    value.imo = formatImo(raw.imo);
  }

  const etaMillis = raw.eta ? new Date(raw.eta).getTime() : NaN;
  if (!Number.isFinite(etaMillis)) {
    errors.push('eta must be a valid date/time');
  } else {
    value.eta = new Date(etaMillis).toISOString();
  }

  if (raw.agent !== undefined && raw.agent !== null) {
    if (typeof raw.agent !== 'string' || raw.agent.trim() === '') {
      errors.push('agent, when provided, must be a non-empty string');
    } else {
      value.agent = raw.agent.trim();
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, value: null };
  }
  return { ok: true, errors: [], value };
}

module.exports = {
  VESSEL_TYPES,
  isValidImo,
  formatImo,
  normalizeManifest,
};
