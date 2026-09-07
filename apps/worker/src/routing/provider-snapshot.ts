import type {
  HarnessExecutionSnapshot,
  ResolvedModelTarget,
  RouteDecision,
} from '@allrice/contracts';

import { HandlerError } from '../errors.js';

export function providerSnapshotForModelTarget(
  target: ResolvedModelTarget,
): HarnessExecutionSnapshot {
  if (target.authMode === 'gemini_oauth' || target.authMode === 'oauth')
    throw new HandlerError(
      'PROVIDER_AUTH_UNSUPPORTED',
      'The frozen provider authorization mode has no reviewed execution adapter',
      false,
    );
  if (target.provider === 'openai-codex' || target.harness === 'codex') {
    return {
      provider: 'dsh',
      authMode: 'platform_subscription',
      route: 'openai-codex',
      model: target.model,
      reasoningEffort:
        target.reasoningEffort === 'none' ? 'low' : target.reasoningEffort,
      credentialReference:
        target.credentialReference ?? 'deployment:codex-default',
      baseUrl: null,
    };
  }
  if (target.provider === 'gemini') {
    return {
      provider: 'dsh',
      authMode: 'allrice_credential',
      route: 'gemini',
      model: target.model,
      reasoningEffort:
        target.reasoningEffort === 'none' ? 'medium' : target.reasoningEffort,
      credentialReference:
        target.credentialReference ?? 'deployment:gemini-default',
      baseUrl: null,
    };
  }
  return {
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
  const route =
    input.decision.harness === 'codex' ||
    ['codex', 'openai-codex'].includes(input.decision.provider)
      ? 'openai-codex'
      : ['deepseek', 'deepseek-official'].includes(input.decision.provider)
        ? 'deepseek-official'
        : ['gemini', 'google'].includes(input.decision.provider)
          ? 'gemini'
          : 'openai-compatible';
  const frozen = [input.original, ...(input.fallbacks ?? [])].find(
    (snapshot) =>
      (snapshot.provider === 'codex' ? 'codex' : 'dsh') ===
        input.decision.harness &&
      snapshot.model === input.decision.model &&
      (snapshot.provider === 'dsh' ? snapshot.route : 'openai-codex') === route,
  );
  if (frozen) return frozen;
  if (
    route === 'gemini' ||
    (input.original.provider === 'dsh' && input.original.route === 'gemini')
  )
    throw new HandlerError(
      'ROUTE_REPLAY_INVALID',
      'Gemini replay requires its original frozen provider snapshot',
      false,
    );
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
  if (input.original.provider !== 'dsh' || input.original.route !== route) {
    throw new HandlerError(
      'ROUTE_REPLAY_INVALID',
      'Stored DSH route cannot be reconstructed from this execution snapshot',
      false,
    );
  }
  return { ...input.original, model: input.decision.model };
}
