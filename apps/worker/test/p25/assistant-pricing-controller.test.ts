import { afterEach, describe, expect, it, vi } from 'vitest';
import { productionAssistantController } from '../../src/harness/dsh/assistant-controller.js';
import { syntheticAssistantPriceSnapshot } from './assistant-pricing.fixture.js';

type Input = Parameters<typeof productionAssistantController>[0];
/** Synchronous preflight only. No query/native host/provider is reachable. */
function fixture(): Input {
  return {
    configuration: {
      version: 1,
      mode: 'daily',
      allowAssistants: true,
      maxConcurrent: 2,
      maxDepth: 1,
      maxChildren: 2,
    },
    runLimits: { maxOutputTokens: 12000 },
    tools: [{ name: 'assistant.delegate' }],
    context: { policySnapshot: {} } as Input['context'],
    worker: {} as Input['worker'],
    database: vi.fn(() => {
      throw Error('no_database_query_allowed');
    }) as unknown as Input['database'],
    authorize: async () => {
      throw Error('no_native_authorization_expected');
    },
    priceSnapshot: syntheticAssistantPriceSnapshot(),
  };
}
afterEach(() => vi.unstubAllEnvs());
describe('assistant whole-tree price admission preflight', () => {
  it('rejects a valid non-USD tariff before projecting into the currency-less ledger', () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    const f = fixture();
    f.priceSnapshot!.price.currency = 'CNY';
    expect(() => productionAssistantController(f)).toThrow(
      'assistant_price_currency_unsupported',
    );
    expect(f.database).not.toHaveBeenCalled();
  });
  it('accepts only a cap covering the shared token upper bound, not a per-child reset', () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    const f = fixture();
    // 120k input at max bucket $5/M + 12k output at $4/M = 64.8 cents.
    expect(() =>
      productionAssistantController({
        ...f,
        runLimits: { maxOutputTokens: 12000, maxCostCents: 64 },
      }),
    ).toThrow('assistant_cost_bound_exceeds_limit');
    expect(
      productionAssistantController({
        ...f,
        runLimits: { maxOutputTokens: 12000, maxCostCents: 65 },
      }),
    ).toBeDefined();
    expect(f.database).not.toHaveBeenCalled();
  });
  it('retains no-price fail closed for a monetary cap', () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    const f = fixture();
    expect(() =>
      productionAssistantController({
        ...f,
        priceSnapshot: undefined,
        runLimits: { maxCostCents: 65 },
      }),
    ).toThrow('assistant_cost_bound_unavailable');
  });
  it('validates the server-verified replay route before any native or credential work', () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    const f = fixture();
    const serverPricingProviderSnapshot: NonNullable<
      Input['serverPricingProviderSnapshot']
    > = {
      provider: 'dsh',
      route: 'gemini',
      authMode: 'allrice_credential',
      model: '3.8flash',
      reasoningEffort: 'low',
      credentialReference: 'synthetic-never-resolved',
      baseUrl: null,
    };
    expect(
      productionAssistantController({ ...f, serverPricingProviderSnapshot }),
    ).toBeDefined();
    expect(() =>
      productionAssistantController({
        ...f,
        serverPricingProviderSnapshot: {
          ...serverPricingProviderSnapshot,
          model: 'different-model',
        },
      }),
    ).toThrow('assistant_price_provider_mismatch');
    expect(f.database).not.toHaveBeenCalled();
  });
  it.each(['maxInputTokens', 'maxOutputTokens'] as const)(
    'rejects a tariff band smaller than root %s before dispatch',
    (field) => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      const f = fixture();
      f.priceSnapshot!.price[field] = 100;
      expect(() => productionAssistantController(f)).toThrow(
        'ASSISTANT_PRICE_USAGE_OUT_OF_BAND',
      );
      expect(f.database).not.toHaveBeenCalled();
    },
  );
  it('rejects rates overflowing the old cents ledger before any provider call', () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    const f = fixture();
    f.priceSnapshot!.price.rates.cacheReadMicrounitsPerMillion =
      '9999999999999999';
    expect(() => productionAssistantController(f)).toThrow(
      'assistant_cost_projection_out_of_range',
    );
    expect(f.database).not.toHaveBeenCalled();
  });
});
