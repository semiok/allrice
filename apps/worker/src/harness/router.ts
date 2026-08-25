import type { HarnessKind } from '@allrice/contracts';

import { HandlerError } from '../errors.js';
import type { HarnessAdapter } from './adapter.js';
import { CodexHarnessAdapter } from './codex-adapter.js';
import { DshHarnessAdapter } from './dsh-adapter.js';

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
