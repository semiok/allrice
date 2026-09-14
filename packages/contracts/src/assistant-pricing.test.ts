import { describe, expect, it } from 'vitest';
import {
  AssistantPriceCatalogSchema,
  AssistantPricedUsageSchema,
  assistantCostProjection,
  estimateAssistantUsageCost,
  selectAssistantPriceSnapshot,
  type AssistantPriceCatalog,
  type AssistantPricingTarget,
} from './assistant-pricing.ts';

// Deliberately fictional rates and endpoint. Not provider pricing guidance.
const target: AssistantPricingTarget = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  catalogId: '22222222-2222-4222-8222-222222222222',
  harness: 'dsh',
  provider: 'gemini',
  authMode: 'api_key',
  model: 'synthetic-model',
  baseUrl: 'https://synthetic.example.test/v1',
  serviceTier: 'standard',
  modality: 'text',
};
const catalog: AssistantPriceCatalog = {
  version: 1,
  catalogVersion: 'synthetic-v1',
  entries: [
    {
      id: 'fixture',
      target,
      billingMode: 'token_metered',
      currency: 'USD',
      effectiveAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2027-01-01T00:00:00.000Z',
      maxInputTokens: 100000,
      maxOutputTokens: 100000,
      rates: {
        uncachedInputMicrounitsPerMillion: '2000000',
        cacheReadMicrounitsPerMillion: '500000',
        cacheWriteMicrounitsPerMillion: '3000000',
        outputMicrounitsPerMillion: '8000000',
      },
      source: {
        reference: 'synthetic-fixture-only',
        digest: `sha256:${'a'.repeat(64)}`,
      },
    },
  ],
};
const select = (
  overrides: Partial<Parameters<typeof selectAssistantPriceSnapshot>[0]> = {},
) =>
  selectAssistantPriceSnapshot({
    catalog,
    target,
    currency: 'USD',
    at: '2026-09-14T00:00:00.000Z',
    ...overrides,
  });
