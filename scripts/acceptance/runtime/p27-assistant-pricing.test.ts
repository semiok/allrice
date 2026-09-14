import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runtimePolicyDigest } from '../../../packages/database/src/runtime-policy.ts';
import {
  assertP27PriceDate,
  createP27GeminiPriceBinding,
  P27_GEMINI_PRICE_FACTS,
  P27_GEMINI_PRICE_FACTS_DIGEST,
  P27_GEMINI_RUN_LIMITS,
  verifyP27PricingReceipts,
  type P27CostReceipt,
  type P27PricedAdmission,
  type P27PricingSummary,
} from './p27-assistant-pricing.ts';
import { runLimitsForProvider } from './p27-assistant-preflight.ts';

function evidence() {
  const binding = createP27GeminiPriceBinding({
    connectionId: randomUUID(),
    catalogId: randomUUID(),
    at: '2026-09-14T10:00:00.000Z',
  });
  const snapshotDigest = runtimePolicyDigest(binding.snapshot);
  const admissions: P27PricedAdmission[] = Array.from(
    { length: 2 },
    (_, index) => ({
      call_id: randomUUID(),
      run_id: randomUUID(),
      request_digest: runtimePolicyDigest({ index }),
      dispatched_at: new Date('2026-09-14T10:00:01Z'),
      finished_at: new Date('2026-09-14T10:00:02Z'),
    }),
  );
  const receipts: P27CostReceipt[] = admissions.map((call) => ({
    call_id: call.call_id,
    run_id: call.run_id,
    request_digest: call.request_digest!,
    snapshot_digest: snapshotDigest,
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      usageComplete: true,
    },
    usage_complete: true,
    cache_usage_known: false,
    cost_basis: 'conservative_upper_bound',
    actual_cost_known: false,
    cost_picounits: '15000000',
  }));
  const summary: P27PricingSummary = {
    snapshotDigest,
    currency: 'USD',
    callCount: 2,
    usageComplete: true,
    cacheUsageKnown: false,
    costBasis: 'conservative_upper_bound',
    actualCostKnown: false,
    costPicounits: '30000000',
    costCentsDecimal: '0.003000',
  };
  return {
    snapshot: binding.snapshot,
    snapshotDigest,
    admissions,
    receipts,
    modelCalls: 2,
    settledUsage: { inputTokens: 20, outputTokens: 4 },
    summary,
  };
}

