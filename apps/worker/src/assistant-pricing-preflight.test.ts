import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SessionModelSnapshotSchema,
  type RouteDecision,
  type HarnessExecutionSnapshot,
} from '@allrice/contracts';
import { runtimeLedgerInputDigest } from '@allrice/database';
import {
  assistantPriceSnapshotDigest,
  assistantResultCostCents,
  preflightAssistantPricing,
  preflightAssistantSubscription,
  assistantSubscriptionSnapshotDigest,
  assertAssistantSubscriptionResult,
} from './assistant-pricing-preflight.js';

function fixture() {
  const modelSnapshot = SessionModelSnapshotSchema.parse({
    schemaVersion: 1,
    sessionId: randomUUID(),
    employeeId: randomUUID(),
    policyRevision: 1,
    connectionId: randomUUID(),
    modelCatalogEntryId: randomUUID(),
    harness: 'dsh',
    provider: 'gemini',
    authMode: 'api_key',
    model: '3.8flash',
    reasoningEffort: 'low',
    credentialReference: 'deployment:synthetic-only',
    baseUrl: null,
    fallbackPolicy: 'disabled',
    fallbackTargets: [],
    resolvedFallbacks: [],
    frozenAt: new Date().toISOString(),
  });
  const decision = {
    harness: 'dsh',
    provider: 'gemini',
    model: modelSnapshot.model,
    employeeId: modelSnapshot.employeeId,
    modelConnectionId: modelSnapshot.connectionId,
    modelCatalogEntryId: modelSnapshot.modelCatalogEntryId,
    modelPolicyRevision: 1,
  } as RouteDecision;
  const providerSnapshot: HarnessExecutionSnapshot = {
    provider: 'dsh',
    route: 'gemini',
    model: '3.8flash',
    reasoningEffort: 'low',
    authMode: 'allrice_credential',
    credentialReference: modelSnapshot.credentialReference!,
    baseUrl: null,
  };
  const target = {
    connectionId: modelSnapshot.connectionId,
    catalogId: modelSnapshot.modelCatalogEntryId,
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
    catalogVersion: 'synthetic-only',
    entries: [
      {
        id: 'synthetic',
        target,
        billingMode: 'token_metered',
        currency: 'USD',
        effectiveAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        maxInputTokens: 1000000,
        maxOutputTokens: 1000000,
        rates: {
          uncachedInputMicrounitsPerMillion: '2000000',
          cacheReadMicrounitsPerMillion: '500000',
          cacheWriteMicrounitsPerMillion: '3000000',
          outputMicrounitsPerMillion: '8000000',
        },
        source: {
          reference: 'synthetic-test-not-provider-prices',
          digest: `sha256:${'a'.repeat(64)}`,
        },
      },
    ],
  };
  vi.stubEnv('ALLRICE_ASSISTANT_PRICING_JSON', JSON.stringify(catalog));
  vi.stubEnv('ALLRICE_ASSISTANT_PRICING_CURRENCY', 'USD');
  return {
    catalog,
    modelSnapshot,
    decision,
    providerSnapshot,
    enabled: true,
    sessionId: modelSnapshot.sessionId,
    deadlineAt: new Date(Date.now() + 300000).toISOString(),
    hasNonTextInput: false,
  };
}
afterEach(() => vi.unstubAllEnvs());
function subscriptionFixture() {
  const input = fixture();
  input.modelSnapshot = {
    ...input.modelSnapshot,
    provider: 'openai-codex',
    authMode: 'chatgpt_subscription',
    model: 'synthetic-codex',
  };
  input.decision = {
    ...input.decision,
    provider: 'openai-codex',
    model: 'synthetic-codex',
  };
  input.providerSnapshot = {
    ...input.providerSnapshot,
    provider: 'dsh',
    route: 'openai-codex',
    authMode: 'platform_subscription',
    model: 'synthetic-codex',
  };
  return input;
}
describe('Worker subscription preflight and exact result binding', () => {
  it('returns a subscription proof without parsing unavailable/malicious API tariffs', () => {
    const input = subscriptionFixture();
    vi.stubEnv('ALLRICE_ASSISTANT_PRICING_JSON', 'never-parse-me');
    vi.stubEnv('ALLRICE_ASSISTANT_PRICING_CURRENCY', undefined);
    expect(preflightAssistantPricing(input)).toBeUndefined();
    const snapshot = preflightAssistantSubscription(input)!;
    expect(snapshot.billingMode).toBe('subscription');
    expect(assistantSubscriptionSnapshotDigest(snapshot)).toBe(
      runtimeLedgerInputDigest(snapshot),
    );
  });
  it('does not turn an unverified Codex route into missing-price exemption', () => {
    const input = subscriptionFixture();
    expect(() =>
      preflightAssistantPricing({ ...input, modelSnapshot: undefined }),
    ).toThrow(
      expect.objectContaining({
        code: 'ASSISTANT_SUBSCRIPTION_ROUTE_UNVERIFIED',
      }),
    );
    expect(() =>
      preflightAssistantPricing({
        ...input,
        modelSnapshot: { ...input.modelSnapshot, authMode: 'api_key' },
      }),
    ).toThrow();
  });
  it('rejects forged digest, money, currency and model claims while token completeness remains independent', () => {
    const snapshot = preflightAssistantSubscription(subscriptionFixture())!;
    const result = {
      answer: 'synthetic',
      provider: snapshot.provider,
      model: snapshot.model,
      assistantStatus: 'completed' as const,
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2 },
      usageComplete: true,
      cacheUsageKnown: false,
      billingMode: 'subscription' as const,
      costBasis: 'not_applicable' as const,
      estimatedCostCents: null,
      costEstimateAvailable: false,
      actualCostKnown: false as const,
      subscriptionSnapshotDigest: assistantSubscriptionSnapshotDigest(snapshot),
    };
    expect(() =>
      assertAssistantSubscriptionResult(snapshot, result),
    ).not.toThrow();
    expect(() =>
      assertAssistantSubscriptionResult(snapshot, {
        ...result,
        usageComplete: false,
      }),
    ).not.toThrow();
    for (const changed of [
      { subscriptionSnapshotDigest: `sha256:${'0'.repeat(64)}` },
      { estimatedCostCents: 0 },
      { costCurrency: 'USD' },
      { model: 'wrong' },
      { priceSnapshotDigest: assistantSubscriptionSnapshotDigest(snapshot) },
      { costEstimateAvailable: true },
    ])
      expect(() =>
        assertAssistantSubscriptionResult(snapshot, { ...result, ...changed }),
      ).toThrow('订阅用量结果与冻结身份不一致');
  });
});
describe('Worker assistant pricing preflight — synthetic configuration only', () => {
  it('pins frozen route IDs, canonical Gemini model and actual Google endpoint before execution', () => {
    const input = fixture(),
      result = preflightAssistantPricing(input)!;
    expect(result.price.target).toEqual(input.catalog.entries[0]!.target);
    expect(assistantPriceSnapshotDigest(result)).toBe(
      runtimeLedgerInputDigest(result),
    );
  });
  it('ordinary single-agent requests never parse pricing config or need a model snapshot', () => {
    const input = fixture();
    vi.stubEnv('ALLRICE_ASSISTANT_PRICING_JSON', 'invalid');
    expect(
      preflightAssistantPricing({
        ...input,
        enabled: false,
        modelSnapshot: undefined,
        hasNonTextInput: true,
      }),
    ).toBeUndefined();
  });
  it.each([
    'ALLRICE_ASSISTANT_PRICING_JSON',
    'ALLRICE_ASSISTANT_PRICING_CURRENCY',
  ])('requires explicit %s', (key) => {
    const input = fixture();
    vi.stubEnv(key, undefined);
    expect(() => preflightAssistantPricing(input)).toThrow(
      expect.objectContaining({
        code: 'ASSISTANT_PRICE_UNAVAILABLE',
        retryable: false,
      }),
    );
  });
  it('does not leak malformed configured payloads, accept multimodal work, or select another session', () => {
    const input = fixture();
    vi.stubEnv('ALLRICE_ASSISTANT_PRICING_JSON', 'SECRET_not_JSON');
    try {
      preflightAssistantPricing(input);
      throw Error('expected failure');
    } catch (error) {
      expect(String(error)).not.toContain('SECRET');
    }
    expect(() =>
      preflightAssistantPricing({ ...input, hasNonTextInput: true }),
    ).toThrow(expect.objectContaining({ code: 'ASSISTANT_PRICE_TEXT_ONLY' }));
    expect(() =>
      preflightAssistantPricing({ ...input, sessionId: randomUUID() }),
    ).toThrow(
      expect.objectContaining({ code: 'ASSISTANT_PRICE_ROUTE_UNVERIFIED' }),
    );
  });
  it.each(['modelConnectionId', 'modelCatalogEntryId', 'employeeId'] as const)(
    'rejects persisted route mismatch on %s',
    (key) => {
      const input = fixture();
      expect(() =>
        preflightAssistantPricing({
          ...input,
          decision: { ...input.decision, [key]: randomUUID() },
        }),
      ).toThrow(
        expect.objectContaining({ code: 'ASSISTANT_PRICE_ROUTE_UNVERIFIED' }),
      );
    },
  );
  it('rejects fabricated auth, endpoint, credential or revision even when display model matches', () => {
    const input = fixture();
    expect(() =>
      preflightAssistantPricing({
        ...input,
        modelSnapshot: { ...input.modelSnapshot, authMode: 'gemini_oauth' },
      }),
    ).toThrow();
    expect(() =>
      preflightAssistantPricing({
        ...input,
        providerSnapshot: {
          ...input.providerSnapshot,
          baseUrl: 'https://proxy.example.test',
        } as HarnessExecutionSnapshot,
      }),
    ).toThrow();
    expect(() =>
      preflightAssistantPricing({
        ...input,
        providerSnapshot: {
          ...input.providerSnapshot,
          credentialReference: 'deployment:other',
        } as HarnessExecutionSnapshot,
      }),
    ).toThrow();
    expect(() =>
      preflightAssistantPricing({
        ...input,
        decision: { ...input.decision, modelPolicyRevision: 2 },
      }),
    ).toThrow();
  });
  it('rejects a tariff expiring before the actual job deadline before any adapter call', () => {
    const input = fixture();
    input.catalog.entries[0]!.expiresAt = new Date(
      Date.now() + 10000,
    ).toISOString();
    vi.stubEnv('ALLRICE_ASSISTANT_PRICING_JSON', JSON.stringify(input.catalog));
    expect(() => preflightAssistantPricing(input)).toThrow(
      expect.objectContaining({ code: 'ASSISTANT_PRICE_UNAVAILABLE' }),
    );
  });
  it('rejects even a matching explicit non-USD tariff before the currency-less ledger', () => {
    const input = fixture();
    input.catalog.entries[0]!.currency = 'CNY';
    vi.stubEnv('ALLRICE_ASSISTANT_PRICING_JSON', JSON.stringify(input.catalog));
    vi.stubEnv('ALLRICE_ASSISTANT_PRICING_CURRENCY', 'CNY');
    expect(() => preflightAssistantPricing(input)).toThrow(
      expect.objectContaining({ code: 'ASSISTANT_PRICE_CURRENCY_UNSUPPORTED' }),
    );
  });
  it('accepts only an explicitly frozen fallback and its own exact tariff', () => {
    const input = fixture();
    const fallback = {
      ...input.modelSnapshot,
      connectionId: randomUUID(),
      modelCatalogEntryId: randomUUID(),
    };
    const {
      connectionId,
      modelCatalogEntryId,
      harness,
      provider,
      authMode,
      model,
      reasoningEffort,
      credentialReference,
      baseUrl,
    } = fallback;
    input.modelSnapshot.resolvedFallbacks = [
      {
        connectionId,
        modelCatalogEntryId,
        harness,
        provider,
        authMode,
        model,
        reasoningEffort,
        credentialReference,
        baseUrl,
      },
    ];
    input.modelSnapshot.fallbackPolicy = 'explicit';
    input.decision.modelConnectionId = connectionId;
    input.decision.modelCatalogEntryId = modelCatalogEntryId;
    expect(() => preflightAssistantPricing(input)).toThrow(
      expect.objectContaining({ code: 'ASSISTANT_PRICE_UNAVAILABLE' }),
    );
    input.catalog.entries[0]!.target.connectionId = connectionId;
    input.catalog.entries[0]!.target.catalogId = modelCatalogEntryId;
    vi.stubEnv('ALLRICE_ASSISTANT_PRICING_JSON', JSON.stringify(input.catalog));
    expect(preflightAssistantPricing(input)!.price.target.connectionId).toBe(
      connectionId,
    );
  });
  it('accepts an exact whole-tree upper bound; never interprets it as actual cost or known cache', () => {
    const snapshot = preflightAssistantPricing(fixture())!;
    const result = {
      answer: 'synthetic',
      provider: 'gemini',
      model: '3.8flash',
      assistantStatus: 'completed' as const,
      usageComplete: true,
      cacheUsageKnown: false,
      costEstimateAvailable: true,
      estimatedCostCents: 0.054,
      costBasis: 'conservative_upper_bound' as const,
      actualCostKnown: false as const,
      costCurrency: 'USD',
      priceSnapshotDigest: assistantPriceSnapshotDigest(snapshot),
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 30 },
    };
    expect(assistantResultCostCents(snapshot, result)).toBe(0.054);
    for (const change of [
      { estimatedCostCents: 0 },
      { costCurrency: 'CNY' },
      { priceSnapshotDigest: `sha256:${'b'.repeat(64)}` },
      { cacheUsageKnown: true },
      { model: 'other-model' },
    ])
      expect(() =>
        assistantResultCostCents(snapshot, { ...result, ...change }),
      ).toThrow(
        expect.objectContaining({ code: 'ASSISTANT_PRICE_RESULT_UNVERIFIED' }),
      );
    expect(
      assistantResultCostCents(snapshot, { ...result, usageComplete: false }),
    ).toBeNull();
    expect(
      assistantResultCostCents(snapshot, {
        ...result,
        costEstimateAvailable: false,
        estimatedCostCents: 0,
      }),
    ).toBeNull();
  });
});