const usage = {
  inputTokens: 100,
  cacheReadTokens: 20,
  cacheWriteTokens: 10,
  outputTokens: 30,
  usageComplete: true,
};
describe('assistant price snapshots — synthetic rates only', () => {
  it('selects one exact server route and returns a detached immutable-value snapshot', () => {
    const snapshot = select();
    expect(snapshot.price.target).toEqual(target);
    expect(snapshot.price).not.toBe(catalog.entries[0]);
    expect(snapshot.price.rates).not.toBe(catalog.entries[0]!.rates);
  });
  it.each([
    'connectionId',
    'catalogId',
    'model',
    'baseUrl',
    'serviceTier',
  ] as const)('does not borrow a price across %s', (field) => {
    const different = field.endsWith('Id')
      ? '33333333-3333-4333-8333-333333333333'
      : field === 'baseUrl'
        ? 'https://other.example.test/v1'
        : 'other';
    expect(() => select({ target: { ...target, [field]: different } })).toThrow(
      'ASSISTANT_PRICE_UNAVAILABLE',
    );
  });
  it('does not convert currency or apply missing/expired/future/ambiguous prices', () => {
    for (const input of [
      { currency: 'CNY' },
      { catalog: undefined },
      { at: '2027-01-01T00:00:00.000Z' },
      { at: '2025-12-31T00:00:00.000Z' },
    ])
      expect(() => select(input)).toThrow('ASSISTANT_PRICE_UNAVAILABLE');
    expect(() =>
      select({
        catalog: {
          ...catalog,
          entries: [
            catalog.entries[0],
            { ...catalog.entries[0], id: 'duplicate' },
          ],
        },
      }),
    ).toThrow('ASSISTANT_PRICE_AMBIGUOUS');
  });
  it.each(['chatgpt_subscription', 'gemini_oauth', 'oauth', 'none'] as const)(
    'never infers API cash prices for %s',
    (authMode) => {
      expect(() => select({ target: { ...target, authMode } })).toThrow(
        'ASSISTANT_PRICE_UNSUPPORTED_BILLING',
      );
    },
  );
  it('rejects legacy two-rate configuration, zero/free pricing, secrets in endpoints, and implicit cache defaults', () => {
    expect(() =>
      select({
        catalog: {
          'gemini:synthetic-model': {
            inputCentsPerMillion: 10,
            outputCentsPerMillion: 20,
          },
        },
      }),
    ).toThrow('UNAVAILABLE');
    const entry = catalog.entries[0]!;
    expect(
      AssistantPriceCatalogSchema.safeParse({
        ...catalog,
        entries: [
          {
            ...entry,
            rates: { ...entry.rates, uncachedInputMicrounitsPerMillion: '0' },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      AssistantPriceCatalogSchema.safeParse({
        ...catalog,
        entries: [
          {
            ...entry,
            target: {
              ...target,
              baseUrl: 'https://user:secret@example.test/v1',
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      AssistantPricedUsageSchema.safeParse({
        inputTokens: 100,
        outputTokens: 30,
        usageComplete: true,
      }).success,
    ).toBe(false);
  });
  it('charges disjoint input/cache buckets and thinking-inclusive output once', () => {
    expect(estimateAssistantUsageCost(select(), usage)).toMatchObject({
      currency: 'USD',
      quality: 'tariff_estimate',
      cacheUsageKnown: true,
      costPicounits: '420000000',
      costMicrounitsCeiling: '420',
      costCentsDecimal: '0.042000',
    });
  });
  it('keeps unknown totals/cache unknown and rejects inconsistent or out-of-band usage', () => {
    expect(
      estimateAssistantUsageCost(select(), { ...usage, cacheReadTokens: null }),
    ).toMatchObject({
      quality: 'tariff_estimate',
      costBasis: 'conservative_upper_bound',
      actualCostKnown: false,
      costPicounits: '540000000',
      cacheUsageKnown: false,
    });
    expect(
      estimateAssistantUsageCost(select(), { ...usage, usageComplete: false }),
    ).toMatchObject({ quality: 'unknown', costPicounits: null });
    expect(() =>
      estimateAssistantUsageCost(select(), { ...usage, cacheReadTokens: 91 }),
    ).toThrow();
    expect(() =>
      estimateAssistantUsageCost(select(), { ...usage, inputTokens: 100001 }),
    ).toThrow('OUT_OF_BAND');
    expect(() =>
      estimateAssistantUsageCost(select(), { ...usage, outputTokens: null }),
    ).toThrow();
  });
  it('keeps fractional currency exact and rounds only aggregate projection upwards', () => {
    expect(assistantCostProjection('1')).toEqual({
      costPicounits: '1',
      costMicrounitsCeiling: '1',
      costCentsDecimal: '0.000001',
    });
    expect(assistantCostProjection('10001').costCentsDecimal).toBe('0.000002');
    expect(assistantCostProjection('0').costCentsDecimal).toBe('0.000000');
    expect(() => assistantCostProjection('1e100')).toThrow();
    expect(() => assistantCostProjection('-1')).toThrow();
  });
  it('unknown-cache upper bound never underestimates any disjoint cache partition', () => {
    const snapshot = select();
    const upper = BigInt(
      estimateAssistantUsageCost(snapshot, {
        ...usage,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      }).costPicounits!,
    );
    for (let read = 0; read <= usage.inputTokens; read += 10)
      for (let write = 0; write <= usage.inputTokens - read; write += 10) {
        const exact = estimateAssistantUsageCost(snapshot, {
          ...usage,
          cacheReadTokens: read,
          cacheWriteTokens: write,
        });
        expect(BigInt(exact.costPicounits!) <= upper).toBe(true);
        expect(exact.actualCostKnown).toBe(false);
      }
  });
  it('does not reinterpret a frozen snapshot when the catalog later changes', () => {
    const snapshot = select();
    const changed = structuredClone(catalog);
    changed.entries[0]!.rates.outputMicrounitsPerMillion = '9000000';
    expect(estimateAssistantUsageCost(snapshot, usage).costPicounits).toBe(
      '420000000',
    );
    expect(
      estimateAssistantUsageCost(select({ catalog: changed }), usage)
        .costPicounits,
    ).not.toBe('420000000');
  });
});
