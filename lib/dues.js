'use strict';

/**
 * Harbor dues calculator.
 *
 * Harbor dues are charged at a tariff of: lengthM × hours alongside × rate
 * The calculator can compute the charge from vessel dimensions and a berth
 * assignment window, returning a line-item breakdown.
 */

/** Default harbor dues rate per unit (meter-hour). */
const DEFAULT_RATE_PER_METER_HOUR = 10;

/**
 * Convert ISO 8601 timestamp to milliseconds.
 *
 * @param {string|Date} value - ISO timestamp or Date object
 * @param {string} [label='time'] - Field name for error messages
 * @returns {number} Milliseconds since epoch
 * @throws {TypeError} If value is not a valid date
 */
function toMillis(value, label = 'time') {
  const millis = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(millis)) {
    throw new TypeError(`${label} is not a valid date: ${value}`);
  }
  return millis;
}

/**
 * Calculate hours elapsed between two timestamps.
 *
 * @param {string|Date} from - Start time (ISO timestamp or Date)
 * @param {string|Date} to - End time (ISO timestamp or Date)
 * @returns {number} Elapsed hours as a decimal
 * @throws {TypeError} If either timestamp is invalid
 * @throws {RangeError} If from >= to
 */
function hoursElapsed(from, to) {
  const fromMillis = toMillis(from, 'from');
  const endMillis = toMillis(to, 'to');
  if (fromMillis >= endMillis) {
    throw new RangeError('from must be before to');
  }
  return (endMillis - fromMillis) / (1000 * 60 * 60);
}

/**
 * Calculate harbor dues for a vessel based on its berth assignment window.
 *
 * Returns a charge object with line-item breakdown:
 * - lengthM: vessel length in meters
 * - hoursAlongside: hours spent at berth (decimal)
 * - ratePerMeterHour: tariff per meter-hour
 * - totalChargeCurrency: computed charge (lengthM × hoursAlongside × rate)
 * - breakdown: description of the calculation
 *
 * @param {object} params - Calculation parameters
 * @param {number} params.lengthM - Vessel length in meters (must be positive)
 * @param {string|Date} params.from - Start of berth assignment (ISO timestamp)
 * @param {string|Date} params.to - End of berth assignment (ISO timestamp)
 * @param {number} [params.rate=DEFAULT_RATE_PER_METER_HOUR] - Tariff per meter-hour
 * @returns {object} Charge object with line items and total
 * @throws {TypeError} If inputs are invalid
 * @throws {RangeError} If from >= to or lengthM <= 0
 */
function calculateDues(params) {
  if (!params || typeof params !== 'object') {
    throw new TypeError('params must be an object');
  }

  const { lengthM, from, to, rate = DEFAULT_RATE_PER_METER_HOUR } = params;

  if (typeof lengthM !== 'number' || !Number.isFinite(lengthM) || lengthM <= 0) {
    throw new TypeError('lengthM must be a positive number');
  }

  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
    throw new TypeError('rate must be a non-negative number');
  }

  const hoursAlong = hoursElapsed(from, to);
  const totalCharge = lengthM * hoursAlong * rate;

  return {
    lengthM,
    hoursAlongside: Math.round(hoursAlong * 100) / 100, // Round to 2 decimals
    ratePerMeterHour: rate,
    totalChargeCurrency: Math.round(totalCharge * 100) / 100, // Round to 2 decimals
    breakdown: `${lengthM}m × ${Math.round(hoursAlong * 100) / 100}h × ${rate} = ${Math.round(totalCharge * 100) / 100}`,
  };
}

module.exports = {
  DEFAULT_RATE_PER_METER_HOUR,
  hoursElapsed,
  calculateDues,
};
