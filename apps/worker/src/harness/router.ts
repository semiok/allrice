import type {
  EmployeeRuntimePolicy,
  HarnessExecutionSnapshot,
  HarnessKind,
  RouteReasonCode,
} from '@allrice/contracts';

import { HandlerError } from '../errors.js';
import type { HarnessAdapter } from './adapter.js';
import { DshHarnessAdapter } from './dsh-adapter.js';

/** ChatFlow Runtime router for provider-native Harness implementations. */
export class HarnessRouter {
  private readonly adapters: ReadonlyMap<HarnessKind, HarnessAdapter>;

  constructor(adapters: readonly HarnessAdapter[] = [new DshHarnessAdapter()]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
  }

  resolve(kind: HarnessKind) {
    const adapter = this.adapters.get(kind);
    if (!adapter) {
      throw new HandlerError(
        'HARNESS_UNSUPPORTED',
        `Harness ${kind} is not available in this deployment`,
        false,
      );
    }
    return adapter;
  }

  select(input: {
    runtimePolicy: EmployeeRuntimePolicy;
    providerSnapshot: HarnessExecutionSnapshot;
    fallbackSnapshots?: readonly HarnessExecutionSnapshot[];
    providerHealth?: Partial<Record<HarnessKind, 'available' | 'unavailable'>>;
    excludedRoutes?: readonly string[];
    allowRuntimePolicyFallbacks?: boolean;
  }): {
    adapter: HarnessAdapter;
    providerSnapshot: HarnessExecutionSnapshot;
    reasonCode: Extract<
      RouteReasonCode,
      'primary_provider_selected' | 'fallback_provider_selected'
    >;
  } {
    const fallbacks = (
      input.allowRuntimePolicyFallbacks === false
        ? []
        : input.runtimePolicy.fallbackModels
    ).reduce<HarnessExecutionSnapshot[]>((result, fallback) => {
      const codexPrefix = fallback.startsWith('codex:')
        ? 'codex:'
        : fallback.startsWith('codex/')
          ? 'codex/'
          : null;
      const dshPrefix = fallback.startsWith('dsh:')
        ? 'dsh:'
        : fallback.startsWith('dsh/')
          ? 'dsh/'
          : null;
      if (codexPrefix) {
        const model = fallback.slice(codexPrefix.length).trim();
        if (!model) return result;
        result.push({
          provider: 'dsh',
          authMode: 'platform_subscription',
          route: 'openai-codex',
          model,
          reasoningEffort:
            input.runtimePolicy.reasoningEffort === 'none'
              ? 'low'
              : input.runtimePolicy.reasoningEffort,
          credentialReference: 'deployment:codex-default',
          baseUrl: null,
        });
        return result;
      }
      const geminiPrefix = fallback.startsWith('gemini:')
        ? 'gemini:'
        : fallback.startsWith('gemini/')
          ? 'gemini/'
          : null;
      if (geminiPrefix) {
        const model = fallback.slice(geminiPrefix.length).trim();
        if (!model) return result;
        result.push({
          provider: 'dsh',
          authMode: 'allrice_credential',
          route: 'gemini',
          model,
          reasoningEffort:
            input.runtimePolicy.reasoningEffort === 'none'
              ? 'medium'
              : input.runtimePolicy.reasoningEffort,
          credentialReference: 'deployment:gemini-default',
          baseUrl: null,
        });
        return result;
      }
      if (input.providerSnapshot.provider !== 'dsh') return result;
      const model = (
        dshPrefix ? fallback.slice(dshPrefix.length) : fallback
      ).trim();
      if (!model) return result;
      result.push({ ...input.providerSnapshot, model });
      return result;
    }, []);
    const candidateMap = new Map<string, HarnessExecutionSnapshot>();
    for (const snapshot of [
      normalizeDshSnapshot(input.providerSnapshot),
      ...(input.fallbackSnapshots ?? []).map(normalizeDshSnapshot),
      ...fallbacks,
    ]) {
      candidateMap.set(harnessRouteKey(snapshot), snapshot);
    }
    const candidates = [...candidateMap.values()];
    const excludedRoutes = new Set(input.excludedRoutes ?? []);
    for (const [index, snapshot] of candidates.entries()) {
      const kind: HarnessKind = 'dsh';
      const adapter = this.adapters.get(kind);
      if (
        excludedRoutes.has(harnessRouteKey(snapshot)) ||
        !adapter ||
        input.providerHealth?.[kind] === 'unavailable' ||
        (adapter.isConfigured && !adapter.isConfigured(snapshot))
      ) {
        continue;
      }
      return {
        adapter,
        providerSnapshot: normalizeDshSnapshot(snapshot),
        reasonCode:
          index === 0
            ? 'primary_provider_selected'
            : 'fallback_provider_selected',
      };
    }
    throw new HandlerError(
      'PROVIDER_UNAVAILABLE',
      'No configured and healthy DSH Provider route is available',
      true,
    );
  }

  async close() {
    await Promise.allSettled(
      [...this.adapters.values()].map((adapter) =>
        adapter.close ? adapter.close() : Promise.resolve(),
      ),
    );
  }

  runtimeInventory() {
    return [...this.adapters.values()].flatMap((adapter) =>
      adapter.runtimeInventory ? [...adapter.runtimeInventory()] : [],
    );
  }
}

export function harnessRouteKey(snapshot: HarnessExecutionSnapshot) {
  const normalized = normalizeDshSnapshot(snapshot);
  return ['dsh', normalized.route, normalized.model].join(':');
}

/**
 * Legacy Codex snapshots remain readable for durable replay, but execution is
 * always delegated to the single DSH Harness as its openai-codex Provider.
 */
export function normalizeDshSnapshot(
  snapshot: HarnessExecutionSnapshot,
): Extract<HarnessExecutionSnapshot, { provider: 'dsh' }> {
  return snapshot.provider === 'dsh'
    ? snapshot
    : {
        provider: 'dsh',
        authMode: 'platform_subscription',
        route: 'openai-codex',
        model: snapshot.model,
        reasoningEffort: snapshot.reasoningEffort,
        credentialReference: 'deployment:codex-default',
        baseUrl: null,
      };
}

export function failedDecisionRouteKey(input: {
  harness: HarnessKind;
  provider: string;
  model: string;
}) {
  return [input.harness, input.provider, input.model].join(':');
}

export function classifyProviderFailure(errorCode: string | null) {
  if (!errorCode) return null;
  const normalized = errorCode.toUpperCase();
  if (
    normalized.includes('RATE_LIMIT') ||
    normalized.includes('TOO_MANY_REQUESTS') ||
    normalized.includes('HTTP_429')
  ) {
    return 'rate_limited' as const;
  }
  if (normalized.includes('TIMEOUT') || normalized.includes('TIMED_OUT')) {
    return 'timeout' as const;
  }
  if (
    normalized.includes('UNAVAILABLE') ||
    normalized.includes('NOT_CONFIGURED') ||
    normalized.includes('CREDENTIAL') ||
    normalized.includes('AUTH_REQUIRED')
  ) {
    return 'provider_unavailable' as const;
  }
  if (
    normalized.includes('TRANSIENT') ||
    normalized.includes('CONNECTION') ||
    normalized.includes('PROTOCOL') ||
    normalized.includes('EMPTY_RESPONSE')
  ) {
    return 'transient_error' as const;
  }
  return null;
}

const defaultHarnessRouter = new HarnessRouter();

export function getHarnessRouter() {
  return defaultHarnessRouter;
}

export async function closeHarnessAdapters() {
  await defaultHarnessRouter.close();
}
