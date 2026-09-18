'use strict';

const { DEFAULT_RATE_PER_METER_HOUR, hoursElapsed, calculateDues } = require('../lib/dues');

describe('lib/dues', () => {
  describe('hoursElapsed', () => {
    test('calculates hours between two ISO timestamps', () => {
      const from = '2026-03-01T10:00:00Z';
      const to = '2026-03-01T14:00:00Z';
      expect(hoursElapsed(from, to)).toBe(4);
    });

    test('handles fractional hours', () => {
      const from = '2026-03-01T10:00:00Z';
      const to = '2026-03-01T10:30:00Z';
      expect(hoursElapsed(from, to)).toBe(0.5);
    });

    test('accepts Date objects', () => {
      const from = new Date('2026-03-01T10:00:00Z');
      const to = new Date('2026-03-01T12:00:00Z');
      expect(hoursElapsed(from, to)).toBe(2);
    });

    test('accepts mixed Date and ISO timestamps', () => {
      const from = new Date('2026-03-01T10:00:00Z');
      const to = '2026-03-01T12:00:00Z';
      expect(hoursElapsed(from, to)).toBe(2);
    });

    test('throws RangeError when from >= to', () => {
      const same = '2026-03-01T10:00:00Z';
      expect(() => hoursElapsed(same, same)).toThrow(RangeError);
      expect(() => hoursElapsed(same, same)).toThrow('from must be before to');

      const inverted = {
        from: '2026-03-01T14:00:00Z',
        to: '2026-03-01T10:00:00Z',
      };
      expect(() => hoursElapsed(inverted.from, inverted.to)).toThrow(RangeError);
    });

    test('throws TypeError for invalid from timestamp', () => {
      expect(() => hoursElapsed('invalid', '2026-03-01T12:00:00Z')).toThrow(TypeError);
      expect(() => hoursElapsed('invalid', '2026-03-01T12:00:00Z')).toThrow(
        /from is not a valid date/
      );
    });

    test('throws TypeError for invalid to timestamp', () => {
      expect(() => hoursElapsed('2026-03-01T10:00:00Z', 'invalid')).toThrow(TypeError);
      expect(() => hoursElapsed('2026-03-01T10:00:00Z', 'invalid')).toThrow(
        /to is not a valid date/
      );
    });
  });

  describe('calculateDues', () => {
    test('calculates dues with standard default rate', () => {
      const charge = calculateDues({
        lengthM: 100,
        from: '2026-03-01T10:00:00Z',
        to: '2026-03-01T14:00:00Z',
      });

      expect(charge).toMatchObject({
        lengthM: 100,
        hoursAlongside: 4,
        ratePerMeterHour: DEFAULT_RATE_PER_METER_HOUR,
        totalChargeCurrency: 100 * 4 * DEFAULT_RATE_PER_METER_HOUR,
      });
      expect(charge.breakdown).toBeDefined();
      expect(typeof charge.breakdown).toBe('string');
    });

    test('uses custom rate when provided', () => {
      const charge = calculateDues({
        lengthM: 50,
        from: '2026-03-01T10:00:00Z',
        to: '2026-03-01T12:00:00Z',
        rate: 25,
      });

      expect(charge.ratePerMeterHour).toBe(25);
      expect(charge.totalChargeCurrency).toBe(50 * 2 * 25);
    });

    test('rounds hours and totals to 2 decimal places', () => {
      const charge = calculateDues({
        lengthM: 100,
        from: '2026-03-01T10:00:00Z',
        to: '2026-03-01T10:20:00Z', // 0.3333... hours
      });

      expect(charge.hoursAlongside).toBe(0.33);
      expect(Number.isFinite(charge.totalChargeCurrency)).toBe(true);
      // Should be 100 * 0.3333... * 10 ≈ 333.33
      expect(charge.totalChargeCurrency).toBeCloseTo(333.33, 2);
    });

    test('includes breakdown string with calculation', () => {
      const charge = calculateDues({
        lengthM: 120,
        from: '2026-03-01T14:00:00Z',
        to: '2026-03-01T18:00:00Z',
        rate: 15,
      });

      expect(charge.breakdown).toBe('120m × 4h × 15 = 7200');
    });

    test('returns zero charge for zero rate', () => {
      const charge = calculateDues({
        lengthM: 100,
        from: '2026-03-01T10:00:00Z',
        to: '2026-03-01T12:00:00Z',
        rate: 0,
      });

      expect(charge.totalChargeCurrency).toBe(0);
    });

    test('handles fractional vessel length', () => {
      const charge = calculateDues({
        lengthM: 85.5,
        from: '2026-03-01T10:00:00Z',
        to: '2026-03-01T11:00:00Z',
        rate: 10,
      });

      expect(charge.lengthM).toBe(85.5);
      expect(charge.totalChargeCurrency).toBe(855); // 85.5 * 1 * 10
    });

    test('throws TypeError when params is not an object', () => {
      expect(() => calculateDues(null)).toThrow(TypeError);
      expect(() => calculateDues(undefined)).toThrow(TypeError);
      expect(() => calculateDues('not an object')).toThrow(TypeError);
    });

    test('throws TypeError when lengthM is invalid', () => {
      expect(() =>
        calculateDues({
          lengthM: 'invalid',
          from: '2026-03-01T10:00:00Z',
          to: '2026-03-01T12:00:00Z',
        })
      ).toThrow(TypeError);
      expect(() =>
        calculateDues({
          lengthM: -50,
          from: '2026-03-01T10:00:00Z',
          to: '2026-03-01T12:00:00Z',
        })
      ).toThrow(TypeError);
      expect(() =>
        calculateDues({
          lengthM: 0,
          from: '2026-03-01T10:00:00Z',
          to: '2026-03-01T12:00:00Z',
        })
      ).toThrow(TypeError);
      expect(() =>
        calculateDues({
          lengthM: NaN,
          from: '2026-03-01T10:00:00Z',
          to: '2026-03-01T12:00:00Z',
        })
      ).toThrow(TypeError);
    });

    test('throws TypeError when rate is invalid', () => {
      expect(() =>
        calculateDues({
          lengthM: 100,
          from: '2026-03-01T10:00:00Z',
          to: '2026-03-01T12:00:00Z',
          rate: 'invalid',
        })
      ).toThrow(TypeError);
      expect(() =>
        calculateDues({
          lengthM: 100,
          from: '2026-03-01T10:00:00Z',
          to: '2026-03-01T12:00:00Z',
          rate: -10,
        })
      ).toThrow(TypeError);
    });

    test('throws TypeError when timestamps are invalid', () => {
      expect(() =>
        calculateDues({
          lengthM: 100,
          from: 'invalid',
          to: '2026-03-01T12:00:00Z',
        })
      ).toThrow(TypeError);

      expect(() =>
        calculateDues({
          lengthM: 100,
          from: '2026-03-01T10:00:00Z',
          to: 'invalid',
        })
      ).toThrow(TypeError);
    });

    test('throws RangeError when from >= to', () => {
      expect(() =>
        calculateDues({
          lengthM: 100,
          from: '2026-03-01T14:00:00Z',
          to: '2026-03-01T10:00:00Z',
        })
      ).toThrow(RangeError);
    });

    test('accepts Date objects for timestamps', () => {
      const from = new Date('2026-03-01T10:00:00Z');
      const to = new Date('2026-03-01T12:00:00Z');
      const charge = calculateDues({ lengthM: 100, from, to });

      expect(charge.hoursAlongside).toBe(2);
      expect(charge.totalChargeCurrency).toBe(2000); // 100 * 2 * 10
    });
  });

  describe('DEFAULT_RATE_PER_METER_HOUR', () => {
    test('is exported and is a positive number', () => {
      expect(typeof DEFAULT_RATE_PER_METER_HOUR).toBe('number');
      expect(DEFAULT_RATE_PER_METER_HOUR).toBeGreaterThan(0);
    });

    test('is used as the default in calculateDues', () => {
      const charge = calculateDues({
        lengthM: 100,
        from: '2026-03-01T10:00:00Z',
        to: '2026-03-01T11:00:00Z',
      });

      expect(charge.ratePerMeterHour).toBe(DEFAULT_RATE_PER_METER_HOUR);
      expect(charge.totalChargeCurrency).toBe(100 * DEFAULT_RATE_PER_METER_HOUR);
    });
  });
});
