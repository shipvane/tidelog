'use strict';

const { escapeCsvField, toCsvRow, arrivalsToCsv, ARRIVALS_HEADERS } = require('../lib/csv');

describe('escapeCsvField', () => {
  test('returns an empty string for null and undefined', () => {
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });

  test('returns plain values unchanged', () => {
    expect(escapeCsvField('hello')).toBe('hello');
    expect(escapeCsvField(42)).toBe('42');
    expect(escapeCsvField(3.14)).toBe('3.14');
  });

  test('wraps a field containing a comma in double-quotes', () => {
    expect(escapeCsvField('hello, world')).toBe('"hello, world"');
  });

  test('wraps a field containing a double-quote and escapes it by doubling', () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  test('wraps a field containing a newline', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
  });

  test('wraps a field containing a carriage return', () => {
    expect(escapeCsvField('line1\rline2')).toBe('"line1\rline2"');
  });
});

describe('toCsvRow', () => {
  test('joins plain fields with commas', () => {
    expect(toCsvRow(['a', 'b', 'c'])).toBe('a,b,c');
  });

  test('correctly escapes a mixed row', () => {
    expect(toCsvRow(['MV Northern Star', 'cargo', '85', null])).toBe('MV Northern Star,cargo,85,');
  });

  test('handles a vessel name that contains a comma', () => {
    expect(toCsvRow(['Star, MV', 'cargo'])).toBe('"Star, MV",cargo');
  });
});

describe('arrivalsToCsv', () => {
  const baseArrival = {
    id: 'ARR-001',
    vesselName: 'MV Northern Star',
    vesselType: 'cargo',
    lengthM: 85,
    draftM: 6.2,
    imo: 'IMO 9319466',
    eta: '2026-03-01T14:00:00.000Z',
    status: 'expected',
    berth: null,
    loggedAt: '2026-03-01T04:00:00.000Z',
    arrivedAt: undefined,
  };

  test('produces a header row followed by one data row', () => {
    const csv = arrivalsToCsv([baseArrival]);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(ARRIVALS_HEADERS.join(','));
  });

  test('header row contains exactly the expected column names', () => {
    const csv = arrivalsToCsv([]);
    const [header] = csv.split('\r\n');
    expect(header).toBe(
      'id,vesselName,vesselType,lengthM,draftM,imo,eta,status,berthId,berthFrom,berthTo,loggedAt,arrivedAt'
    );
  });

  test('data row fields match the arrival values', () => {
    const csv = arrivalsToCsv([baseArrival]);
    const [, dataRow] = csv.split('\r\n');
    expect(dataRow).toBe(
      'ARR-001,MV Northern Star,cargo,85,6.2,IMO 9319466,2026-03-01T14:00:00.000Z,expected,,,,2026-03-01T04:00:00.000Z,'
    );
  });

  test('emits berth columns when a berth assignment is present', () => {
    const arrived = {
      ...baseArrival,
      status: 'arrived',
      arrivedAt: '2026-03-01T15:30:00.000Z',
      berth: {
        berthId: 'B1',
        from: '2026-03-01T14:00:00.000Z',
        to: '2026-03-01T22:00:00.000Z',
      },
    };
    const csv = arrivalsToCsv([arrived]);
    const [, dataRow] = csv.split('\r\n');
    expect(dataRow).toContain('B1');
    expect(dataRow).toContain('2026-03-01T14:00:00.000Z');
    expect(dataRow).toContain('2026-03-01T22:00:00.000Z');
    expect(dataRow).toContain('2026-03-01T15:30:00.000Z');
  });

  test('returns only the header row when the log is empty', () => {
    const csv = arrivalsToCsv([]);
    expect(csv).toBe(ARRIVALS_HEADERS.join(','));
  });

  test('correctly escapes a vessel name that contains a comma', () => {
    const tricky = {
      ...baseArrival,
      vesselName: 'Star, MV',
    };
    const csv = arrivalsToCsv([tricky]);
    const [, dataRow] = csv.split('\r\n');
    expect(dataRow).toMatch(/^ARR-001,"Star, MV",/);
  });

  test('correctly escapes a vessel name that contains a double-quote', () => {
    const tricky = {
      ...baseArrival,
      vesselName: 'MV "Lucky"',
    };
    const csv = arrivalsToCsv([tricky]);
    const [, dataRow] = csv.split('\r\n');
    expect(dataRow).toMatch(/^ARR-001,"MV ""Lucky""",/);
  });

  test('uses CRLF line endings (RFC 4180)', () => {
    const csv = arrivalsToCsv([baseArrival]);
    expect(csv).toContain('\r\n');
    // No bare LF line endings
    expect(csv.replace(/\r\n/g, '')).not.toContain('\n');
  });
});
