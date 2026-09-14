/** Explicit, expiring P27 fixture tariff. Never a production/default price. */
import { createHash } from 'node:crypto';
import {
  assistantCostProjection,
  estimateAssistantUsageCost,
  selectAssistantPriceSnapshot,
  AssistantPricedUsageSchema,
  type AssistantPriceSnapshot,
  type AssistantPricingTarget,
} from '../../../packages/contracts/src/assistant-pricing.ts';

// Public source facts verified by the root task on 2026-09-14. The source page
// is NOT fetched during execution; changes require a new reviewed candidate.
export const P27_GEMINI_PRICE_FACTS = Object.freeze({
  sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
  verifiedAt: '2026-09-14',
  model: 'gemini-3.8-flash',
  serviceTier: 'standard',
  serviceTierMapping:
    'default-api-routing-with-no-explicit-tier-uses-published-standard-tariff',
  currency: 'USD',
  inputPerMillion: '0.75',
  outputIncludingThinkingPerMillion: '3.75',
  cacheReadPerMillion: '0.075',
  scope:
    'text-function-calls-only-no-grounding-no-audio-video-no-active-cache-creation',
  cacheWritePolicy:
    'use-uncached-input-rate-as-conservative-bucket-ceiling-not-a-published-cache-write-price',
  evidenceBoundary:
    'tariff-upper-bound-for-confirmed-usage-not-an-invoice-or-proof-of-billing-for-provider-internal-retries',
});
export const P27_GEMINI_PRICE_FACTS_DIGEST = `sha256:${createHash('sha256').update(JSON.stringify(P27_GEMINI_PRICE_FACTS)).digest('hex')}`;
export const P27_GEMINI_PRICE_EFFECTIVE_AT = '2026-09-14T00:00:00.000Z';
export const P27_GEMINI_PRICE_EXPIRES_AT = '2026-10-01T00:00:00.000Z';
export const P27_GEMINI_RUN_LIMITS = Object.freeze({
  timeoutMs: 180000,
  maxInputTokens: 80000,
  maxOutputTokens: 12000,
  maxTotalTokens: 92000,
  maxCostCents: 11,
});

function check(ok: unknown, code: string): asserts ok {
  if (!ok) throw Error(`p27_${code}`);
}
export function assertP27PriceDate(at: string) {
  const time = Date.parse(at);
  check(
    Number.isFinite(time) &&
      time >= Date.parse(P27_GEMINI_PRICE_EFFECTIVE_AT) &&
      time < Date.parse(P27_GEMINI_PRICE_EXPIRES_AT),
    'price_manifest_expired_or_not_effective',
  );
}

/** IDs are supplied only by the newly-created synthetic fixture, not a tenant,
 * model, request parameter, or an existing production model connection. */
export function createP27GeminiPriceBinding(input: {
  connectionId: string;
  catalogId: string;
  at: string;
}) {
  assertP27PriceDate(input.at);
  const target: AssistantPricingTarget = {
    connectionId: input.connectionId,
    catalogId: input.catalogId,
    harness: 'dsh',
    provider: 'gemini',
    authMode: 'api_key',
    model: 'gemini-3.8-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    serviceTier: 'default',
    modality: 'text',
  };
  const catalog = {
    version: 1,
    catalogVersion: 'p27-isolated-gemini-standard-20260914-v1',
    entries: [
      {
        id: 'p27-isolated-gemini-standard-20260914',
        target,
        billingMode: 'token_metered',
        currency: 'USD',
        effectiveAt: P27_GEMINI_PRICE_EFFECTIVE_AT,
        expiresAt: P27_GEMINI_PRICE_EXPIRES_AT,
        maxInputTokens: P27_GEMINI_RUN_LIMITS.maxInputTokens,
        maxOutputTokens: P27_GEMINI_RUN_LIMITS.maxOutputTokens,
        rates: {
          uncachedInputMicrounitsPerMillion: '750000',
          cacheReadMicrounitsPerMillion: '75000',
          cacheWriteMicrounitsPerMillion: '750000',
          outputMicrounitsPerMillion: '3750000',
        },
        source: {
          reference: 'google-gemini-3.8-flash-standard-20260914',
          digest: P27_GEMINI_PRICE_FACTS_DIGEST,
        },
      },
    ],
  };
  // Reuse the production exact route/currency/time/ambiguity selector.
  const snapshot = selectAssistantPriceSnapshot({
    catalog,
    target,
    currency: 'USD',
    at: input.at,
  });
  const bound = estimateAssistantUsageCost(snapshot, {
    inputTokens: P27_GEMINI_RUN_LIMITS.maxInputTokens,
    outputTokens: P27_GEMINI_RUN_LIMITS.maxOutputTokens,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    usageComplete: true,
  });
  check(
    bound.costPicounits !== null &&
      BigInt(bound.costPicounits) <=
        BigInt(P27_GEMINI_RUN_LIMITS.maxCostCents) * 10_000_000_000n,
    'price_bound_exceeds_limit',
  );
  return { target, snapshot, bound };
}

