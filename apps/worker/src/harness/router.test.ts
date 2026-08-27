import { describe, expect, it } from 'vitest';

import type { HarnessAdapter, HarnessExecutionResult } from './adapter.js';
import {
  HarnessRouter,
  classifyProviderFailure,
  harnessRouteKey,
} from './router.js';

class FakeDshAdapter implements HarnessAdapter {
  readonly kind = 'dsh' as const;
  readonly contextStrategy = 'harness-native' as const;
  readonly capabilities = {
    persistentThreads: true,
    assistantDeltas: true,
    toolEvents: true,
    usageEvents: true,
    interrupt: true,
    steer: true,
    compact: true,
    recover: true,
  } as const;

  async execute(): Promise<HarnessExecutionResult> {
    return {
      answer: 'fake',
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      provider: 'fake',
      model: 'fake',
    };
  }
}

describe('HarnessRouter', () => {
  it('routes by employee runtime policy, not by worker implementation details', () => {
    const dsh = new FakeDshAdapter();
    const router = new HarnessRouter([dsh]);
    expect(() => router.resolve('codex')).toThrow('not available');
    expect(router.resolve('dsh')).toBe(dsh);
  });

  it('advertises native DSH active-turn steering', () => {
    const capabilities = new FakeDshAdapter().capabilities;
    expect(capabilities).toMatchObject({
      persistentThreads: true,
      interrupt: true,
      assistantDeltas: true,
      steer: true,
      compact: true,
    });
  });

  it('fails closed when a requested harness is not deployed', () => {
    expect(() => new HarnessRouter([]).resolve('dsh')).toThrow(
      'Harness dsh is not available',
    );
  });

  it('selects the configured primary harness', () => {
    const dsh = new FakeDshAdapter();
    const router = new HarnessRouter([dsh]);
    const selection = router.select({
      runtimePolicy: {
        harness: 'codex',
        provider: 'codex',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'high',
        timeoutMs: 300_000,
        fallbackModels: [],
      },
      providerSnapshot: {
        provider: 'codex',
        authMode: 'chatgpt_subscription',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'high',
        sandbox: 'workspace-write',
      },
    });
    expect(selection).toMatchObject({
      adapter: dsh,
      reasonCode: 'primary_provider_selected',
    });
    expect(selection.providerSnapshot).toMatchObject({
      provider: 'dsh',
      route: 'openai-codex',
    });
  });

  it('uses an explicit Provider fallback inside DSH', () => {
    const dsh = new FakeDshAdapter();
    const primary = {
      provider: 'dsh' as const,
      authMode: 'allrice_credential' as const,
      route: 'deepseek-official' as const,
      model: 'deepseek-chat',
      reasoningEffort: 'high' as const,
      credentialReference: 'tenant/deepseek',
      baseUrl: null,
    };
    const selection = new HarnessRouter([dsh]).select({
      runtimePolicy: {
        harness: 'dsh',
        provider: 'deepseek-official',
        model: 'deepseek-chat',
        reasoningEffort: 'high',
        timeoutMs: 300_000,
        fallbackModels: ['codex/gpt-5.6-luna'],
        credentialReference: 'tenant/deepseek',
      },
      providerSnapshot: primary,
      excludedRoutes: [harnessRouteKey(primary)],
    });
    expect(selection.adapter).toBe(dsh);
    expect(selection.reasonCode).toBe('fallback_provider_selected');
    expect(selection.providerSnapshot).toMatchObject({
      provider: 'dsh',
      route: 'openai-codex',
      model: 'gpt-5.6-luna',
    });
  });

  it('fails explicitly when neither primary nor fallback is available', () => {
    const router = new HarnessRouter([new FakeDshAdapter()]);
    expect(() =>
      router.select({
        runtimePolicy: {
          harness: 'dsh',
          provider: 'deepseek-official',
          model: 'deepseek-chat',
          reasoningEffort: 'high',
          timeoutMs: 300_000,
          fallbackModels: ['codex/gpt-5.6-luna'],
          credentialReference: 'tenant/deepseek',
        },
        providerSnapshot: {
          provider: 'dsh',
          authMode: 'allrice_credential',
          route: 'deepseek-official',
          model: 'deepseek-chat',
          reasoningEffort: 'high',
          credentialReference: 'tenant/deepseek',
          baseUrl: null,
        },
        providerHealth: { dsh: 'unavailable' },
      }),
    ).toThrow('No configured and healthy DSH Provider route');
  });

  it('moves to an explicit fallback only when a prior route is excluded', () => {
    const dsh = new FakeDshAdapter();
    const primary = {
      provider: 'codex' as const,
      authMode: 'chatgpt_subscription' as const,
      model: 'gpt-5.6-luna',
      reasoningEffort: 'xhigh' as const,
      sandbox: 'workspace-write' as const,
    };
    const fallback = {
      provider: 'dsh' as const,
      authMode: 'allrice_credential' as const,
      route: 'openai-compatible' as const,
      model: 'MiniMax-M3',
      reasoningEffort: 'high' as const,
      credentialReference: 'deployment:minimax-default',
      baseUrl: 'https://api.minimaxi.com/v1',
    };
    const selection = new HarnessRouter([dsh]).select({
      runtimePolicy: {
        harness: 'codex',
        provider: 'codex',
        model: primary.model,
        reasoningEffort: 'xhigh',
        timeoutMs: 300_000,
        fallbackModels: [],
      },
      providerSnapshot: primary,
      fallbackSnapshots: [fallback],
      excludedRoutes: [harnessRouteKey(primary)],
      allowRuntimePolicyFallbacks: false,
    });
    expect(selection.providerSnapshot).toEqual(fallback);
    expect(selection.reasonCode).toBe('fallback_provider_selected');
  });

  it('classifies only explicit provider failure families', () => {
    expect(classifyProviderFailure('DSH_REQUEST_TIMEOUT')).toBe('timeout');
    expect(classifyProviderFailure('HTTP_429_RATE_LIMIT')).toBe('rate_limited');
    expect(classifyProviderFailure('CODEX_APP_SERVER_UNAVAILABLE')).toBe(
      'provider_unavailable',
    );
    expect(classifyProviderFailure('MODEL_OUTPUT_BUDGET_EXCEEDED')).toBeNull();
  });
});
