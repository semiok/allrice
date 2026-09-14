import { describe, expect, it } from 'vitest';
import type { HarnessExecutionResult } from '../../../apps/worker/src/harness/adapter.ts';
import { validateP27AssistantOutcome } from './p27-assistant-outcome.ts';
import { PROVIDER } from './p27-assistant-preflight.ts';

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
describe('P27 authoritative adapter outcome checks (no provider)', () => {
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
