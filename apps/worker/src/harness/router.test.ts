import { describe, expect, it } from 'vitest';

import type { HarnessAdapter, HarnessExecutionResult } from './adapter.js';
import { CodexHarnessAdapter } from './codex-adapter.js';
import { HarnessRouter } from './router.js';

class FakeDshAdapter implements HarnessAdapter {
  readonly kind = 'dsh' as const;
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
    const codex = new CodexHarnessAdapter();
    const dsh = new FakeDshAdapter();
    const router = new HarnessRouter([codex, dsh]);
    expect(router.resolve('codex')).toBe(codex);
    expect(router.resolve('dsh')).toBe(dsh);
  });

  it('advertises native Codex active-turn steering', () => {
    const capabilities = new CodexHarnessAdapter().capabilities;
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
    const codex = new CodexHarnessAdapter();
    const router = new HarnessRouter([codex]);
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
      adapter: codex,
      reasonCode: 'primary_harness_selected',
    });
  });

  it('uses an explicit cross-harness fallback when the primary is unavailable', () => {
    const codex = new CodexHarnessAdapter();
    const dsh = new FakeDshAdapter();
    const selection = new HarnessRouter([codex, dsh]).select({
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
      providerHealth: { dsh: 'unavailable', codex: 'available' },
    });
    expect(selection.adapter).toBe(codex);
    expect(selection.reasonCode).toBe('fallback_harness_selected');
    expect(selection.providerSnapshot).toMatchObject({
      provider: 'codex',
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
        providerHealth: { dsh: 'unavailable', codex: 'unavailable' },
      }),
    ).toThrow('No configured and healthy harness route');
  });
});
