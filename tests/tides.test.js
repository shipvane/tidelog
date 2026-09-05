'use strict';

const {
  DEFAULT_SAFETY_MARGIN_M,
  requiredTideHeight,
  heightAt,
  isSafeAt,
  safeWindows,
  describeWindowStart,
} = require('../lib/tides');

/** Hourly ramp: 0m at 00:00 rising to 3m at 03:00, back to 0m at 06:00. */
const RAMP_TABLE = [
  { time: '2026-03-01T00:00:00Z', heightM: 0 },
  { time: '2026-03-01T01:00:00Z', heightM: 1 },
  { time: '2026-03-01T02:00:00Z', heightM: 2 },
  { time: '2026-03-01T03:00:00Z', heightM: 3 },
  { time: '2026-03-01T04:00:00Z', heightM: 2 },
  { time: '2026-03-01T05:00:00Z', heightM: 1 },
  { time: '2026-03-01T06:00:00Z', heightM: 0 },
];

describe('requiredTideHeight', () => {
  test('is draft plus margin minus channel depth', () => {
    expect(requiredTideHeight({ draftM: 6.5, channelDepthM: 6, safetyMarginM: 0.5 })).toBeCloseTo(
      1.0
    );
  });

  test('applies the default 0.5m safety margin', () => {
    expect(requiredTideHeight({ draftM: 6.5, channelDepthM: 6 })).toBeCloseTo(
      6.5 + DEFAULT_SAFETY_MARGIN_M - 6
    );
  });

  test('can be negative when the channel is deep enough at any tide', () => {
    expect(requiredTideHeight({ draftM: 3, channelDepthM: 6, safetyMarginM: 0.5 })).toBeLessThan(0);
  });

  test('rejects a non-positive draft', () => {
    expect(() => requiredTideHeight({ draftM: 0, channelDepthM: 6 })).toThrow(TypeError);
    expect(() => requiredTideHeight({ draftM: -2, channelDepthM: 6 })).toThrow(TypeError);
  });

  test('rejects a negative safety margin', () => {
    expect(() => requiredTideHeight({ draftM: 6, channelDepthM: 6, safetyMarginM: -0.1 })).toThrow(
      TypeError
    );
  });
});

describe('heightAt', () => {
  test('returns exact table values at entry times', () => {
    expect(heightAt(RAMP_TABLE, '2026-03-01T03:00:00Z')).toBe(3);
    expect(heightAt(RAMP_TABLE, '2026-03-01T06:00:00Z')).toBe(0);
  });

  test('linearly interpolates between entries', () => {
    expect(heightAt(RAMP_TABLE, '2026-03-01T00:30:00Z')).toBeCloseTo(0.5);
    expect(heightAt(RAMP_TABLE, '2026-03-01T04:45:00Z')).toBeCloseTo(1.25);
  });

  test('accepts entries in unsorted order', () => {
    const shuffled = [RAMP_TABLE[3], RAMP_TABLE[0], RAMP_TABLE[6], ...RAMP_TABLE.slice(1, 3)];
    expect(heightAt(shuffled, '2026-03-01T02:30:00Z')).toBeCloseTo(2.5);
  });

  test('throws outside the table span', () => {
    expect(() => heightAt(RAMP_TABLE, '2026-02-28T23:59:00Z')).toThrow(RangeError);
    expect(() => heightAt(RAMP_TABLE, '2026-03-01T06:00:01Z')).toThrow(RangeError);
  });

  test('throws on a table with fewer than two entries', () => {
    expect(() => heightAt([RAMP_TABLE[0]], '2026-03-01T00:00:00Z')).toThrow(RangeError);
  });

  test('throws on an entry with a bad height', () => {
    const broken = [
      { time: '2026-03-01T00:00:00Z', heightM: 'high' },
      { time: '2026-03-01T01:00:00Z', heightM: 1 },
    ];
    expect(() => heightAt(broken, '2026-03-01T00:30:00Z')).toThrow(TypeError);
  });
});

describe('isSafeAt', () => {
  const constraints = { draftM: 6.5, channelDepthM: 6, safetyMarginM: 0.5 }; // needs 1.0m

  test('true when interpolated height meets the requirement', () => {
    expect(isSafeAt(RAMP_TABLE, '2026-03-01T03:00:00Z', constraints)).toBe(true);
  });

  test('false when the tide is too low', () => {
    expect(isSafeAt(RAMP_TABLE, '2026-03-01T00:15:00Z', constraints)).toBe(false);
  });

  test('treats exactly-required height as safe', () => {
    expect(isSafeAt(RAMP_TABLE, '2026-03-01T01:00:00Z', constraints)).toBe(true);
  });
});

