'use strict';

/**
 * Minimal RFC 4180-compliant CSV utilities for the TideLog day-sheet export.
 *
 * Rules applied:
 *  - Fields containing commas, double-quotes, or newlines are wrapped in
 *    double-quotes.
 *  - Double-quotes inside a quoted field are escaped by doubling them ("").
 *  - All other fields are emitted as-is.
 */

/** CSV column headers for the arrivals day-sheet export. */
const ARRIVALS_HEADERS = [
  'id',
  'vesselName',
  'vesselType',
  'lengthM',
  'draftM',
  'imo',
  'eta',
  'status',
  'berthId',
  'berthFrom',
  'berthTo',
  'loggedAt',
  'arrivedAt',
];

/**
 * Escape a single value for CSV output.
 *
 * @param {*} value - The raw value to escape.
 * @returns {string} A safe CSV field string.
 */
function escapeCsvField(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const str = String(value);
  // Wrap in quotes if the value contains a comma, double-quote, or newline.
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Serialize an array of field values into a single CSV row string (no trailing newline).
 *
 * @param {Array<*>} fields - The values for each column.
 * @returns {string} A CSV row.
 */
function toCsvRow(fields) {
  return fields.map(escapeCsvField).join(',');
}

/**
 * Build a complete CSV document (headers + data rows) for a list of arrivals.
 *
 * Each arrival may carry an optional `berth` object (added by `withBerth`).
 *
 * @param {Array<object>} arrivals - Arrival objects, each optionally with a `berth` field.
 * @returns {string} The full CSV text, lines separated by CRLF as per RFC 4180.
 */
function arrivalsToCsv(arrivals) {
  const lines = [toCsvRow(ARRIVALS_HEADERS)];
  for (const a of arrivals) {
    const berth = a.berth || {};
    lines.push(
      toCsvRow([
        a.id,
        a.vesselName,
        a.vesselType,
        a.lengthM,
        a.draftM,
        a.imo,
        a.eta,
        a.status,
        berth.berthId,
        berth.from,
        berth.to,
        a.loggedAt,
        a.arrivedAt,
      ])
    );
  }
  return lines.join('\r\n');
}

module.exports = {
  ARRIVALS_HEADERS,
  escapeCsvField,
  toCsvRow,
  arrivalsToCsv,
};
