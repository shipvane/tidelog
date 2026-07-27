'use strict';

const { overlaps, fitsBerth, hasConflict, findBerth, occupantAt } = require('../lib/berths');

const BERTHS = [
  { id: 'B1', name: 'Quayside North', lengthM: 90, depthM: 7.5 },
  { id: 'B2', name: 'Quayside South', lengthM: 120, depthM: 9.0 },
  { id: 'B6', name: "Fisherman's Wharf", lengthM: 30, depthM: 3.5 },
];

function assignment(berthId, from, to, vesselName = 'Test Vessel') {
  return { berthId, arrivalId: 'ARR-900', vesselName, from, to };
}

describe('overlaps', () => {
  test('detects overlapping intervals', () => {
    expect(
      overlaps(
        '2026-03-01T08:00:00Z',
        '2026-03-01T12:00:00Z',
        '2026-03-01T10:00:00Z',
        '2026-03-01T14:00:00Z'
      )
    ).toBe(true);
  });

  test('treats touching endpoints as non-overlapping (back-to-back stays)', () => {
    expect(
      overlaps(
        '2026-03-01T08:00:00Z',
        '2026-03-01T12:00:00Z',
        '2026-03-01T12:00:00Z',
        '2026-03-01T16:00:00Z'
      )
    ).toBe(false);
  });

  test('detects full containment', () => {
    expect(
      overlaps(
        '2026-03-01T08:00:00Z',
        '2026-03-01T20:00:00Z',
        '2026-03-01T10:00:00Z',
        '2026-03-01T11:00:00Z'
      )
    ).toBe(true);
  });

  test('rejects an inverted interval', () => {
    expect(() =>
      overlaps(
        '2026-03-01T12:00:00Z',
        '2026-03-01T08:00:00Z',
        '2026-03-01T10:00:00Z',
        '2026-03-01T11:00:00Z'
      )
    ).toThrow(RangeError);
  });

  test('rejects an unparseable timestamp', () => {
    expect(() =>
      overlaps(
        'yesterday-ish',
        '2026-03-01T08:00:00Z',
        '2026-03-01T10:00:00Z',
        '2026-03-01T11:00:00Z'
      )
    ).toThrow(TypeError);
  });
});

describe('fitsBerth', () => {
  const berth = BERTHS[0]; // 90m long, 7.5m deep

  test('fits when both length and draft are within limits', () => {
    expect(fitsBerth(berth, { lengthM: 85, draftM: 6.2 })).toEqual({ fits: true, reasons: [] });
  });

  test('rejects a vessel that is too long, with a reason', () => {
    const result = fitsBerth(berth, { lengthM: 95, draftM: 6 });
    expect(result.fits).toBe(false);
    expect(result.reasons).toEqual([expect.stringContaining('length')]);
  });

  test('rejects a vessel with too much draft, with a reason', () => {
    const result = fitsBerth(berth, { lengthM: 60, draftM: 8 });
    expect(result.fits).toBe(false);
    expect(result.reasons).toEqual([expect.stringContaining('draft')]);
  });

  test('collects both reasons when nothing fits', () => {
    const result = fitsBerth(berth, { lengthM: 200, draftM: 12 });
    expect(result.fits).toBe(false);
    expect(result.reasons).toHaveLength(2);
  });

  test('allows exact boundary dimensions', () => {
    expect(fitsBerth(berth, { lengthM: 90, draftM: 7.5 }).fits).toBe(true);
  });

  test('rejects invalid vessel dimensions', () => {
    expect(() => fitsBerth(berth, { lengthM: -5, draftM: 2 })).toThrow(TypeError);
    expect(() => fitsBerth(berth, { lengthM: 20 })).toThrow(TypeError);
  });
});

describe('hasConflict', () => {
  const assignments = [
    assignment('B1', '2026-03-01T08:00:00Z', '2026-03-01T16:00:00Z'),
    assignment('B2', '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z'),
  ];

  test('flags an overlapping window on the same berth', () => {
    expect(hasConflict(assignments, 'B1', '2026-03-01T14:00:00Z', '2026-03-01T20:00:00Z')).toBe(
      true
    );
  });

  test('ignores overlaps on other berths', () => {
    expect(hasConflict(assignments, 'B6', '2026-03-01T14:00:00Z', '2026-03-01T20:00:00Z')).toBe(
      false
    );
  });

  test('allows a back-to-back stay on the same berth', () => {
    expect(hasConflict(assignments, 'B1', '2026-03-01T16:00:00Z', '2026-03-01T20:00:00Z')).toBe(
      false
    );
  });
});

describe('findBerth', () => {
  const window = { from: '2026-03-01T08:00:00Z', to: '2026-03-01T18:00:00Z' };

  test('prefers the snuggest fitting berth', () => {
    const berth = findBerth(BERTHS, [], { lengthM: 25, draftM: 3 }, window);
    expect(berth.id).toBe('B6');
  });

  test('skips berths the vessel does not fit', () => {
    const berth = findBerth(BERTHS, [], { lengthM: 100, draftM: 8.5 }, window);
    expect(berth.id).toBe('B2');
  });

  test('skips occupied berths and falls back to the next fit', () => {
    const taken = [assignment('B6', '2026-03-01T06:00:00Z', '2026-03-01T20:00:00Z')];
    const berth = findBerth(BERTHS, taken, { lengthM: 25, draftM: 3 }, window);
    expect(berth.id).toBe('B1');
  });

  test('returns null when no berth fits', () => {
    expect(findBerth(BERTHS, [], { lengthM: 300, draftM: 15 }, window)).toBeNull();
  });

  test('returns null when every fitting berth is occupied', () => {
    const taken = [
      assignment('B1', '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z'),
      assignment('B2', '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z'),
    ];
    expect(findBerth(BERTHS, taken, { lengthM: 85, draftM: 6 }, window)).toBeNull();
  });

  test('rejects an invalid window', () => {
    expect(() =>
      findBerth(BERTHS, [], { lengthM: 25, draftM: 3 }, { from: window.to, to: window.from })
    ).toThrow(RangeError);
  });
});

describe('occupantAt', () => {
  const assignments = [assignment('B1', '2026-03-01T08:00:00Z', '2026-03-01T16:00:00Z', 'Selkie')];

  test('returns the assignment covering the queried time', () => {
    const occupant = occupantAt(assignments, 'B1', '2026-03-01T12:00:00Z');
    expect(occupant).not.toBeNull();
    expect(occupant.vesselName).toBe('Selkie');
  });

  test('returns null when the berth is vacant at that time', () => {
    expect(occupantAt(assignments, 'B1', '2026-03-01T17:00:00Z')).toBeNull();
    expect(occupantAt(assignments, 'B2', '2026-03-01T12:00:00Z')).toBeNull();
  });

  test('treats the departure instant as vacant (half-open interval)', () => {
    expect(occupantAt(assignments, 'B1', '2026-03-01T16:00:00Z')).toBeNull();
  });
});
