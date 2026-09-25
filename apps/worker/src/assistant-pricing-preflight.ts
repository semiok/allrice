import { createHash } from 'node:crypto';
import {
  AssistantPricingError,
  SessionModelSnapshotSchema,
  canonicalRuntimeBridgeJson,
  estimateAssistantUsageCost,
  selectAssistantPriceSnapshot,
  resolveAssistantSubscriptionSnapshot,
  type AssistantPriceSnapshot,
  type AssistantSubscriptionSnapshot,
  type HarnessExecutionSnapshot,
  type RouteDecision,
  type SessionModelSnapshot,
} from '@allrice/contracts';
import { HandlerError } from './errors.js';
import type { HarnessExecutionResult } from './harness/adapter.js';

export const assistantGeminiPricingEndpoint =
  'https://generativelanguage.googleapis.com/v1beta';
export const assistantCanonicalModel = (provider: string, model: string) =>
  provider === 'gemini' && model === '3.8flash' ? 'gemini-3.8-flash' : model;
function deny(code: string): never {
  throw new HandlerError(
    code,
    '助手计费依据不可用；本次未授权新的模型调用。',
    false,
  );
}
export function assistantPriceSnapshotDigest(snapshot: AssistantPriceSnapshot) {
  return `sha256:${createHash('sha256').update(canonicalRuntimeBridgeJson(snapshot)).digest('hex')}`;
}

export function assistantSubscriptionSnapshotDigest(
  snapshot: AssistantSubscriptionSnapshot,
) {
  return `sha256:${createHash('sha256').update(canonicalRuntimeBridgeJson(snapshot)).digest('hex')}`;
}

/** A native result cannot declare itself subscription/free. Bind all assistant
 * result metadata to the trusted preflight proof, while missing tokens remain
 * incomplete in the separate usage projection. Ordinary results are projected
 * from that same frozen identity by the Worker, not by a price estimator. */
export function assertAssistantSubscriptionResult(
  snapshot: AssistantSubscriptionSnapshot,
  result: HarnessExecutionResult,
) {
  if (
    result.provider !== snapshot.provider ||
    result.model !== snapshot.model ||
    result.billingMode !== 'subscription' ||
    result.costBasis !== 'not_applicable' ||
    result.estimatedCostCents !== null ||
    result.costEstimateAvailable !== false ||
    result.actualCostKnown !== false ||
    typeof result.usageComplete !== 'boolean' ||
    result.cacheUsageKnown !== false ||
    result.costCurrency !== undefined ||
    result.priceSnapshotDigest !== undefined ||
    result.subscriptionSnapshotDigest !==
      assistantSubscriptionSnapshotDigest(snapshot)
  )
    throw new HandlerError(
      'ASSISTANT_SUBSCRIPTION_RESULT_UNVERIFIED',
      '订阅用量结果与冻结身份不一致。',
      false,
    );
}

/** Only deployment-owned configuration and the server's frozen replay route.
 * No default tariff, implicit currency, request-provided prices or API key read.
 */
