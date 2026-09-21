import { describe, it, expect } from 'vitest';
import {
  assertInitialModelInputBudget,
  checkCompletedModelBudget,
  modelAdmissionTokenEstimate,
} from './model-result-budget.js';
import { ModelRunLimitsSchema } from '@allrice/contracts';
import type { HarnessExecutionResult } from './harness/adapter.js';

describe('MET-150 completed subscription budget accounting', () => {
  const result: HarnessExecutionResult = {
    provider: 'openai-codex',
    model: 'fixture',
    answer: 'Complete answer',
    usageComplete: true,
    usage: {
      inputTokens: 478_964,
      cachedInputTokens: 377_856,
      outputTokens: 10_210,
    },
  };
  const input = {
    limits: {
      timeoutMs: 300_000,
      maxInputTokens: 120_000,
      maxOutputTokens: 16_000,
      maxTotalTokens: 136_000,
      maxCostCents: null,
    },
    result,
    verifiedSubscription: true,
    governedAssistants: false,
    costCents: null,
  };
  it('observes complete ordinary subscription usage without a cumulative ceiling or receipt rewrite', () => {
    const before = structuredClone(result);
    expect(checkCompletedModelBudget(input)).toBeUndefined();
    expect(result).toEqual(before);
  });
  it.each([
    { inputTokens: 203_744, cachedInputTokens: 173_568, outputTokens: 4_677 },
    { inputTokens: 1_500_000, cachedInputTokens: 0, outputTokens: 32_000 },
  ])(
    'does not replace the old threshold with 1M or a cumulative output ceiling: %j',
    (usage) => {
      expect(
        checkCompletedModelBudget({ ...input, result: { ...result, usage } }),
      ).toBeUndefined();
    },
  );
  it('uses current input plus a single-call output allowance at admission, not a frozen cumulative default', () => {
    const limits = ModelRunLimitsSchema.parse({});
    const before = structuredClone(limits);
    expect(
      modelAdmissionTokenEstimate({
        ...input,
        limits,
        estimatedInputTokens: 2_000,
      }),
    ).toBe(18_000);
    expect(
      modelAdmissionTokenEstimate({
        ...input,
        limits: { ...limits, maxTotalTokens: 1_000_000 },
        estimatedInputTokens: 2_000,
      }),
    ).toBe(18_000);
    expect(limits).toEqual(before);
  });
  it.each([
    { verifiedSubscription: false },
    { governedAssistants: true },
    { workflow: true },
  ])('keeps admission/root limits for non-ordinary routes: %j', (scope) => {
    expect(
      modelAdmissionTokenEstimate({
        ...input,
        ...scope,
        estimatedInputTokens: 2_000,
      }),
    ).toBe(136_000);
  });
  it('retains the initial input limit and rejects invalid estimates', () => {
    expect(() =>
      assertInitialModelInputBudget({
        ...input,
        estimatedInputTokens: 120_000,
      }),
    ).not.toThrow();
    for (const estimatedInputTokens of [120_001, -1, NaN, Infinity]) {
      expect(() =>
        assertInitialModelInputBudget({ ...input, estimatedInputTokens }),
      ).toThrow();
    }
    for (const estimatedInputTokens of [-1, NaN, Infinity]) {
      expect(() =>
        modelAdmissionTokenEstimate({ ...input, estimatedInputTokens }),
      ).toThrow();
    }
  });
  it('does not warn for within-budget completed work', () => {
    expect(
      checkCompletedModelBudget({
        ...input,
        result: {
          ...result,
          usage: {
            inputTokens: 5_000,
            cachedInputTokens: 4_000,
            outputTokens: 100,
          },
        },
      }),
    ).toBeUndefined();
  });
  it.each([{ verifiedSubscription: false }, { governedAssistants: true }])(
    'never softens unverified or governed assistant outcomes: %j',
    (patch) => {
      expect(() => checkCompletedModelBudget({ ...input, ...patch })).toThrow(
        'Frozen model run budget',
      );
    },
  );
  it.each([
    {
      result: { ...result, usageComplete: false },
      code: 'MODEL_TOKEN_USAGE_UNKNOWN',
    },
    {
      result: { ...result, usageComplete: undefined },
      code: 'MODEL_TOKEN_USAGE_UNKNOWN',
    },
    { result: { ...result, answer: '  ' }, code: 'EMPTY_RESPONSE' },
    {
      result: { ...result, assistantStatus: 'partial' as const },
      code: 'ASSISTANT_PARTIAL_RESULT',
    },
  ])(
    'preserves actual incomplete failures without mislabeling them as token limits: $code',
    ({ result, code }) => {
      try {
        checkCompletedModelBudget({ ...input, result });
        expect.unreachable();
      } catch (error) {
        expect(error).toMatchObject({ code });
      }
    },
  );
  it('separates output and API money limits', () => {
    expect(
      checkCompletedModelBudget({
        ...input,
        workflow: true,
        result: { ...result, usage: { ...result.usage, outputTokens: 16_001 } },
      }),
    ).toMatchObject({ code: 'MODEL_OUTPUT_BUDGET_EXCEEDED' });
    try {
      checkCompletedModelBudget({
        ...input,
        verifiedSubscription: false,
        result: {
          ...result,
          usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 },
        },
        limits: { ...input.limits, maxCostCents: 10 },
        costCents: 11,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'MODEL_COST_BUDGET_EXCEEDED' });
    }
  });
});
