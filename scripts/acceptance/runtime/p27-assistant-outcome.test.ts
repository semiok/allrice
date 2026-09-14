import { describe, expect, it } from 'vitest';
import type { HarnessExecutionResult } from '../../../apps/worker/src/harness/adapter.ts';
import { validateP27AssistantOutcome } from './p27-assistant-outcome.ts';
import { PROVIDER, GEMINI_PROVIDER } from './p27-assistant-preflight.ts';

const budgets = [
  { metric: 'input_tokens', spent: 350 },
  { metric: 'output_tokens', spent: 42 },
];
const result: HarnessExecutionResult = {
  answer: 'synthetic-not-a-model-call',
  assistantStatus: 'completed',
  usageComplete: true,
  cacheUsageKnown: false,
  costEstimateAvailable: false,
  usage: { inputTokens: 350, cachedInputTokens: 0, outputTokens: 42 },
  provider: PROVIDER.route,
  model: PROVIDER.model,
};
const pricing = {
  snapshotDigest: `sha256:${'a'.repeat(64)}`,
  currency: 'USD',
  callCount: 3,
  usageComplete: true,
  cacheUsageKnown: false,
  actualCostKnown: false,
  costBasis: 'conservative_upper_bound',
  costPicounits: '420000000',
  costCentsDecimal: '0.042000',
};
const gemini: HarnessExecutionResult = {
  ...result,
  provider: GEMINI_PROVIDER.route,
  model: GEMINI_PROVIDER.model,
  costEstimateAvailable: true,
  estimatedCostCents: 0.042,
  costCurrency: 'USD',
  costBasis: 'conservative_upper_bound',
  actualCostKnown: false,
  priceSnapshotDigest: pricing.snapshotDigest,
};
describe('P27 authoritative adapter outcome checks (no provider)', () => {
  it('binds the outcome to the explicitly selected provider, not the default route', () => {
    expect(
      validateP27AssistantOutcome(gemini, budgets, 'gemini', pricing).provider,
    ).toBe('gemini');
    expect(() => validateP27AssistantOutcome(gemini, budgets)).toThrow(
      'adapter_provider_route',
    );
    expect(() =>
      validateP27AssistantOutcome(result, budgets, 'gemini'),
    ).toThrow('adapter_provider_route');
  });
  it('requires priced Gemini totals tied to actual receipts, not an unpriced success', () => {
    expect(() =>
      validateP27AssistantOutcome(gemini, budgets, 'gemini'),
    ).toThrow('adapter_priced_accounting');
    const proof = validateP27AssistantOutcome(
      gemini,
      budgets,
      'gemini',
      pricing,
    );
    expect(proof).toMatchObject({
      estimatedCostCents: 0.042,
      actualCostKnown: false,
      cacheUsageKnown: false,
    });
    expect(proof).not.toHaveProperty('answer');
  });
  it.each([
    { costEstimateAvailable: false },
    { estimatedCostCents: 0 },
    { priceSnapshotDigest: `sha256:${'b'.repeat(64)}` },
    { costCurrency: 'CNY' },
    { costBasis: 'unknown' as const },
    { actualCostKnown: undefined },
    { cacheUsageKnown: true },
  ])('rejects a Gemini accounting mismatch %j', (override) => {
    expect(() =>
      validateP27AssistantOutcome(
        { ...gemini, ...override },
        budgets,
        'gemini',
        pricing,
      ),
    ).toThrow('adapter_priced_accounting');
  });
  it('accepts exact whole-tree totals with cache/cost explicitly unknown and omits raw answer', () => {
    const proof = validateP27AssistantOutcome(result, budgets);
    expect(proof.usage).toEqual(result.usage);
    expect(proof).not.toHaveProperty('answer');
  });
  it('rejects a parent-only returned usage even when PG totals themselves are correct', () => {
    expect(() =>
      validateP27AssistantOutcome(
        {
          ...result,
          usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 },
        },
        budgets,
      ),
    ).toThrow('adapter_whole_tree_usage');
  });
  it.each([
    { assistantStatus: 'partial' as const },
    { assistantStatus: undefined },
    { usageComplete: false },
    { usageComplete: undefined },
    { cacheUsageKnown: true },
    { cacheUsageKnown: undefined },
    { costEstimateAvailable: true },
    { costEstimateAvailable: undefined },
  ])('rejects partial/missing/incorrect accounting handoff %j', (override) => {
    expect(() =>
      validateP27AssistantOutcome({ ...result, ...override }, budgets),
    ).toThrow('p27_adapter_');
  });
  it('rejects an unexpected provider route', () => {
    expect(() =>
      validateP27AssistantOutcome(
        { ...result, provider: 'synthetic-wrong-route' },
        budgets,
      ),
    ).toThrow('adapter_provider_route');
  });
});
