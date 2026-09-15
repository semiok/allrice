import { describe, expect, it } from 'vitest';
import type { HarnessExecutionResult } from '../../../apps/worker/src/harness/adapter.ts';
import { assertQuotaAvailable } from '../../../packages/database/src/providers/model-governance.ts';
import {
  verifyCodexSubscriptionResult,
  type readCodexSubscriptionEvidence,
} from './p27-codex-assistants-verification.ts';

const digest = `sha256:${'a'.repeat(64)}`;
const evidence = {
  snapshotDigest: digest,
  row: {
    input_tokens: 18,
    output_tokens: 7,
    cached_input_tokens: 0,
    cache_usage_known: false,
  },
} as Awaited<ReturnType<typeof readCodexSubscriptionEvidence>>;
const result = () =>
  ({
    provider: 'openai-codex',
    model: 'gpt-5.6-luna',
    assistantStatus: 'completed',
    usage: { inputTokens: 18, outputTokens: 7, cachedInputTokens: 0 },
    usageComplete: true,
    cacheUsageKnown: false,
    actualCostKnown: false,
    costEstimateAvailable: false,
    estimatedCostCents: null,
    billingMode: 'subscription',
    costBasis: 'not_applicable',
    subscriptionSnapshotDigest: digest,
  }) as unknown as HarnessExecutionResult;
describe('synthetic subscription result assertions, no provider', () => {
  it('requires positive real usage and N/A identity, not a zero tariff', () => {
    expect(
      verifyCodexSubscriptionResult(result(), evidence, true),
    ).toMatchObject({
      billingMode: 'subscription',
      costBasis: 'not_applicable',
      estimatedCostCents: null,
      subscriptionSnapshotDigest: digest,
    });
  });
  it.each([
    { estimatedCostCents: 0 },
    { costBasis: 'unknown' },
    { billingMode: 'token_metered' },
    { subscriptionSnapshotDigest: `sha256:${'b'.repeat(64)}` },
    { usageComplete: false },
    { costEstimateAvailable: true },
    { actualCostKnown: true },
    { cacheUsageKnown: true },
    { costCurrency: 'USD' },
    { priceSnapshotDigest: digest },
    { provider: 'gemini' },
    { usage: { inputTokens: 19, outputTokens: 7, cachedInputTokens: 0 } },
  ])('rejects changed subscription handoff %j', (change) => {
    expect(() =>
      verifyCodexSubscriptionResult(
        { ...result(), ...change } as HarnessExecutionResult,
        evidence,
        true,
      ),
    ).toThrow();
  });
  it('keeps ordinary results distinct from assistant results', () => {
    expect(() =>
      verifyCodexSubscriptionResult(result(), evidence, false),
    ).toThrow();
    expect(
      verifyCodexSubscriptionResult(
        { ...result(), assistantStatus: undefined },
        evidence,
        false,
      ).billingMode,
    ).toBe('subscription');
  });
});

describe('ordinary follow-up subscription quota semantics, no database or provider', () => {
  const quota = () => ({
    organizationId: '11111111-1111-4111-8111-111111111111',
    monthlyRunLimit: 10,
    monthlyTokenLimit: 1000,
    monthlyCostLimitCents: 0,
    usedRuns: 1,
    usedTokens: 25,
    usedCostCents: 0,
    unknownCostRuns: 0,
    subscriptionRuns: 1,
    usageComplete: true,
    cacheUsageKnown: false,
    periodStart: '2026-09-01T00:00:00.000Z',
  });

  it('admits known subscription tokens even when the cash allowance is zero', () => {
    expect(() => assertQuotaAvailable(quota())).toThrow(
      'MODEL_COST_QUOTA_EXCEEDED',
    );
    expect(() => assertQuotaAvailable(quota(), 'subscription')).not.toThrow();
  });

  it('does not reinterpret historical unknown API cash when admitting subscriptions', () => {
    const mixed = { ...quota(), usedCostCents: null, unknownCostRuns: 1 };
    expect(() => assertQuotaAvailable(mixed)).toThrow(
      'MODEL_COST_USAGE_UNKNOWN',
    );
    expect(() => assertQuotaAvailable(mixed, 'subscription')).not.toThrow();
    expect(mixed).toMatchObject({ usedCostCents: null, unknownCostRuns: 1 });
  });

  it.each([
    [{ usageComplete: false }, 'MODEL_TOKEN_USAGE_UNKNOWN'],
    [{ usedTokens: 1000 }, 'MODEL_TOKEN_QUOTA_EXCEEDED'],
    [{ usedRuns: 10 }, 'MODEL_RUN_QUOTA_EXCEEDED'],
  ])('keeps mandatory internal quota checks %j', (change, code) => {
    expect(() =>
      assertQuotaAvailable({ ...quota(), ...change }, 'subscription'),
    ).toThrow(code);
  });
});
