import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { DEntryPrincipalActivity } from '@allrice/d-entry-principal/types';
import { hostFixture, deferred } from '../../../../packages/d-entry-principal/test/host-fixture.js';
import { createDEntryPrincipalControl } from './principal-control.js';
import { createDEntryPrincipalChildren } from './principal-activity.js';

const fixtures: Awaited<ReturnType<typeof hostFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
function negativeChild() {
  return {
    run: vi.fn<DEntryPrincipalActivity['run']>(() => Promise.reject(Error('fixture should not dispatch'))),
    close: vi.fn(async () => {}),
  };
}

describe('catalog owned activity fences and actual child join', () => {
  it('two wrappers use real issuer/control, register before run and current-check both sides of the actual baseline', async () => {
    const fixture = await hostFixture(); fixtures.push(fixture);
    const control = createDEntryPrincipalControl(fixture.node, { carrier: new AbortController().signal, cleanupTimeoutMs: 1000 });
    const outer = createDEntryPrincipalChildren(new AbortController().signal);
    const inner = createDEntryPrincipalChildren(new AbortController().signal);
    const first = vi.fn(async () => {}), second = vi.fn(async () => {});
    const read = vi.spyOn(fixture.catalog, 'list');
    const activity = outer.acquire({
      signal: new AbortController().signal, assertCurrent: first,
      acquire: (signal) => inner.acquire({ signal, assertCurrent: second, acquire: (active) => control.acquire(fixture.selected, active) }),
    });
    expect(read).not.toHaveBeenCalled();
    const scope = await activity.run(new AbortController().signal);
    expect(scope.opened.baseline.owner).toBe(false);
    expect(first).toHaveBeenCalledTimes(2); expect(second).toHaveBeenCalledTimes(2);
    await outer.close(); await inner.close(); await control.close();
    await expect(activity.run(new AbortController().signal)).rejects.toThrow('PRINCIPAL_SCOPE_CLOSED');
  });

  it('acquire and close without run owns and closes the actual child once, and late run dispatches nothing', async () => {
    const group = createDEntryPrincipalChildren(new AbortController().signal);
    const child = negativeChild(), current = vi.fn(async () => {});
    const activity = group.acquire({ signal: new AbortController().signal, assertCurrent: current, acquire: () => child });
    const first = activity.close(); expect(activity.close()).toBe(first);
    await group.close(); await first;
    await expect(activity.run(new AbortController().signal)).rejects.toBeDefined();
    expect(child.close).toHaveBeenCalledOnce(); expect(child.run).not.toHaveBeenCalled(); expect(current).not.toHaveBeenCalled();
  });

  it('waits the genuine pending pre-run current read after child close; normal stale abort cannot publish a late scope', async () => {
    const group = createDEntryPrincipalChildren(new AbortController().signal);
    const child = negativeChild(), entered = deferred(), release = deferred();
    const activity = group.acquire({ signal: new AbortController().signal, acquire: () => child, assertCurrent: async () => { entered.resolve(); await release.promise; } });
    const running = activity.run(new AbortController().signal); void running.catch(() => {});
    await entered.promise;
    const closing = group.close(); let finished = false;
    void closing.then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false);
    expect(child.close).toHaveBeenCalledOnce();
    release.resolve(); await closing;
    await expect(running).rejects.toBeDefined(); expect(child.run).not.toHaveBeenCalled();
  });

  it('retains a child-close failure as unknown and never substitutes a shared job cancellation', async () => {
    const group = createDEntryPrincipalChildren(new AbortController().signal);
    const child = negativeChild(); child.close.mockRejectedValue(Error('actual child failed to join'));
    const activity = group.acquire({ signal: new AbortController().signal, assertCurrent: async () => {}, acquire: () => child });
    await expect(activity.close()).rejects.toThrow('PRINCIPAL_CHILD_JOIN_UNKNOWN');
    await expect(group.close()).rejects.toThrow('PRINCIPAL_CHILD_JOIN_UNKNOWN');
    expect(child.close).toHaveBeenCalledOnce(); expect(child.run).not.toHaveBeenCalled();
  });

  it('joins the genuine post-baseline current guard before normal close can finish and rejects its late success', async () => {
    const fixture = await hostFixture(); fixtures.push(fixture);
    const control = createDEntryPrincipalControl(fixture.node, { carrier: new AbortController().signal, cleanupTimeoutMs: 1000 });
    const group = createDEntryPrincipalChildren(new AbortController().signal);
    const entered = deferred(), release = deferred();
    let checks = 0;
    const activity = group.acquire({ signal: new AbortController().signal, acquire: (signal) => control.acquire(fixture.selected, signal), assertCurrent: async () => { if (++checks === 2) { entered.resolve(); await release.promise; } } });
    const running = activity.run(new AbortController().signal); void running.catch(() => {});
    await entered.promise;
    let finished = false;
    const closing = group.close().then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false);
    release.resolve(); await closing;
    await expect(running).rejects.toBeDefined(); await control.close();
  });

  it.each(['joined', 'unknown'] as const)('a post-open guard rejection drives actual child cleanup (%s) with outside signals live and no shared cancellation', async (terminal) => {
    const fixture = await hostFixture(); fixtures.push(fixture);
    const carrier = new AbortController(), lifetime = new AbortController(), caller = new AbortController(), request = new AbortController();
    const control = createDEntryPrincipalControl(fixture.node, { carrier: carrier.signal, cleanupTimeoutMs: 1000 });
    const group = createDEntryPrincipalChildren(lifetime.signal);
    const otherIssue = { ...fixture.selected, scopeId: randomUUID() };
    const other = control.acquire(otherIssue, caller.signal), otherScope = await other.run(request.signal);
    const entered = deferred(), release = deferred();
    const open = fixture.wire.open; if (!open) throw Error('actual carrier missing');
    vi.spyOn(fixture.wire, 'open').mockImplementation((channel, endpoint, payload, signal, uplink) => {
      const source = open(channel, endpoint, payload, signal, uplink);
      return { async *[Symbol.asyncIterator]() { for await (const frame of source) {
        if (endpoint === 'allricePrincipal/openScope' && typeof frame === 'object' && frame && Reflect.get(frame, 'type') === 'closed') {
          entered.resolve(); await release.promise;
          if (terminal === 'unknown') continue; // Fault: truncate only the actual close ACK.
        }
        yield frame;
      } } };
    });
    const cleanup = deferred<PromiseSettledResult<void>>(), joins: Promise<void>[] = [];
    const guardError = Error('original current roster/catalog rejection');
    let checks = 0;
    const activity = group.acquire({
      signal: caller.signal,
      assertCurrent: async () => { if (++checks === 2) throw guardError; },
      acquire(signal) {
        const child = control.acquire(fixture.selected, signal), run = child.run.bind(child), close = child.close.bind(child);
        vi.spyOn(child, 'run').mockImplementation(async (current) => {
          const scope = await run(current);
          await scope.invoke({ scopeId: fixture.selected.scopeId, endpoint: 'session/page', args: { request: { address: { kind: 'session', sessionId: SessionId('root') }, throughSeq: 0 } } }, current);
          return scope;
        });
        vi.spyOn(child, 'close').mockImplementation(() => {
          const joined = close(); joins.push(joined);
          void joined.then(() => cleanup.resolve({ status: 'fulfilled', value: undefined }), (reason) => cleanup.resolve({ status: 'rejected', reason }));
          return joined;
        });
        return child;
      },
    });
    await expect(activity.run(request.signal)).rejects.toBe(guardError);
    // No external group/lower close has been called. The failure continuation
    // alone reached the real Host terminal and revoked its actual issued Peer.
    await entered.promise;
    expect(checks).toBe(2); expect(fixture.catalog.pages[0]?.signal.aborted).toBe(true);
    for (const signal of [lifetime.signal, caller.signal, request.signal, carrier.signal]) expect(signal.aborted).toBe(false);
    await expect(activity.run(request.signal)).rejects.toThrow('PRINCIPAL_SCOPE_CLOSED');
    let finished = false;
    const closing = group.close(); void closing.then(() => { finished = true; }, () => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false);
    release.resolve();
    if (terminal === 'joined') { expect((await cleanup.promise).status).toBe('fulfilled'); await closing; }
    else {
      expect((await cleanup.promise).status).toBe('rejected');
      await expect(closing).rejects.toThrow('PRINCIPAL_CHILD_JOIN_UNKNOWN');
      await expect(activity.close()).rejects.toThrow('PRINCIPAL_CHILD_JOIN_UNKNOWN');
    }
    expect(new Set(joins).size).toBe(1);
    expect(otherScope.revoked.aborted).toBe(false);
    expect(await otherScope.invoke({ scopeId: otherIssue.scopeId, endpoint: 'session/page', args: { request: { address: { kind: 'session', sessionId: SessionId('root') }, throughSeq: 0 } } }, request.signal)).toMatchObject({ endpoint: 'session/page' });
    await other.close();
    if (terminal === 'joined') await control.close();
    else { await control.drainLocal(); await expect(control.close()).rejects.toThrow('PRINCIPAL_JOIN_UNKNOWN'); }
  });

  it('registers before a reentrant lower acquisition/close and does not treat thrown undefined as acquired', async () => {
    const group = createDEntryPrincipalChildren(new AbortController().signal);
    let closing: Promise<void> | undefined;
    const activity = group.acquire({ signal: new AbortController().signal, assertCurrent: async () => {}, acquire: () => { closing = group.close(); throw undefined; } });
    await expect(activity.close()).rejects.toThrow('PRINCIPAL_CHILD_JOIN_UNKNOWN');
    if (!closing) throw Error('missing reentrant close');
    await expect(closing).rejects.toThrow('PRINCIPAL_CHILD_JOIN_UNKNOWN');
  });

  it('group/lifetime abort synchronously denies new acquisitions while joining only its own child', async () => {
    const lifetime = new AbortController(), group = createDEntryPrincipalChildren(lifetime.signal);
    const child = negativeChild(), unrelated = negativeChild();
    const activity = group.acquire({ signal: new AbortController().signal, assertCurrent: async () => {}, acquire: () => child });
    lifetime.abort();
    expect(() => group.acquire({ signal: new AbortController().signal, assertCurrent: async () => {}, acquire: () => unrelated })).toThrow();
    await activity.close(); await group.close();
    expect(child.close).toHaveBeenCalledOnce(); expect(unrelated.close).not.toHaveBeenCalled();
  });
});
