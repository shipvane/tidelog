'use strict';

const { VESSEL_TYPES, isValidImo, normalizeManifest } = require('../lib/manifest');

function validManifest(overrides = {}) {
  return {
    vesselName: 'MV Northern Star',
    vesselType: 'cargo',
    lengthM: 85,
    draftM: 6.2,
    imo: 'IMO 9074729',
    eta: '2026-03-01T14:00:00Z',
    ...overrides,
  };
}

describe('isValidImo', () => {
  test('accepts a valid IMO number with prefix', () => {
    expect(isValidImo('IMO 9074729')).toBe(true);
  });

  test('accepts bare digits and numeric input', () => {
    expect(isValidImo('9319466')).toBe(true);
    expect(isValidImo(9319466)).toBe(true);
  });

  test('rejects a failed checksum', () => {
    expect(isValidImo('IMO 9074728')).toBe(false);
  });

  test('rejects wrong lengths and junk', () => {
    expect(isValidImo('123456')).toBe(false);
    expect(isValidImo('12345678')).toBe(false);
    expect(isValidImo('not-an-imo')).toBe(false);
    expect(isValidImo(null)).toBe(false);
    expect(isValidImo(undefined)).toBe(false);
  });
});

describe('normalizeManifest', () => {
  test('accepts a fully valid manifest', () => {
    const result = normalizeManifest(validManifest());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.value).toMatchObject({
      vesselName: 'MV Northern Star',
      vesselType: 'cargo',
      lengthM: 85,
      draftM: 6.2,
      imo: 'IMO 9074729',
    });
  });

  test('trims and collapses whitespace in the vessel name', () => {
    const result = normalizeManifest(validManifest({ vesselName: '  MV   Northern   Star  ' }));
    expect(result.ok).toBe(true);
    expect(result.value.vesselName).toBe('MV Northern Star');
  });

  test('lower-cases the vessel type', () => {
    const result = normalizeManifest(validManifest({ vesselType: '  TANKER ' }));
    expect(result.ok).toBe(true);
    expect(result.value.vesselType).toBe('tanker');
  });

  test('rejects an unknown vessel type and lists the allowed ones', () => {
    const result = normalizeManifest(validManifest({ vesselType: 'submarine' }));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining(VESSEL_TYPES.join(', '))]);
  });

  test('coerces numeric strings for dimensions', () => {
    const result = normalizeManifest(validManifest({ lengthM: '85', draftM: '6.2' }));
    expect(result.ok).toBe(true);
    expect(result.value.lengthM).toBe(85);
    expect(result.value.draftM).toBe(6.2);
  });

  test('rejects non-positive or non-numeric dimensions', () => {
    const result = normalizeManifest(validManifest({ lengthM: -10, draftM: 'deep' }));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'lengthM must be a positive number',
        'draftM must be a positive number',
      ])
    );
  });

  test('normalizes a bare IMO to the canonical format', () => {
    const result = normalizeManifest(validManifest({ imo: '9074729' }));
    expect(result.ok).toBe(true);
    expect(result.value.imo).toBe('IMO 9074729');
  });

  test('treats a missing IMO as null (small craft have none)', () => {
    const result = normalizeManifest(validManifest({ imo: undefined }));
    expect(result.ok).toBe(true);
    expect(result.value.imo).toBeNull();
  });

  test('rejects an invalid IMO', () => {
    const result = normalizeManifest(validManifest({ imo: 'IMO 1111111' }));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining('imo')]);
  });

  test('normalizes the ETA to ISO-8601', () => {
    const result = normalizeManifest(validManifest({ eta: '2026-03-01T14:00:00+02:00' }));
    expect(result.ok).toBe(true);
    expect(result.value.eta).toBe('2026-03-01T12:00:00.000Z');
  });

  test('rejects a missing or invalid ETA', () => {
    expect(normalizeManifest(validManifest({ eta: undefined })).ok).toBe(false);
    expect(normalizeManifest(validManifest({ eta: 'whenever' })).ok).toBe(false);
  });

  test('accepts and trims an optional agent, rejecting a blank one', () => {
    const withAgent = normalizeManifest(validManifest({ agent: '  Meridian Shipping ' }));
    expect(withAgent.ok).toBe(true);
    expect(withAgent.value.agent).toBe('Meridian Shipping');

    expect(normalizeManifest(validManifest({ agent: '   ' })).ok).toBe(false);
  });

  test('collects every error at once for a badly broken manifest', () => {
    const result = normalizeManifest({});
    expect(result.ok).toBe(false);
    expect(result.value).toBeNull();
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });

  test('rejects non-object bodies outright', () => {
    for (const bad of [null, undefined, 'manifest', 42, ['a']]) {
      const result = normalizeManifest(bad);
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(['manifest body must be an object']);
    }
  });
});
