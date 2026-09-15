import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AssistantSubscriptionSnapshot,
  DshExecutionSnapshot,
} from '@allrice/contracts';
import { productionAssistantController } from '../../src/harness/dsh/assistant-controller.js';
import { assertAssistantProviderOutputBound } from '../../src/harness/dsh/assistant-provider.js';
import { syntheticAssistantPriceSnapshot } from './assistant-pricing.fixture.js';

const subscription = (): AssistantSubscriptionSnapshot => ({
  version: 1,
  billingMode: 'subscription',
  harness: 'dsh',
  provider: 'openai-codex',
  authMode: 'chatgpt_subscription',
  sessionId: randomUUID(),
  employeeId: randomUUID(),
  connectionId: randomUUID(),
  modelCatalogEntryId: randomUUID(),
  policyRevision: 1,
  model: 'gpt-5.6-luna',
  credentialReference: 'deployment:codex-default',
  baseUrl: null,
  frozenAt: '2026-09-15T00:00:00.000Z',
});
const provider = (): DshExecutionSnapshot => ({
  provider: 'dsh',
  route: 'openai-codex',
  authMode: 'platform_subscription',
  model: 'gpt-5.6-luna',
  reasoningEffort: 'low',
  credentialReference: 'deployment:codex-default',
  baseUrl: null,
});
type Input = Parameters<typeof productionAssistantController>[0];
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
    runLimits: {
      maxInputTokens: 8000,
      maxOutputTokens: 512,
      maxTotalTokens: 8512,
      maxCostCents: 0,
    },
    tools: [{ name: 'assistant.delegate' }],
    context: {
      policySnapshot: {},
      delegatedBy: { id: randomUUID() },
    } as Input['context'],
    worker: {} as Input['worker'],
    database: vi.fn(() => {
      throw Error('no_database_query_allowed');
    }) as unknown as Input['database'],
    authorize: async () => {
      throw Error('no_native_authorization_expected');
    },
    subscriptionSnapshot: subscription(),
  };
}
afterEach(() => vi.unstubAllEnvs());
describe('subscription admission is explicit, not an API output-cap assertion', () => {
  it('keeps Codex assistants unavailable without a trusted subscription proof', () => {
    expect(() => assertAssistantProviderOutputBound(provider(), true)).toThrow(
      expect.objectContaining({
        code: 'ASSISTANT_PROVIDER_OUTPUT_BOUND_UNSUPPORTED',
      }),
    );
    expect(() =>
      assertAssistantProviderOutputBound(provider(), false),
    ).not.toThrow();
  });
  it('accepts a matching strict subscription identity without a claimed API cap', () => {
    expect(() =>
      assertAssistantProviderOutputBound(provider(), true, subscription()),
    ).not.toThrow();
  });
  it.each([
    { route: 'openai-compatible' },
    { authMode: 'allrice_credential' },
    { model: 'different-model' },
    { credentialReference: 'different-binding' },
    { baseUrl: 'https://unverified.invalid/v1' },
  ])('rejects conflicting provider identity %j', (override) => {
    expect(() =>
      assertAssistantProviderOutputBound(
        { ...provider(), ...override } as DshExecutionSnapshot,
        true,
        subscription(),
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'ASSISTANT_SUBSCRIPTION_ROUTE_UNVERIFIED',
      }),
    );
  });
  it('rejects extra browser-supplied authority fields in a subscription marker', () => {
    expect(() =>
      assertAssistantProviderOutputBound(provider(), true, {
        ...subscription(),
        bypassQuota: true,
      } as AssistantSubscriptionSnapshot),
    ).toThrow(
      expect.objectContaining({
        code: 'ASSISTANT_SUBSCRIPTION_ROUTE_UNVERIFIED',
      }),
    );
  });
  it('does not need an API price/cash budget but retains a finite shared output grant', () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    const input = fixture();
    const controller = productionAssistantController(input);
    expect(controller?.subscriptionSnapshot).toEqual(
      input.subscriptionSnapshot,
    );
    expect(controller?.maxOutputTokens).toBe(170);
    expect(input.database).not.toHaveBeenCalled();
  });
  it('does not combine an API tariff with subscription billing', () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    const input = fixture();
    expect(() =>
      productionAssistantController({
        ...input,
        priceSnapshot: syntheticAssistantPriceSnapshot(),
      }),
    ).toThrow('assistant_billing_mode_conflict');
    expect(input.database).not.toHaveBeenCalled();
  });
  it('keeps the feature flag and explicit no-assistants restriction', () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
    expect(() => productionAssistantController(fixture())).toThrow(
      'assistant_runtime_disabled',
    );
    expect(
      productionAssistantController({
        ...fixture(),
        configuration: {
          ...(fixture().configuration as object),
          allowAssistants: false,
        },
      }),
    ).toBeUndefined();
  });
  it('never binds merely from the in-memory marker when durable evidence is unavailable', async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    const input = fixture();
    await expect(
      productionAssistantController(input)!.bind('synthetic-native', 1),
    ).rejects.toThrow('no_database_query_allowed');
  });
});