export interface P27PricingSummary {
  snapshotDigest: string;
  currency: string;
  callCount: number;
  usageComplete: boolean;
  cacheUsageKnown: boolean;
  costBasis: string;
  actualCostKnown: boolean;
  costPicounits: string | null;
  costCentsDecimal: string | null;
}
export interface P27CostReceipt {
  call_id: string;
  run_id: string;
  snapshot_digest: string;
  request_digest: string;
  usage: unknown;
  usage_complete: boolean;
  cache_usage_known: boolean;
  cost_basis: string;
  actual_cost_known: boolean;
  cost_picounits: string | null;
}
export interface P27PricedAdmission {
  call_id: string;
  run_id: string;
  request_digest: string | null;
  dispatched_at: unknown;
  finished_at: unknown;
}

/** Independently reconcile actual admitted calls -> immutable receipts ->
 * public whole-root summary. No raw requests/provider responses are inspected. */
export function verifyP27PricingReceipts(input: {
  snapshot: AssistantPriceSnapshot;
  snapshotDigest: string;
  admissions: readonly P27PricedAdmission[];
  receipts: readonly P27CostReceipt[];
  modelCalls: number;
  settledUsage: { inputTokens: number; outputTokens: number };
  summary: P27PricingSummary;
}) {
  const { admissions, receipts, snapshot, summary } = input;
  check(
    admissions.length > 0 &&
      admissions.length === input.modelCalls &&
      receipts.length === admissions.length &&
      new Set(admissions.map((row) => row.call_id)).size ===
        admissions.length &&
      new Set(receipts.map((row) => row.call_id)).size === receipts.length,
    'priced_call_receipt_count',
  );
  let total = 0n;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const call of admissions) {
    const receipt = receipts.find((row) => row.call_id === call.call_id);
    check(
      call.dispatched_at &&
        call.finished_at &&
        receipt &&
        receipt.run_id === call.run_id &&
        receipt.request_digest === call.request_digest &&
        receipt.snapshot_digest === input.snapshotDigest &&
        receipt.usage_complete &&
        !receipt.cache_usage_known &&
        !receipt.actual_cost_known &&
        receipt.cost_basis === 'conservative_upper_bound',
      'priced_receipt_identity',
    );
    const usage = AssistantPricedUsageSchema.parse(receipt.usage);
    check(
      usage?.cacheReadTokens === null && usage.cacheWriteTokens === null,
      'priced_cache_remains_unknown',
    );
    const estimate = estimateAssistantUsageCost(snapshot, usage);
    check(
      estimate.costPicounits !== null &&
        estimate.costPicounits === receipt.cost_picounits,
      'priced_receipt_amount',
    );
    total += BigInt(estimate.costPicounits);
    inputTokens += usage.inputTokens!;
    outputTokens += usage.outputTokens!;
  }
  check(
    inputTokens === input.settledUsage.inputTokens &&
      outputTokens === input.settledUsage.outputTokens,
    'priced_receipts_match_settled_tokens',
  );
  const projection = assistantCostProjection(total.toString());
  check(
    summary.snapshotDigest === input.snapshotDigest &&
      summary.currency === snapshot.price.currency &&
      summary.callCount === admissions.length &&
      summary.usageComplete &&
      !summary.cacheUsageKnown &&
      !summary.actualCostKnown &&
      summary.costBasis === 'conservative_upper_bound' &&
      summary.costPicounits === projection.costPicounits &&
      summary.costCentsDecimal === projection.costCentsDecimal &&
      total > 0n &&
      total <= BigInt(P27_GEMINI_RUN_LIMITS.maxCostCents) * 10_000_000_000n,
    'priced_summary_matches_receipts',
  );
  return {
    ...summary,
    sourceFactsDigest: P27_GEMINI_PRICE_FACTS_DIGEST,
    scope:
      'isolated_fixture_native_tariff_accounting_not_worker_monthly_quota_or_invoice',
  };
}
