import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-query';
import type {} from '@deepseek-ai/dsh-subagent';
import {
  Remote,
  TypertRemoteService,
  principalOf,
} from '@deepseek-ai/dsh-typert-protocol';
import type {
  NativeHistoryCut,
  NativeHistoryCutRequest,
  NativeHistorySessionCut,
} from './types.ts';
export type * from './types.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    allriceHistorySource: NativeHistorySource;
  }
}

/** Installed in the existing authenticated Host, never a listener or Agent.
 * Loader registers the official generated ./typert contribution. This endpoint
 * is host-only transport; it does not establish SaaS person/config authority. */
export class NativeHistorySource extends TypertRemoteService {
  static inject: string[] = ['sessionQuery'];
  private readonly lifetime = new AbortController();
  private readonly operations = new Set<Promise<NativeHistoryCut>>();

  constructor(ctx: Context) {
    super(ctx, 'allriceHistorySource', { namespace: 'allriceHistory' });
    ctx.effect(() => async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.operations]);
    });
  }

  /** Export existing local sessions through nonactivating public observations.
   * Unknown/external catalog rows remain facts, but never become local members.
   * @param request - root already selected by the trusted host owner.
   * @param signal - the actual transport request lifetime.
   * @returns JSON of independently observed cuts, with all leases released.
   * NPM-owned native event types have no Typert Zod projection. The official
   * generator owns this string envelope; the host validates its native log
   * through public Session.fromRestore before reusing the history projector.
   */
  @Remote
  async readCut(
    request: NativeHistoryCutRequest,
    signal: AbortSignal,
  ): Promise<string> {
    // Native owner/host-local carrier only. This is not a SaaS identity claim;
    // the Worker still authorizes the actual root/configuration separately.
    if (principalOf(this.ctx.invocation))
      throw new Error('HISTORY_CUT_OWNER_REQUIRED');
    const active = AbortSignal.any([signal, this.lifetime.signal]);
    active.throwIfAborted();
    const operation = this.capture(request, active);
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    );
    return JSON.stringify(await operation);
  }

  private async capture(
    request: NativeHistoryCutRequest,
    signal: AbortSignal,
  ): Promise<NativeHistoryCut> {
    if (!request.rootSessionId.trim()) throw new Error('HISTORY_CUT_INVALID');
    const sessions: NativeHistorySessionCut[] = [];
    const visited = new Set<string>();
    const pending = [request.rootSessionId];
    while (pending.length) {
      signal.throwIfAborted();
      const id = pending.shift()!;
      if (visited.has(id)) throw new Error('HISTORY_CUT_ANCESTRY_CONFLICT');
      visited.add(id);
      let cut: NativeHistorySessionCut;
      {
        using observation = await this.ctx.sessionQuery.observeSession(
          SessionId(id),
          { signal },
        );
        signal.throwIfAborted();
        const catalog = observation.projections?.values.subagentCatalog;
        if (
          !catalog ||
          observation.header.id !== id ||
          observation.header.version !== 4
        )
          throw new Error('HISTORY_CUT_SOURCE_UNAVAILABLE');
        // Materialize the prefix while the SAME observation owns the catalog.
        // Dispose before observing another session; never follow/promote/repair.
        cut = structuredClone({
          meta: observation.header,
          inheritedEventCount: observation.inheritedEventCount,
          events: observation.events,
          catalog,
        });
        if (
          cut.events.some((event, i) => event.seq !== i) ||
          observation.cursor !== cut.events.length - 1 ||
          cut.inheritedEventCount < 0 ||
          cut.inheritedEventCount > cut.events.length
        )
          throw new Error('HISTORY_CUT_INVALID_PREFIX');
      }
      signal.throwIfAborted();
      sessions.push(cut);
      for (const child of cut.catalog) {
        if (child.mode === 'one-shot' || child.mode === 'continuable')
          pending.push(child.id);
      }
    }
    return { rootSessionId: request.rootSessionId, sessions };
  }
}

export default NativeHistorySource;

export const name = 'allrice-native-history-source';
export const inject = NativeHistorySource.inject;
export function apply(ctx: Context): void {
  ctx.plugin(NativeHistorySource);
}
