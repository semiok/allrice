import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  assertInitialModelInputBudget,
  checkCompletedModelBudget,
  modelAdmissionTokenEstimate,
} from './model-result-budget.js';
import type { HarnessExecutionResult } from './harness/adapter.js';

describe('execution usage is telemetry across all billing routes', () => {
  afterEach(() => vi.unstubAllEnvs());
  const result: HarnessExecutionResult = {
    provider: 'fixture',
    model: 'fixture',
    answer: 'Complete answer',
    assistantStatus: 'completed',
    usageComplete: false,
    usage: {
      inputTokens: 1_500_000,
      cachedInputTokens: 377_856,
      outputTokens: 32_000,
    },
  };
  const limits = {
    timeoutMs: 3_600_000,
    maxInputTokens: 120_000,
    maxOutputTokens: 16_000,
    maxTotalTokens: 136_000,
    maxCostCents: 1,
  };
  it.each([
    { verifiedSubscription: false, governedAssistants: false },
    { verifiedSubscription: false, governedAssistants: true },
    { verifiedSubscription: true, governedAssistants: false },
    { verifiedSubscription: true, governedAssistants: true },
    { verifiedSubscription: false, workflow: true },
  ])(
    'finishes useful work over old limits without inventing receipts: %j',
    (scope) => {
      const before = structuredClone(result);
      for (const costCents of [null, 10_000]) {
        expect(
          checkCompletedModelBudget({ ...scope, limits, result, costCents }),
        ).toBeUndefined();
      }
      expect(() =>
        assertInitialModelInputBudget({
          ...scope,
          limits,
          estimatedInputTokens: 500_000,
        }),
      ).not.toThrow();
      expect(
        modelAdmissionTokenEstimate({
          ...scope,
          limits,
          estimatedInputTokens: 2000,
        }),
      ).toBe(18000);
      expect(result).toEqual(before);
    },
  );
  it('cannot reactivate cumulative quotas with the obsolete Codex switch', () => {
    vi.stubEnv('ALLRICE_CODEX_TOKEN_POLICY', 'enforce');
    expect(
      checkCompletedModelBudget({
        verifiedSubscription: true,
        limits,
        result,
        costCents: null,
      }),
    ).toBeUndefined();
  });
  it.each([-1, NaN, Infinity])(
    'rejects malformed telemetry input: %s',
    (estimatedInputTokens) => {
      expect(() =>
        assertInitialModelInputBudget({
          verifiedSubscription: false,
          limits,
          estimatedInputTokens,
        }),
      ).toThrow();
      expect(() =>
        modelAdmissionTokenEstimate({
          verifiedSubscription: false,
          limits,
          estimatedInputTokens,
        }),
      ).toThrow();
    },
  );
  it.each([
    { result: { ...result, answer: '  ' }, code: 'EMPTY_RESPONSE' },
    {
      result: { ...result, assistantStatus: 'partial' as const },
      code: 'ASSISTANT_PARTIAL_RESULT',
    },
  ])('retains actual incomplete outcomes: $code', ({ result, code }) => {
    expect(() =>
      checkCompletedModelBudget({
        verifiedSubscription: false,
        limits,
        result,
        costCents: null,
      }),
    ).toThrow(expect.objectContaining({ code }));
  });
});
