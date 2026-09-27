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
  it('omits unsupported currency pricing without blocking execution', () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    const f = fixture();
    f.priceSnapshot!.price.currency = 'CNY';
    expect(() => productionAssistantController(f)).not.toThrow();
    expect(f.database).not.toHaveBeenCalled();
  });
  it('ignores an old cost cap for the entire assistant tree', () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    const f = fixture();
    // 120k input at max bucket $5/M + 12k output at $4/M = 64.8 cents.
    expect(() =>
      productionAssistantController({
        ...f,
        runLimits: { maxOutputTokens: 12000, maxCostCents: 64 },
      }),
    ).not.toThrow();
    expect(
      productionAssistantController({
        ...f,
        runLimits: { maxOutputTokens: 12000, maxCostCents: 65 },
      }),
    ).toBeDefined();
    expect(f.database).not.toHaveBeenCalled();
  });
  it('allows missing prices even with a historical monetary cap', () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    const f = fixture();
    expect(() =>
      productionAssistantController({
        ...f,
        priceSnapshot: undefined,
        runLimits: { maxCostCents: 65 },
      }),
    ).not.toThrow();
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
    'does not gate execution on a tariff band smaller than root %s',
    (field) => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      const f = fixture();
      f.priceSnapshot!.price[field] = 100;
      expect(() => productionAssistantController(f)).not.toThrow();
      expect(f.database).not.toHaveBeenCalled();
    },
  );
  it('does not gate provider calls on monetary projection overflow', () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    const f = fixture();
    f.priceSnapshot!.price.rates.cacheReadMicrounitsPerMillion =
      '9999999999999999';
    expect(() => productionAssistantController(f)).not.toThrow();
    expect(f.database).not.toHaveBeenCalled();
  });
});
