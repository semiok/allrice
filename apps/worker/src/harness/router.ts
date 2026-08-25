import type {
  EmployeeRuntimePolicy,
  HarnessExecutionSnapshot,
  HarnessKind,
  RouteReasonCode,
} from '@allrice/contracts';

import { HandlerError } from '../errors.js';
import type { HarnessAdapter } from './adapter.js';
import { CodexHarnessAdapter } from './codex-adapter.js';
import { DshHarnessAdapter } from './dsh-adapter.js';

/** ChatFlow Runtime router for provider-native Harness implementations. */
export class HarnessRouter {
  private readonly adapters: ReadonlyMap<HarnessKind, HarnessAdapter>;

  constructor(
    adapters: readonly HarnessAdapter[] = [
      new CodexHarnessAdapter(),
      new DshHarnessAdapter(),
    ],
  ) {
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
    providerHealth?: Partial<Record<HarnessKind, 'available' | 'unavailable'>>;
  }): {
    adapter: HarnessAdapter;
    providerSnapshot: HarnessExecutionSnapshot;
    reasonCode: Extract<
      RouteReasonCode,
      'primary_harness_selected' | 'fallback_harness_selected'
    >;
  } {
    const fallbacks = input.runtimePolicy.fallbackModels.reduce<
      HarnessExecutionSnapshot[]
    >((result, fallback) => {
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
          provider: 'codex',
          authMode: 'chatgpt_subscription',
          model,
          reasoningEffort:
            input.runtimePolicy.reasoningEffort === 'none'
              ? 'low'
              : input.runtimePolicy.reasoningEffort,
          sandbox: 'workspace-write',
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
    const candidates: HarnessExecutionSnapshot[] = [
      input.providerSnapshot,
      ...fallbacks,
    ];
    for (const [index, snapshot] of candidates.entries()) {
      const kind: HarnessKind = snapshot.provider === 'codex' ? 'codex' : 'dsh';
      const adapter = this.adapters.get(kind);
      if (
        !adapter ||
        input.providerHealth?.[kind] === 'unavailable' ||
        (adapter.isConfigured && !adapter.isConfigured(snapshot))
      ) {
        continue;
      }
      return {
        adapter,
        providerSnapshot: snapshot,
        reasonCode:
          index === 0
            ? 'primary_harness_selected'
            : 'fallback_harness_selected',
      };
    }
    throw new HandlerError(
      'PROVIDER_UNAVAILABLE',
      'No configured and healthy harness route is available',
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
}

const defaultHarnessRouter = new HarnessRouter();

export function getHarnessRouter() {
  return defaultHarnessRouter;
}

export async function closeHarnessAdapters() {
  await defaultHarnessRouter.close();
}