export function preflightAssistantPricing(input: {
  enabled: boolean;
  sessionId: string;
  deadlineAt: string;
  modelSnapshot: SessionModelSnapshot | undefined;
  decision: RouteDecision;
  providerSnapshot: HarnessExecutionSnapshot;
  hasNonTextInput: boolean;
  at?: string;
}): AssistantPriceSnapshot | undefined {
  if (!input.enabled) return undefined;
  // The text-only tariff is an API pricing constraint, not a vision limit.
  // Verify subscription identity first; native DSH still admits the images.
  if (preflightAssistantSubscription(input)) return undefined;
  if (input.hasNonTextInput) deny('ASSISTANT_PRICE_TEXT_ONLY');
  const parsed = SessionModelSnapshotSchema.safeParse(input.modelSnapshot);
  if (!parsed.success) deny('ASSISTANT_PRICE_ROUTE_UNVERIFIED');
  const frozen = parsed.data;
  const route = input.decision;
  if (
    frozen.sessionId !== input.sessionId ||
    frozen.employeeId !== route.employeeId
  )
    deny('ASSISTANT_PRICE_ROUTE_UNVERIFIED');
  const runtime = input.providerSnapshot;
  const targets = [frozen, ...frozen.resolvedFallbacks].filter(
    (target) =>
      target.connectionId === route.modelConnectionId &&
      target.modelCatalogEntryId === route.modelCatalogEntryId &&
      target.harness === route.harness &&
      target.provider === route.provider &&
      target.model === route.model,
  );
  if (
    targets.length !== 1 ||
    route.modelPolicyRevision !== frozen.policyRevision
  )
    deny('ASSISTANT_PRICE_ROUTE_UNVERIFIED');
  const target = targets[0]!;
  if (target !== frozen && frozen.fallbackPolicy !== 'explicit')
    deny('ASSISTANT_PRICE_ROUTE_UNVERIFIED');
  if (
    target.harness !== 'dsh' ||
    target.authMode !== 'api_key' ||
    !['gemini', 'openai-compatible'].includes(target.provider) ||
    runtime.provider !== 'dsh' ||
    runtime.route !== target.provider ||
    runtime.authMode !== 'allrice_credential' ||
    runtime.model !== target.model ||
    runtime.credentialReference !== target.credentialReference
  )
    deny('ASSISTANT_PRICE_ROUTE_UNVERIFIED');
  const baseUrl =
    target.provider === 'gemini'
      ? assistantGeminiPricingEndpoint
      : target.baseUrl;
  if (
    !baseUrl ||
    (target.provider === 'gemini'
      ? (target.baseUrl !== null && target.baseUrl !== baseUrl) ||
        (runtime.baseUrl !== null && runtime.baseUrl !== baseUrl)
      : runtime.baseUrl !== baseUrl)
  )
    deny('ASSISTANT_PRICE_ROUTE_UNVERIFIED');
  const encoded = process.env.ALLRICE_ASSISTANT_PRICING_JSON;
  const currency = process.env.ALLRICE_ASSISTANT_PRICING_CURRENCY;
  if (
    !encoded ||
    encoded.length > 262144 ||
    !currency ||
    !/^[A-Z]{3}$/.test(currency)
  )
    deny('ASSISTANT_PRICE_UNAVAILABLE');
  // Legacy organization ledgers have no currency column. This projection is
  // USD only, explicitly configured; never mix currency units or convert FX.
  if (currency !== 'USD') deny('ASSISTANT_PRICE_CURRENCY_UNSUPPORTED');
  try {
    const snapshot = selectAssistantPriceSnapshot({
      catalog: JSON.parse(encoded),
      currency,
      at: input.at ?? new Date().toISOString(),
      target: {
        connectionId: target.connectionId,
        catalogId: target.modelCatalogEntryId,
        harness: 'dsh',
        provider: target.provider,
        authMode: 'api_key',
        model: assistantCanonicalModel(target.provider, target.model),
        baseUrl,
        serviceTier: 'default',
        modality: 'text',
      },
    });
    const deadline = Date.parse(input.deadlineAt);
    if (
      !Number.isFinite(deadline) ||
      deadline < Date.parse(snapshot.selectedAt) ||
      deadline > Date.parse(snapshot.price.expiresAt)
    )
      deny('ASSISTANT_PRICE_UNAVAILABLE');
    return snapshot;
  } catch (error) {
    deny(
      error instanceof AssistantPricingError
        ? error.code
        : 'ASSISTANT_PRICE_UNAVAILABLE',
    );
  }
}

/** Shared by assistant and ordinary Worker execution. A missing/invalid frozen
 * Codex identity is not permission to fall back to the legacy cash estimator. */
export function preflightAssistantSubscription(
  input: Parameters<typeof resolveAssistantSubscriptionSnapshot>[0],
) {
  try {
    return resolveAssistantSubscriptionSnapshot(input);
  } catch {
    deny('ASSISTANT_SUBSCRIPTION_ROUTE_UNVERIFIED');
  }
}

/** Adapter receipts are checked against the exact preflight tariff and whole-
 * tree confirmed totals, never the ordinary single-agent live-env estimator.
 * Cache remains unknown and the monetary value is explicitly an upper bound.
 */
export function assistantResultCostCents(
  snapshot: AssistantPriceSnapshot,
  result: HarnessExecutionResult,
): number | null {
  if (result.usageComplete !== true || result.costEstimateAvailable === false)
    return null;
  const expected = estimateAssistantUsageCost(snapshot, {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    usageComplete: true,
  });
  if (
    !result.assistantStatus ||
    result.costEstimateAvailable !== true ||
    result.costBasis !== 'conservative_upper_bound' ||
    result.actualCostKnown !== false ||
    result.cacheUsageKnown !== false ||
    result.costCurrency !== snapshot.price.currency ||
    result.priceSnapshotDigest !== assistantPriceSnapshotDigest(snapshot) ||
    result.provider !== snapshot.price.target.provider ||
    assistantCanonicalModel(result.provider, result.model) !==
      snapshot.price.target.model ||
    typeof result.estimatedCostCents !== 'number' ||
    !Number.isFinite(result.estimatedCostCents) ||
    result.estimatedCostCents < 0 ||
    result.estimatedCostCents > 99999999.999999 ||
    result.estimatedCostCents !== Number(expected.costCentsDecimal)
  )
    throw new HandlerError(
      'ASSISTANT_PRICE_RESULT_UNVERIFIED',
      '助手费用估算与冻结依据不一致，费用保持待核对。',
      false,
    );
  return result.estimatedCostCents;
}
