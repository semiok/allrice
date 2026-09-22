import { describe, expect, it } from 'vitest';
import {
  mergeIntervals,
  subtractIntervals,
  totalDurationMs,
  isTimeInIntervals,
  resolveEffectiveTimeoutMs,
} from './runtime-timing.ts';

describe('runtime-timing interval arithmetic', () => {
  it('merges overlapping and adjacent intervals', () => {
    expect(mergeIntervals([])).toEqual([]);
    expect(
      mergeIntervals([
        { start: 10, end: 20 },
        { start: 15, end: 25 },
      ]),
    ).toEqual([{ start: 10, end: 25 }]);

    expect(
      mergeIntervals([
        { start: 10, end: 20 },
        { start: 20, end: 30 },
      ]),
    ).toEqual([{ start: 10, end: 30 }]);

    expect(
      mergeIntervals([
        { start: 30, end: 40 },
        { start: 10, end: 20 },
      ]),
    ).toEqual([
      { start: 10, end: 20 },
      { start: 30, end: 40 },
    ]);
  });

  it('subtracts non-overlapping intervals correctly', () => {
    const sources = [{ start: 10, end: 30 }];
    const toSubtract = [{ start: 40, end: 50 }];
    expect(subtractIntervals(sources, toSubtract)).toEqual([
      { start: 10, end: 30 },
    ]);
  });

  it('subtracts internal slice creating two sub-intervals', () => {
    const sources = [{ start: 10, end: 30 }];
    const toSubtract = [{ start: 15, end: 20 }];
    expect(subtractIntervals(sources, toSubtract)).toEqual([
      { start: 10, end: 15 },
      { start: 20, end: 30 },
    ]);
    expect(totalDurationMs(subtractIntervals(sources, toSubtract))).toBe(15);
  });

  it('subtracts prefix and suffix overlaps', () => {
    const sources = [{ start: 10, end: 30 }];
    expect(subtractIntervals(sources, [{ start: 5, end: 15 }])).toEqual([
      { start: 15, end: 30 },
    ]);
    expect(subtractIntervals(sources, [{ start: 25, end: 35 }])).toEqual([
      { start: 10, end: 25 },
    ]);
  });

  it('completely subtracts when subtraction covers source', () => {
    const sources = [{ start: 10, end: 30 }];
    expect(subtractIntervals(sources, [{ start: 5, end: 35 }])).toEqual([]);
  });

  it('handles parallel approvals and running branches correctly', () => {
    // Approval 1: [10, 20], Approval 2: [15, 25] -> Wait union [10, 25]
    const waitIntervals = [
      { start: 10, end: 20 },
      { start: 15, end: 25 },
    ];
    const mergedWait = mergeIntervals(waitIntervals);
    expect(mergedWait).toEqual([{ start: 10, end: 25 }]);

    // Branch B was running during [10, 15]
    const active = [{ start: 0, end: 15 }];
    const suspended = subtractIntervals(mergedWait, active);
    expect(suspended).toEqual([{ start: 15, end: 25 }]);
    expect(totalDurationMs(suspended)).toBe(10);
  });

  it('checks if a timestamp falls within intervals', () => {
    const intervals = [
      { start: 10, end: 20 },
      { start: 30, end: 40 },
    ];
    expect(isTimeInIntervals(intervals, 15)).toBe(true);
    expect(isTimeInIntervals(intervals, 10)).toBe(true);
    expect(isTimeInIntervals(intervals, 20)).toBe(true);
    expect(isTimeInIntervals(intervals, 25)).toBe(false);
    expect(isTimeInIntervals(intervals, 5)).toBe(false);
  });
});

describe('resolveEffectiveTimeoutMs', () => {
  it('retains default 1 hour when no tenant limit is configured', () => {
    expect(
      resolveEffectiveTimeoutMs({
        baseTimeoutMs: 3_600_000,
      }),
    ).toBe(3_600_000);
  });

  it('applies tighter tenant limit (30 min) over 1 hour default', () => {
    expect(
      resolveEffectiveTimeoutMs({
        baseTimeoutMs: 3_600_000,
        tenantMaxRuntimeMs: 1_800_000,
      }),
    ).toBe(1_800_000);
  });

  it('allows unlimited (0) when tenant configures 0', () => {
    expect(
      resolveEffectiveTimeoutMs({
        baseTimeoutMs: 3_600_000,
        tenantMaxRuntimeMs: 0,
      }),
    ).toBe(0);
  });

  it('allows employee or user tighter limits', () => {
    expect(
      resolveEffectiveTimeoutMs({
        baseTimeoutMs: 3_600_000,
        tenantMaxRuntimeMs: 1_800_000,
        employeeMaxRuntimeMs: 900_000,
      }),
    ).toBe(900_000);

    expect(
      resolveEffectiveTimeoutMs({
        baseTimeoutMs: 3_600_000,
        tenantMaxRuntimeMs: 0,
        userMaxRuntimeMs: 600_000,
      }),
    ).toBe(600_000);
  });
});
