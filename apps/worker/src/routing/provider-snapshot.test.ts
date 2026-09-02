import type {
  HarnessExecutionSnapshot,
  ResolvedModelTarget,
  RouteDecision,
} from '@allrice/contracts';
import { describe, expect, it } from 'vitest';

import {
  providerSnapshotForModelTarget,
  replayProviderSnapshot,
} from './provider-snapshot.js';

const targetBase = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  modelCatalogEntryId: '22222222-2222-4222-8222-222222222222',
} as const;

function decision(
  input: Pick<RouteDecision, 'harness' | 'provider' | 'model'>,
): RouteDecision {
  return input as RouteDecision;
}

describe('provider snapshot boundary', () => {
  it('projects Codex subscription targets into the sole DSH Harness', () => {
    const target: ResolvedModelTarget = {
      ...targetBase,
      harness: 'codex',
      provider: 'openai-codex',
      authMode: 'chatgpt_subscription',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'none',
      credentialReference: null,
      baseUrl: null,
    };

    expect(providerSnapshotForModelTarget(target)).toEqual({
      provider: 'dsh',
      authMode: 'platform_subscription',
      route: 'openai-codex',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      credentialReference: 'deployment:codex-default',
      baseUrl: null,
    });
  });

  it('projects API targets into an AllRice-credentialed DSH route', () => {
    const target: ResolvedModelTarget = {
      ...targetBase,
      harness: 'dsh',
      provider: 'minimax-cn',
      authMode: 'api_key',
      model: 'MiniMax-M3',
      reasoningEffort: 'high',
      credentialReference: 'credential:minimax',
      baseUrl: 'https://api.minimax.chat/v1',
    };

    expect(providerSnapshotForModelTarget(target)).toEqual({
      provider: 'dsh',
      authMode: 'allrice_credential',
      route: 'openai-compatible',
      model: 'MiniMax-M3',
      reasoningEffort: 'high',
      credentialReference: 'credential:minimax',
      baseUrl: 'https://api.minimax.chat/v1',
    });
  });

  it('reuses the exact frozen fallback snapshot during replay', () => {
    const original: HarnessExecutionSnapshot = {
      provider: 'dsh',
      authMode: 'platform_subscription',
      route: 'openai-codex',
      model: 'primary-model',
      reasoningEffort: 'xhigh',
      credentialReference: 'deployment:codex-default',
      baseUrl: null,
    };
    const fallback: HarnessExecutionSnapshot = {
      provider: 'dsh',
      authMode: 'allrice_credential',
      route: 'openai-compatible',
      model: 'fallback-model',
      reasoningEffort: 'medium',
      credentialReference: 'credential:fallback',
      baseUrl: 'https://provider.example/v1',
    };

    expect(
      replayProviderSnapshot({
        decision: decision({
          harness: 'dsh',
          provider: 'minimax-cn',
          model: 'fallback-model',
        }),
        original,
        fallbacks: [fallback],
        reasoningEffort: 'high',
      }),
    ).toBe(fallback);
  });

  it('rejects a DSH replay that cannot be reconstructed from a Codex snapshot', () => {
    const original: HarnessExecutionSnapshot = {
      provider: 'codex',
      authMode: 'chatgpt_subscription',
      model: 'gpt-old',
      reasoningEffort: 'high',
      sandbox: 'workspace-write',
    };

    expect(() =>
      replayProviderSnapshot({
        decision: decision({
          harness: 'dsh',
          provider: 'minimax-cn',
          model: 'MiniMax-M3',
        }),
        original,
        reasoningEffort: 'high',
      }),
    ).toThrowError(expect.objectContaining({ code: 'ROUTE_REPLAY_INVALID' }));
  });
});
