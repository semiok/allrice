import { describe, it, expect } from 'vitest';
import { checkCompletedModelBudget } from './model-result-budget.js';
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
  it('keeps a complete answer and real cache-inclusive usage; distinguishes total from output', () => {
    const before = structuredClone(result);
    expect(checkCompletedModelBudget(input)).toMatchObject({
      code: 'MODEL_TOTAL_TOKEN_BUDGET_EXCEEDED',
      inputTokens: 478_964,
      cachedInputTokens: 377_856,
      outputTokens: 10_210,
    });
    expect(result).toEqual(before);
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
  it.each([
    { verifiedSubscription: false },
    { governedAssistants: true },
    { result: { ...result, usageComplete: false } },
    { result: { ...result, answer: '  ' } },
    { result: { ...result, assistantStatus: 'partial' as const } },
  ])(
    'never softens unverified, unknown, partial or governed assistant outcomes: %j',
    (patch) => {
      expect(() => checkCompletedModelBudget({ ...input, ...patch })).toThrow(
        'Frozen model run budget',
      );
    },
  );
  it('separates output and API money limits', () => {
    expect(
      checkCompletedModelBudget({
        ...input,
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
