import type {
  HarnessExecutionSnapshot,
  ResolvedModelTarget,
  RouteDecision,
} from '@allrice/contracts';

import { HandlerError } from '../errors.js';

export function providerSnapshotForModelTarget(
  target: ResolvedModelTarget,
): HarnessExecutionSnapshot {
  return target.provider === 'openai-codex' || target.harness === 'codex'
    ? {
        provider: 'dsh',
        authMode: 'platform_subscription',
        route: 'openai-codex',
        model: target.model,
        reasoningEffort:
          target.reasoningEffort === 'none' ? 'low' : target.reasoningEffort,
        credentialReference:
          target.credentialReference ?? 'deployment:codex-default',
        baseUrl: null,
      }
    : {
        provider: 'dsh',
        authMode: 'allrice_credential',
        route:
          target.provider === 'deepseek-official'
            ? 'deepseek-official'
            : 'openai-compatible',
        model: target.model,
        reasoningEffort: target.reasoningEffort,
        credentialReference: target.credentialReference!,
        baseUrl: target.baseUrl,
      };
}

export function replayProviderSnapshot(input: {
  decision: RouteDecision;
  original: HarnessExecutionSnapshot;
  fallbacks?: readonly HarnessExecutionSnapshot[];
  reasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
}): HarnessExecutionSnapshot {
  const frozen = [input.original, ...(input.fallbacks ?? [])].find(
    (snapshot) =>
      (snapshot.provider === 'codex' ? 'codex' : 'dsh') ===
        input.decision.harness && snapshot.model === input.decision.model,
  );
  if (frozen) return frozen;
  if (
    input.decision.harness === 'codex' ||
    input.decision.provider === 'openai-codex' ||
    input.decision.provider === 'codex'
  ) {
    return {
      provider: 'dsh',
      authMode: 'platform_subscription',
      route: 'openai-codex',
      model: input.decision.model,
      reasoningEffort:
        input.reasoningEffort === 'none' ? 'low' : input.reasoningEffort,
      credentialReference: 'deployment:codex-default',
      baseUrl: null,
    };
  }
  if (input.original.provider !== 'dsh') {
    throw new HandlerError(
      'ROUTE_REPLAY_INVALID',
      'Stored DSH route cannot be reconstructed from this execution snapshot',
      false,
    );
  }
  return { ...input.original, model: input.decision.model };
}
