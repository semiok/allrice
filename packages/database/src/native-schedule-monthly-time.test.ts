import { describe, expect, it } from 'vitest';
import {
  latestMonthlyBusinessTarget,
  nextMonthlyBusinessTarget,
} from './native-schedule-monthly-time.ts';

const rule = {
  kind: 'monthly' as const,
  monthDay: 31,
  time: '02:30:45',
  timezone: 'America/New_York',
};
describe('ordinary monthly business targets', () => {
  it.each([
    ['2026-02-01T00:00:00.000Z', '2026-02-28T07:30:45.000Z'],
    ['2028-02-01T00:00:00.000Z', '2028-02-29T07:30:45.000Z'],
    ['2026-09-30T06:30:44.999Z', '2026-09-30T06:30:45.000Z'],
    ['2026-09-30T06:30:45.000Z', '2026-10-31T06:30:45.000Z'],
  ])('clamps the month and preserves seconds after %s', (after, expected) => {
    expect(nextMonthlyBusinessTarget(rule, new Date(after)).toISOString()).toBe(
      expected,
    );
  });
  it('retains the original DST gap/overlap choice, once, with seconds', () => {
    expect(
      nextMonthlyBusinessTarget(
        { ...rule, monthDay: 8 },
        new Date('2026-03-01T00:00:00.000Z'),
      ).toISOString(),
    ).toBe('2026-03-08T07:30:45.000Z');
    const overlap = { ...rule, monthDay: 1, time: '01:30:45' };
    expect(
      nextMonthlyBusinessTarget(
        overlap,
        new Date('2026-10-31T12:00:00.000Z'),
      ).toISOString(),
    ).toBe('2026-11-01T05:30:45.000Z');
    expect(
      nextMonthlyBusinessTarget(
        overlap,
        new Date('2026-11-01T05:30:45.000Z'),
      ).toISOString(),
    ).toBe('2026-12-01T06:30:45.000Z');
  });
  it('selects only the latest missed target without moving it to now', () => {
    expect(
      latestMonthlyBusinessTarget(
        rule,
        new Date('2026-10-22T12:00:00.000Z'),
      ).toISOString(),
    ).toBe('2026-09-30T06:30:45.000Z');
    expect(
      latestMonthlyBusinessTarget(
        rule,
        new Date('2026-10-31T06:30:45.000Z'),
      ).toISOString(),
    ).toBe('2026-10-31T06:30:45.000Z');
  });
});