describe('safeWindows', () => {
  test('finds a single window with exact crossing boundaries', () => {
    const windows = safeWindows(RAMP_TABLE, {
      draftM: 6.5,
      channelDepthM: 6,
      safetyMarginM: 0.5,
    }); // requires 1.0m -> safe between 01:00 and 05:00
    expect(windows).toEqual([
      {
        start: '2026-03-01T01:00:00.000Z',
        end: '2026-03-01T05:00:00.000Z',
        durationMinutes: 240,
      },
    ]);
  });

  test('solves crossings that fall between table entries', () => {
    const windows = safeWindows(RAMP_TABLE, {
      draftM: 7,
      channelDepthM: 6,
      safetyMarginM: 0.5,
    }); // requires 1.5m -> crossings at 01:30 and 04:30
    expect(windows).toHaveLength(1);
    expect(windows[0].start).toBe('2026-03-01T01:30:00.000Z');
    expect(windows[0].end).toBe('2026-03-01T04:30:00.000Z');
    expect(windows[0].durationMinutes).toBe(180);
  });

  test('returns the whole span when the requirement is always met', () => {
    const windows = safeWindows(RAMP_TABLE, { draftM: 3, channelDepthM: 6, safetyMarginM: 0.5 });
    expect(windows).toEqual([
      {
        start: '2026-03-01T00:00:00.000Z',
        end: '2026-03-01T06:00:00.000Z',
        durationMinutes: 360,
      },
    ]);
  });

  test('returns no windows when the requirement is never met', () => {
    expect(safeWindows(RAMP_TABLE, { draftM: 12, channelDepthM: 6, safetyMarginM: 0.5 })).toEqual(
      []
    );
  });

  test('finds multiple windows across two tide cycles', () => {
    const twoCycles = [
      ...RAMP_TABLE,
      { time: '2026-03-01T07:00:00Z', heightM: 1 },
      { time: '2026-03-01T08:00:00Z', heightM: 2 },
      { time: '2026-03-01T09:00:00Z', heightM: 3 },
      { time: '2026-03-01T10:00:00Z', heightM: 2 },
      { time: '2026-03-01T11:00:00Z', heightM: 1 },
      { time: '2026-03-01T12:00:00Z', heightM: 0 },
    ];
    const windows = safeWindows(twoCycles, { draftM: 7, channelDepthM: 6, safetyMarginM: 0.5 });
    expect(windows).toHaveLength(2);
    expect(windows[0].start).toBe('2026-03-01T01:30:00.000Z');
    expect(windows[1].start).toBe('2026-03-01T07:30:00.000Z');
    expect(windows[1].end).toBe('2026-03-01T10:30:00.000Z');
  });

  test('handles a table that starts inside a safe period', () => {
    const highStart = RAMP_TABLE.slice(2); // starts at 2m, falling later
    const windows = safeWindows(highStart, { draftM: 7, channelDepthM: 6, safetyMarginM: 0.5 });
    expect(windows).toHaveLength(1);
    expect(windows[0].start).toBe('2026-03-01T02:00:00.000Z');
    expect(windows[0].end).toBe('2026-03-01T04:30:00.000Z');
  });

  test('rejects an invalid tide table', () => {
    expect(() => safeWindows([], { draftM: 6, channelDepthM: 6 })).toThrow(RangeError);
    expect(() =>
      safeWindows(
        [
          { time: 'not-a-date', heightM: 1 },
          { time: '2026-03-01T01:00:00Z', heightM: 2 },
        ],
        { draftM: 6, channelDepthM: 6 }
      )
    ).toThrow(TypeError);
  });
});

describe('describeWindowStart', () => {
  const referenceTime = '2026-03-01T12:00:00Z';

  test('returns a countdown for a window opening in the future', () => {
    const window = { start: '2026-03-01T14:00:00Z', end: '2026-03-01T15:00:00Z' };
    const description = describeWindowStart(window, referenceTime);
    expect(description).toBe('in 2 hours');
  });

  test('returns a past countdown for a window that already opened', () => {
    const window = { start: '2026-03-01T10:00:00Z', end: '2026-03-01T11:00:00Z' };
    const description = describeWindowStart(window, referenceTime);
    expect(description).toBe('2 hours ago');
  });

  test('handles minutes in the future', () => {
    const window = { start: '2026-03-01T12:25:00Z', end: '2026-03-01T13:00:00Z' };
    const description = describeWindowStart(window, referenceTime);
    expect(description).toBe('in 25 minutes');
  });

  test('handles minutes in the past', () => {
    const window = { start: '2026-03-01T11:35:00Z', end: '2026-03-01T12:00:00Z' };
    const description = describeWindowStart(window, referenceTime);
    expect(description).toBe('25 minutes ago');
  });

  test('throws for missing window object', () => {
    expect(() => describeWindowStart(null, referenceTime)).toThrow(TypeError);
    expect(() => describeWindowStart(undefined, referenceTime)).toThrow(TypeError);
  });

  test('throws for window without start property', () => {
    const window = { end: '2026-03-01T15:00:00Z' };
    expect(() => describeWindowStart(window, referenceTime)).toThrow(TypeError);
  });
});
