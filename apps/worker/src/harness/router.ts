import type { HarnessKind } from '@allrice/contracts';

import { HandlerError } from '../errors.js';
import type { HarnessAdapter } from './adapter.js';
import { CodexHarnessAdapter } from './codex-adapter.js';

export class HarnessRouter {
  private readonly adapters: ReadonlyMap<HarnessKind, HarnessAdapter>;

  constructor(
    adapters: readonly HarnessAdapter[] = [new CodexHarnessAdapter()],
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
}