describe('P27 explicit isolated Gemini tariff (no provider/network)', () => {
  it('binds versioned public facts to an exact random route with a finite review date', () => {
    const connectionId = randomUUID();
    const catalogId = randomUUID();
    const { snapshot, bound } = createP27GeminiPriceBinding({
      connectionId,
      catalogId,
      at: '2026-09-14T10:00:00.000Z',
    });
    expect(snapshot.price.target).toMatchObject({
      connectionId,
      catalogId,
      serviceTier: 'default',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      authMode: 'api_key',
    });
    expect(snapshot.price.source).toEqual({
      reference: 'google-gemini-3.8-flash-standard-20260914',
      digest: P27_GEMINI_PRICE_FACTS_DIGEST,
    });
    expect(snapshot.price.expiresAt).toBe('2026-10-01T00:00:00.000Z');
    expect(P27_GEMINI_PRICE_FACTS_DIGEST).toBe(
      `sha256:${createHash('sha256').update(JSON.stringify(P27_GEMINI_PRICE_FACTS)).digest('hex')}`,
    );
    expect(P27_GEMINI_PRICE_FACTS.cacheWritePolicy).toContain(
      'not-a-published-cache-write-price',
    );
    expect(bound).toMatchObject({
      costCentsDecimal: '10.500000',
      actualCostKnown: false,
      cacheUsageKnown: false,
      costBasis: 'conservative_upper_bound',
    });
    expect(runLimitsForProvider('gemini')).toEqual(P27_GEMINI_RUN_LIMITS);
    expect(runLimitsForProvider('gemini').maxCostCents).toBe(11);
    expect(runLimitsForProvider('openai-codex').maxCostCents).toBeNull();
  });
  it.each([
    '2026-09-13T23:59:59.999Z',
    '2026-10-01T00:00:00.000Z',
    '2027-01-01T00:00:00.000Z',
    'not-a-date',
  ])(
    'rejects an expired/not-yet-effective manifest before execution: %s',
    (at) => {
      expect(() => assertP27PriceDate(at)).toThrow(
        'p27_price_manifest_expired_or_not_effective',
      );
    },
  );
  it('reconciles each dispatched call, immutable receipt, and rounded-once summary without calling it a bill', () => {
    const proof = verifyP27PricingReceipts(evidence());
    expect(proof).toMatchObject({
      costCentsDecimal: '0.003000',
      actualCostKnown: false,
      cacheUsageKnown: false,
    });
    expect(proof.scope).toContain('not_worker_monthly_quota_or_invoice');
    expect(proof).not.toHaveProperty('usage');
    expect(proof).not.toHaveProperty('admissions');
  });
  it.each(['missing', 'duplicate', 'count', 'empty'])(
    'rejects missing/duplicate/unreconciled receipts: %s',
    (kind) => {
      const value = evidence();
      if (kind === 'missing') value.receipts.pop();
      if (kind === 'duplicate') value.receipts[1] = value.receipts[0]!;
      if (kind === 'count') value.modelCalls++;
      if (kind === 'empty') {
        value.receipts = [];
        value.admissions = [];
        value.modelCalls = 0;
      }
      expect(() => verifyP27PricingReceipts(value)).toThrow(
        'p27_priced_call_receipt_count',
      );
    },
  );
  it.each([
    { run_id: randomUUID() },
    { request_digest: runtimePolicyDigest({ wrong: true }) },
    { snapshot_digest: runtimePolicyDigest({ wrong: true }) },
    { usage_complete: false },
    { cache_usage_known: true },
    { actual_cost_known: true },
    { cost_basis: 'unknown' },
  ])(
    'rejects receipt identity/completeness/accounting flags %j',
    (override) => {
      const value = evidence();
      Object.assign(value.receipts[0]!, override);
      expect(() => verifyP27PricingReceipts(value)).toThrow(
        'p27_priced_receipt_identity',
      );
    },
  );
  it.each(['dispatched_at', 'finished_at'] as const)(
    'rejects a call without %s',
    (field) => {
      const value = evidence();
      value.admissions[0]![field] = null;
      expect(() => verifyP27PricingReceipts(value)).toThrow(
        'p27_priced_receipt_identity',
      );
    },
  );
  it('refuses relabelling unknown cache buckets as known zero', () => {
    const value = evidence();
    value.receipts[0]!.usage = {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usageComplete: true,
    };
    expect(() => verifyP27PricingReceipts(value)).toThrow(
      'p27_priced_cache_remains_unknown',
    );
  });
  it('independently recalculates receipt money instead of trusting copied cents', () => {
    const value = evidence();
    value.receipts[0]!.cost_picounits = '0';
    expect(() => verifyP27PricingReceipts(value)).toThrow(
      'p27_priced_receipt_amount',
    );
  });
  it('reconciles receipt token totals against the separate settled root ledger', () => {
    const value = evidence();
    value.settledUsage.inputTokens++;
    expect(() => verifyP27PricingReceipts(value)).toThrow(
      'p27_priced_receipts_match_settled_tokens',
    );
  });
  it.each([
    { currency: 'CNY' },
    { callCount: 1 },
    { usageComplete: false },
    { cacheUsageKnown: true },
    { actualCostKnown: true },
    { costBasis: 'tariff_estimate' },
    { costPicounits: '0' },
    { costCentsDecimal: '0.000001' },
    { snapshotDigest: runtimePolicyDigest({ wrong: true }) },
  ])('rejects mismatched public summary %j', (override) => {
    const value = evidence();
    Object.assign(value.summary, override);
    expect(() => verifyP27PricingReceipts(value)).toThrow(
      'p27_priced_summary_matches_receipts',
    );
  });
});
