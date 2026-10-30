import { estimateModelCostCents } from '../../model-cost.js';
import { describe, expect, it } from 'vitest';
import { projectNativeUsage } from './native-usage.js';

describe('pinned native subscription receipts', () => {
  const usage = {
    inputTokens: 10,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
    outputTokens: 7,
  };
  it('counts disjoint input once, preserving observed cache details', () => {
    expect(projectNativeUsage(usage, true, true)).toEqual({
      inputTokens: 15,
      cachedInputTokens: 3,
      outputTokens: 7,
      usageComplete: true,
      cacheUsageKnown: true,
    });
    expect(projectNativeUsage(usage, true, false).inputTokens).toBe(15);
  });
  it('preserves MET-236 subscription totals without inventing a missing cache-write bucket', () => {
    const receipt = {
      inputTokens: 37532,
      cacheReadTokens: 2708224,
      outputTokens: 10960,
    };
    expect(projectNativeUsage(receipt, true, true)).toEqual({
      inputTokens: 2745756,
      cachedInputTokens: 2708224,
      outputTokens: 10960,
      usageComplete: true,
      cacheUsageKnown: false,
    });
    expect(
      projectNativeUsage({ ...receipt, cacheWriteTokens: 0 }, true, true),
    ).toMatchObject({ inputTokens: 2745756, cacheUsageKnown: true });
  });
  it.each([
    undefined,
    null,
    {},
    { ...usage, inputTokens: -1 },
    { ...usage, inputTokens: 1.5 },
    { ...usage, cacheReadTokens: '3' },
    { ...usage, inputTokens: Number.MAX_SAFE_INTEGER },
    { ...usage, outputTokens: 0 },
    { ...usage, outputTokens: NaN },
    { inputTokens: 0, outputTokens: 0 },
  ])('keeps absent or invalid input/output unknown: %j', (value) => {
    expect(projectNativeUsage(value, true, true).usageComplete).toBe(false);
  });
  it('does not conflate missing cache detail with missing total tokens', () => {
    expect(
      projectNativeUsage({ inputTokens: 10, outputTokens: 7 }, true, true),
    ).toMatchObject({ usageComplete: true, cacheUsageKnown: false });
  });
  it('proves omitted zero cache from exact total without changing cash or subscription projection', () => {
    for (const subscription of [true, false])
      expect(
        projectNativeUsage(
          { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
          true,
          subscription,
        ),
      ).toMatchObject({
        inputTokens: 20,
        outputTokens: 5,
        cachedInputTokens: 0,
        usageComplete: true,
        cacheUsageKnown: true,
      });
  });
  it.each([
    { inputTokens: 20, outputTokens: 5, totalTokens: 28 },
    ...[null, -1, NaN, '0'].map((cacheReadTokens) => ({
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
      cacheReadTokens,
    })),
    ...[null, -1, NaN, '22', 23].map((totalTokens) => ({
      ...usage,
      totalTokens,
    })),
  ])(
    'does not upgrade invalid buckets or contradictory exact totals: %j',
    (raw) => {
      expect(projectNativeUsage(raw, true, true)).toMatchObject({
        usageComplete: false,
        cacheUsageKnown: false,
      });
    },
  );
});

it('uses inclusive DSH input so the existing cash formula subtracts cache-read exactly once', () => {
  const usage = projectNativeUsage(
    {
      inputTokens: 1000,
      cacheReadTokens: 2000,
      cacheWriteTokens: 500,
      outputTokens: 100,
    },
    true,
    false,
  );
  expect(usage).toMatchObject({
    inputTokens: 3500,
    cachedInputTokens: 2000,
    usageComplete: true,
    cacheUsageKnown: true,
  });
  expect(
    estimateModelCostCents({
      ...usage,
      provider: 'synthetic',
      model: 'fixed',
      pricing: {
        'synthetic:fixed': {
          inputCentsPerMillion: 100,
          outputCentsPerMillion: 400,
        },
      },
    }),
  ).toBeCloseTo(0.19);
});
