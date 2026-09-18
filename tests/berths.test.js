'use strict';

const {
  overlaps,
  fitsBerth,
  qualifiesForRafting,
  countOccupants,
  hasConflict,
  findBerth,
  occupantAt,
  occupantsAt,
} = require('../lib/berths');

const BERTHS = [
  { id: 'B1', name: 'Quayside North', lengthM: 90, depthM: 7.5, outOfService: false },
  { id: 'B2', name: 'Quayside South', lengthM: 120, depthM: 9.0, outOfService: false },
  {
    id: 'B6',
    name: "Fisherman's Wharf",
    lengthM: 30,
    depthM: 3.5,
    outOfService: false,
    rafting: { enabled: true, maxVessels: 2, maxLengthM: 20 },
  },
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

describe('qualifiesForRafting', () => {
  const raftingBerth = BERTHS[2]; // B6 with rafting enabled
  const nonRaftingBerth = BERTHS[0]; // B1 without rafting

  test('returns false for a berth without rafting configured', () => {
    expect(qualifiesForRafting(nonRaftingBerth, { lengthM: 15, draftM: 2 })).toBe(false);
  });

  test('returns false for a berth with rafting disabled', () => {
    const disabledBerth = {
      ...raftingBerth,
      rafting: { ...raftingBerth.rafting, enabled: false },
    };
    expect(qualifiesForRafting(disabledBerth, { lengthM: 15, draftM: 2 })).toBe(false);
  });

  test('returns true for a vessel under the rafting length limit', () => {
    expect(qualifiesForRafting(raftingBerth, { lengthM: 19, draftM: 2 })).toBe(true);
  });

  test('returns true for a vessel exactly at the rafting length limit', () => {
    expect(qualifiesForRafting(raftingBerth, { lengthM: 20, draftM: 2 })).toBe(true);
  });

  test('returns false for a vessel exceeding the rafting length limit', () => {
    expect(qualifiesForRafting(raftingBerth, { lengthM: 21, draftM: 2 })).toBe(false);
  });
});

describe('countOccupants', () => {
  const assignments = [
    assignment('B1', '2026-03-01T08:00:00Z', '2026-03-01T16:00:00Z', 'Selkie'),
    assignment('B1', '2026-03-01T09:00:00Z', '2026-03-01T15:00:00Z', 'Marlin'),
    assignment('B2', '2026-03-01T08:00:00Z', '2026-03-01T16:00:00Z', 'Tarn'),
  ];

  test('counts occupants overlapping a given window', () => {
    expect(countOccupants(assignments, 'B1', '2026-03-01T10:00:00Z', '2026-03-01T12:00:00Z')).toBe(
      2
    );
  });

  test('returns zero when no assignments overlap', () => {
    expect(countOccupants(assignments, 'B1', '2026-03-01T17:00:00Z', '2026-03-01T20:00:00Z')).toBe(
      0
    );
  });

  test('ignores other berths', () => {
    expect(countOccupants(assignments, 'B2', '2026-03-01T10:00:00Z', '2026-03-01T12:00:00Z')).toBe(
      1
    );
  });

  test('counts partial overlaps', () => {
    expect(countOccupants(assignments, 'B1', '2026-03-01T15:30:00Z', '2026-03-01T17:00:00Z')).toBe(
      1
    );
  });
});

describe('hasConflict', () => {
  const assignments = [
    assignment('B1', '2026-03-01T08:00:00Z', '2026-03-01T16:00:00Z'),
    assignment('B2', '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z'),
  ];

  test('flags an overlapping window on a non-rafting berth', () => {
    const berth = BERTHS[0]; // Non-rafting
    expect(
      hasConflict(assignments, 'B1', '2026-03-01T14:00:00Z', '2026-03-01T20:00:00Z', berth)
    ).toBe(true);
  });

  test('ignores overlaps on other berths', () => {
    const berth = BERTHS[0];
    expect(
      hasConflict(assignments, 'B6', '2026-03-01T14:00:00Z', '2026-03-01T20:00:00Z', berth)
    ).toBe(false);
  });

  test('allows a back-to-back stay on the same non-rafting berth', () => {
    const berth = BERTHS[0];
    expect(
      hasConflict(assignments, 'B1', '2026-03-01T16:00:00Z', '2026-03-01T20:00:00Z', berth)
    ).toBe(false);
  });

  test('returns true when rafting berth already has max occupants', () => {
    const raftingBerth = BERTHS[2]; // B6 with maxVessels: 2
    const raftAssignments = [
      assignment('B6', '2026-03-01T08:00:00Z', '2026-03-01T16:00:00Z', 'Vessel1'),
      assignment('B6', '2026-03-01T09:00:00Z', '2026-03-01T15:00:00Z', 'Vessel2'),
    ];
    expect(
      hasConflict(
        raftAssignments,
        'B6',
        '2026-03-01T10:00:00Z',
        '2026-03-01T12:00:00Z',
        raftingBerth
      )
    ).toBe(true);
  });

  test('returns false when rafting berth has room for another vessel', () => {
    const raftingBerth = BERTHS[2]; // B6 with maxVessels: 2
    const oneOccupant = [
      assignment('B6', '2026-03-01T08:00:00Z', '2026-03-01T16:00:00Z', 'Vessel1'),
    ];
    expect(
      hasConflict(oneOccupant, 'B6', '2026-03-01T10:00:00Z', '2026-03-01T12:00:00Z', raftingBerth)
    ).toBe(false);
  });

  test('handles old-style hasConflict calls without berth parameter (backwards compat)', () => {
    // When berth is not provided, defaults to non-rafting behavior
    expect(hasConflict(assignments, 'B1', '2026-03-01T14:00:00Z', '2026-03-01T20:00:00Z')).toBe(
      true
    );
  });
});

describe('findBerth', () => {
  const window = { from: '2026-03-01T08:00:00Z', to: '2026-03-01T18:00:00Z' };

  test('prefers the snuggest fitting berth', () => {
    const berth = findBerth(BERTHS, [], { lengthM: 18, draftM: 3 }, window);
    expect(berth.id).toBe('B6');
  });

  test('allows a vessel that qualifies for rafting even if longer than typical small craft', () => {
    // 25m doesn't qualify for rafting (maxLengthM=20), but can use B6 alone
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

  test('skips out-of-service berths', () => {
    const berthsWithMaint = [...BERTHS.slice(0, 2), { ...BERTHS[2], outOfService: true }];
    const berth = findBerth(berthsWithMaint, [], { lengthM: 18, draftM: 3 }, window);
    expect(berth.id).toBe('B1');
  });

  test('returns null when all fitting berths are out of service', () => {
    const berthsWithMaint = [
      { ...BERTHS[0], outOfService: true },
      { ...BERTHS[1], outOfService: true },
      { ...BERTHS[2], outOfService: true },
    ];
    const berth = findBerth(berthsWithMaint, [], { lengthM: 25, draftM: 3 }, window);
    expect(berth).toBeNull();
  });

  test('allows a second qualifying vessel at a rafting berth if first is small enough', () => {
    const taken = [
      assignment('B6', '2026-03-01T08:00:00Z', '2026-03-01T18:00:00Z', 'Small Vessel'),
    ];
    // Second vessel under 20m should be allowed to raft
    const berth = findBerth(BERTHS, taken, { lengthM: 18, draftM: 2.5 }, window);
    expect(berth.id).toBe('B6');
  });

  test('rejects a second vessel at rafting berth if it exceeds length limit', () => {
    const taken = [
      assignment('B6', '2026-03-01T08:00:00Z', '2026-03-01T18:00:00Z', 'Small Vessel'),
    ];
    // Second vessel over 20m should not be allowed at B6 if already occupied
    const berth = findBerth(BERTHS, taken, { lengthM: 21, draftM: 2.5 }, window);
    expect(berth.id).toBe('B1');
  });

  test('rejects a third vessel at a rafting berth with maxVessels=2', () => {
    const taken = [
      assignment('B6', '2026-03-01T08:00:00Z', '2026-03-01T18:00:00Z', 'Vessel1'),
      assignment('B6', '2026-03-01T10:00:00Z', '2026-03-01T16:00:00Z', 'Vessel2'),
    ];
    // Third vessel should be rejected at B6 and assigned elsewhere
    const berth = findBerth(BERTHS, taken, { lengthM: 18, draftM: 2.5 }, window);
    expect(berth.id).toBe('B1');
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

describe('occupantsAt', () => {
  const assignments = [
    assignment('B1', '2026-03-01T08:00:00Z', '2026-03-01T16:00:00Z', 'Selkie'),
    assignment('B1', '2026-03-01T09:00:00Z', '2026-03-01T15:00:00Z', 'Marlin'),
    assignment('B2', '2026-03-01T08:00:00Z', '2026-03-01T16:00:00Z', 'Tarn'),
  ];

  test('returns all occupants at a given time', () => {
    const occupants = occupantsAt(assignments, 'B1', '2026-03-01T12:00:00Z');
    expect(occupants).toHaveLength(2);
    expect(occupants.map((o) => o.vesselName)).toContain('Selkie');
    expect(occupants.map((o) => o.vesselName)).toContain('Marlin');
  });

  test('returns a single occupant when only one overlaps', () => {
    // Selkie: 08:00-16:00, Marlin: 09:00-15:00
    // At 16:30, only Marlin is no longer there (09:00-15:00 ends at 15:00)
    // At 15:30, Selkie is still there (08:00-16:00)
    // At 08:30, only Selkie is there (Marlin starts at 09:00)
    const occupants = occupantsAt(assignments, 'B1', '2026-03-01T08:30:00Z');
    expect(occupants).toHaveLength(1);
    expect(occupants[0].vesselName).toBe('Selkie');
  });

  test('returns empty array when berth is vacant', () => {
    expect(occupantsAt(assignments, 'B1', '2026-03-01T17:00:00Z')).toEqual([]);
    expect(occupantsAt(assignments, 'B2', '2026-03-01T17:00:00Z')).toEqual([]);
  });

  test('treats the departure instant as vacant', () => {
    expect(occupantsAt(assignments, 'B1', '2026-03-01T16:00:00Z')).toEqual([]);
  });

  test('respects berth filter (does not return occupants from other berths)', () => {
    const occupants = occupantsAt(assignments, 'B2', '2026-03-01T12:00:00Z');
    expect(occupants).toHaveLength(1);
    expect(occupants[0].vesselName).toBe('Tarn');
  });
});
