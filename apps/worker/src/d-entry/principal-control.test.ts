import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionId } from '@deepseek-ai/dsh-session';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import {
  hostFixture,
  deferred,
  observeNativeFollow,
} from '../../../../packages/d-entry-principal/test/host-fixture.js';
import { createDEntryPrincipalControl } from './principal-control.js';

type Fixture = Awaited<ReturnType<typeof hostFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function setup(timeout = 1000) {
  const fixture = await hostFixture();
  fixtures.push(fixture);
  const carrier = new AbortController();
  const control = createDEntryPrincipalControl(fixture.node, {
    carrier: carrier.signal,
    cleanupTimeoutMs: timeout,
  });
  return { ...fixture, carrier, control };
}

describe('Node control uses the real generated issuer over the same native Peer carrier', () => {
  it('acquires inertly, then opens a real non-owner baseline, dispatches and closes its real child streams', async () => {
    const fixture = await setup();
    const read = vi.spyOn(fixture.catalog, 'list');
    const activity = fixture.control.acquire(
      fixture.selected,
      new AbortController().signal,
    );
    expect(read).not.toHaveBeenCalled();
    const scope = await activity.run(new AbortController().signal);
    expect(scope.opened.baseline.owner).toBe(false);
    const eventsSource = scope.stream(
      {
        kind: 'events',
        scopeId: fixture.selected.scopeId,
        payload: { args: {} },
      },
      new AbortController().signal,
    );
    const events = eventsSource[Symbol.asyncIterator]();
    expect(await events.next()).toMatchObject({
      value: {
        type: 'item',
        value: { type: 'ready', clientId: expect.any(String) },
      },
    });
    const page = await scope.invoke(
      {
        scopeId: fixture.selected.scopeId,
        endpoint: 'session/page',
        args: {
          request: {
            address: { kind: 'session', sessionId: SessionId('root') },
            throughSeq: 0,
          },
        },
      },
      new AbortController().signal,
    );
    expect(page).toEqual({
      endpoint: 'session/page',
      value: { records: [], hasMore: false },
    });
    await expect(
      scope.invoke(
        {
          scopeId: fixture.selected.scopeId,
          endpoint: 'session/page',
          args: {
            request: {
              address: { kind: 'session', sessionId: SessionId('other') },
              throughSeq: 0,
            },
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toHaveProperty('code', 'gateway/internal');
    const peer = fixture.catalog.pages[0];
    expect(peer?.principal).toEqual(scope.opened.principal);
    await events.return?.();
    await activity.close();
    expect(peer?.signal.aborted).toBe(true);
    expect(fixture.carrier.signal.aborted).toBe(false);
    await fixture.control.close();
  });

  it('acquire → close → late run sends zero Remote requests', async () => {
    const fixture = await setup();
    const reads = vi.spyOn(fixture.catalog, 'list');
    const activity = fixture.control.acquire(
      fixture.selected,
      new AbortController().signal,
    );
    await activity.close();
    await expect(
      activity.run(new AbortController().signal),
    ).rejects.toBeDefined();
    expect(reads).not.toHaveBeenCalled();
    await fixture.control.close();
  });

  it('publishes the close memo before abort callbacks and joins actual setup before a pre-ACK business cancellation finishes', async () => {
    const fixture = await setup();
    const entered = deferred(),
      release = deferred();
    fixture.catalog.beforeList = async () => {
      entered.resolve();
      await release.promise;
    };
    const business = new AbortController();
    const activity = fixture.control.acquire(fixture.selected, business.signal);
    const running = activity.run(new AbortController().signal);
    void running.catch(() => {});
    await entered.promise;
    let reentrant: Promise<void> | undefined;
    business.signal.addEventListener(
      'abort',
      () => {
        reentrant = activity.close();
      },
      { once: true },
    );
    business.abort();
    const closing = activity.close();
    let finished = false;
    void closing.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(reentrant).toBe(closing);
    release.resolve();
    await closing;
    await expect(running).rejects.toBeDefined();
    expect(fixture.carrier.signal.aborted).toBe(false);
    await fixture.control.close();
  });

  it('business abort keeps cleanup transport alive until true closed/end and does not close another page', async () => {
    const fixture = await setup();
    const business = new AbortController();
    const first = fixture.control.acquire(fixture.selected, business.signal);
    const firstScope = await first.run(new AbortController().signal);
    const nextIssue = { ...fixture.selected, scopeId: randomUUID() };
    const second = fixture.control.acquire(
      nextIssue,
      new AbortController().signal,
    );
    const secondScope = await second.run(new AbortController().signal);
    business.abort();
    expect(firstScope.revoked.aborted).toBe(true);
    await first.close();
    expect(secondScope.revoked.aborted).toBe(false);
    expect(
      await secondScope.invoke(
        {
          scopeId: nextIssue.scopeId,
          endpoint: 'session/page',
          args: {
            request: {
              address: { kind: 'session', sessionId: SessionId('root') },
              throughSeq: 0,
            },
          },
        },
        new AbortController().signal,
      ),
    ).toMatchObject({ endpoint: 'session/page' });
    await second.close();
    await fixture.control.close();
  });

  it.each(['child', 'page', 'business'] as const)(
    '%s close joins an actual pending RemoteAccess next without poisoning another activity',
    async (mode) => {
      const fixture = await setup(),
        business = new AbortController(),
        childSignal = new AbortController();
      const activity = fixture.control.acquire(
        fixture.selected,
        business.signal,
      );
      const scope = await activity.run(new AbortController().signal);
      const otherIssue = { ...fixture.selected, scopeId: randomUUID() };
      const other = fixture.control.acquire(
        otherIssue,
        new AbortController().signal,
      );
      const otherScope = await other.run(new AbortController().signal);
      const observed = observeNativeFollow(fixture.host, 'remoteAccess/follow');
      const streamSource = scope.stream(
        {
          endpoint: 'remoteAccess/follow',
          scopeId: fixture.selected.scopeId,
          args: {},
        },
        childSignal.signal,
      );
      const stream = streamSource[Symbol.asyncIterator]();
      expect(await stream.next()).toMatchObject({
        value: { type: 'item', value: { type: 'baseline', owner: false } },
      });
      const pending = stream.next();
      void pending.catch(() => {});
      await observed.pending.promise;
      expect(observed.pendingSettled).toBe(false);
      if (mode === 'child') childSignal.abort();
      else if (mode === 'business') business.abort();
      else void activity.close().catch(() => {});
      await expect(pending).rejects.toBeDefined();
      if (mode === 'child') {
        expect(scope.revoked.aborted).toBe(false);
        expect(
          await scope.invoke(
            {
              scopeId: fixture.selected.scopeId,
              endpoint: 'session/page',
              args: {
                request: {
                  address: { kind: 'session', sessionId: SessionId('root') },
                  throughSeq: 0,
                },
              },
            },
            new AbortController().signal,
          ),
        ).toMatchObject({ endpoint: 'session/page' });
      }
      await activity.close();
      await observed.returned.promise;
      expect(observed.pendingSettled).toBe(true);
      expect(observed.returnJoined).toBe(true);
      expect(otherScope.revoked.aborted).toBe(false);
      expect(fixture.carrier.signal.aborted).toBe(false);
      expect(
        await otherScope.invoke(
          {
            scopeId: otherIssue.scopeId,
            endpoint: 'session/page',
            args: {
              request: {
                address: { kind: 'session', sessionId: SessionId('root') },
                throughSeq: 0,
              },
            },
          },
          new AbortController().signal,
        ),
      ).toMatchObject({ endpoint: 'session/page' });
      await other.close();
      await fixture.control.close();
    },
  );

  it('page close joins the real pending session/follow and its held native finally before resolving', async () => {
    const fixture = await setup();
    const activity = fixture.control.acquire(
      fixture.selected,
      new AbortController().signal,
    );
    const scope = await activity.run(new AbortController().signal);
    const observed = observeNativeFollow(fixture.host, 'session/follow');
    const entered = deferred(),
      release = deferred();
    fixture.catalog.afterFollow = async () => {
      entered.resolve();
      await release.promise;
    };
    const streamSource = scope.stream(
      {
        endpoint: 'session/follow',
        scopeId: fixture.selected.scopeId,
        args: {
          request: {
            address: { kind: 'session', sessionId: SessionId('root') },
          },
        },
      },
      new AbortController().signal,
    );
    const stream = streamSource[Symbol.asyncIterator]();
    expect(await stream.next()).toMatchObject({
      value: { type: 'item', value: { type: 'snapshot' } },
    });
    const pending = stream.next();
    void pending.catch(() => {});
    await observed.pending.promise;
    expect(observed.pendingSettled).toBe(false);
    const closing = activity.close();
    let finished = false;
    void closing.then(() => {
      finished = true;
    });
    await entered.promise;
    expect(finished).toBe(false);
    expect(observed.pendingSettled).toBe(false);
    release.resolve();
    await closing;
    await expect(pending).rejects.toBeDefined();
    expect(observed.returnJoined).toBe(true);
    await fixture.control.close();
  });

  it.each(['child', 'page'] as const)(
    '%s close waits for an actual session/follow setup read and consumes exact closed/end without poisoning another activity',
    async (mode) => {
      const fixture = await setup();
      const activity = fixture.control.acquire(
        fixture.selected,
        new AbortController().signal,
      );
      const scope = await activity.run(new AbortController().signal);
      const otherIssue = { ...fixture.selected, scopeId: randomUUID() };
      const other = fixture.control.acquire(
        otherIssue,
        new AbortController().signal,
      );
      const otherScope = await other.run(new AbortController().signal);
      const original = fixture.wire.open;
      if (!original) throw Error('actual carrier missing');
      const frames: unknown[] = [];
      let ended = false;
      vi.spyOn(fixture.wire, 'open').mockImplementation(
        (channel, endpoint, payload, signal, uplink) => {
          const source = original(channel, endpoint, payload, signal, uplink);
          if (endpoint !== 'allricePrincipal/streamScoped') return source;
          return {
            async *[Symbol.asyncIterator]() {
              for await (const row of source) {
                frames.push(row);
                yield row;
              }
              ended = true;
            },
          };
        },
      );
      const entered = deferred(),
        release = deferred(),
        child = new AbortController();
      let readSettled = false;
      fixture.catalog.beforeList = async () => {
        entered.resolve();
        await release.promise;
        readSettled = true;
      };
      const streamSource = scope.stream(
        {
          scopeId: fixture.selected.scopeId,
          endpoint: 'session/follow',
          args: {
            request: {
              address: { kind: 'session', sessionId: SessionId('root') },
            },
          },
        },
        child.signal,
      );
      const stream = streamSource[Symbol.asyncIterator]();
      const pending = stream.next();
      void pending.catch(() => {});
      await entered.promise;
      if (mode === 'child') child.abort();
      const closing =
        mode === 'page'
          ? activity.close()
          : pending.then(
              () => {},
              () => {},
            );
      let finished = false;
      void closing.then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      await Promise.resolve();
      try {
        expect(readSettled).toBe(false);
        expect(finished).toBe(false);
        expect(frames).toEqual([]);
        expect(ended).toBe(false);
        expect(fixture.catalog.follows).toHaveLength(0);
      } finally {
        release.resolve();
      }
      await closing;
      await expect(pending).rejects.toBeDefined();
      expect(readSettled).toBe(true);
      expect(frames).toEqual([
        { type: 'closed', scopeId: fixture.selected.scopeId },
      ]);
      expect(ended).toBe(true);
      expect(fixture.catalog.follows).toHaveLength(0);
      if (mode === 'child') expect(scope.revoked.aborted).toBe(false);
      await activity.close();
      expect(otherScope.revoked.aborted).toBe(false);
      expect(fixture.carrier.signal.aborted).toBe(false);
      fixture.catalog.beforeList = undefined;
      expect(
        await otherScope.invoke(
          {
            scopeId: otherIssue.scopeId,
            endpoint: 'session/page',
            args: {
              request: {
                address: { kind: 'session', sessionId: SessionId('root') },
                throughSeq: 0,
              },
            },
          },
          new AbortController().signal,
        ),
      ).toMatchObject({ endpoint: 'session/page' });
      await other.close();
      await fixture.control.close();
    },
  );

  it.each(['active', 'child-close'] as const)(
    'preserves a real setup business failure with details during %s, without synthesizing a closed ACK',
    async (mode) => {
      const fixture = await setup();
      const activity = fixture.control.acquire(
        fixture.selected,
        new AbortController().signal,
      );
      const scope = await activity.run(new AbortController().signal);
      const entered = deferred(),
        release = deferred(),
        child = new AbortController();
      const failure = new RemoteError(
        'subagent/catalog-diagnostic',
        'actual setup catalog diagnostic',
        {
          parentSessionId: SessionId('root'),
          childSessionId: SessionId('child'),
          reason: 'unavailable',
        },
      );
      fixture.catalog.beforeList = async () => {
        entered.resolve();
        await release.promise;
        throw failure;
      };
      const streamSource = scope.stream(
        {
          scopeId: fixture.selected.scopeId,
          endpoint: 'session/follow',
          args: {
            request: {
              address: { kind: 'session', sessionId: SessionId('root') },
            },
          },
        },
        child.signal,
      );
      const stream = streamSource[Symbol.asyncIterator]();
      const pending = stream.next();
      void pending.catch(() => {});
      await entered.promise;
      if (mode === 'child-close') child.abort();
      release.resolve();
      await expect(pending).rejects.toMatchObject({
        code: failure.code,
        message: failure.message,
        details: failure.details,
      });
      expect(fixture.catalog.follows).toHaveLength(0);
      const closing = activity.close();
      expect(activity.close()).toBe(closing);
      await expect(closing).rejects.toThrow('PRINCIPAL_JOIN_UNKNOWN');
      await expect(closing).rejects.toMatchObject({
        cause: {
          errors: [
            expect.objectContaining({
              message: 'PRINCIPAL_JOIN_UNKNOWN',
              cause: expect.objectContaining({
                code: failure.code,
                message: failure.message,
                details: failure.details,
              }),
            }),
          ],
        },
      });
      await fixture.control.drainLocal();
      await expect(fixture.control.close()).rejects.toThrow(
        'PRINCIPAL_JOIN_UNKNOWN',
      );
    },
  );

  it('keeps carrier loss during a held setup remote unknown and never dispatches a late follow', async () => {
    const fixture = await setup();
    const activity = fixture.control.acquire(
      fixture.selected,
      new AbortController().signal,
    );
    const scope = await activity.run(new AbortController().signal);
    const entered = deferred(),
      release = deferred();
    fixture.catalog.beforeList = async () => {
      entered.resolve();
      await release.promise;
    };
    const streamSource = scope.stream(
      {
        scopeId: fixture.selected.scopeId,
        endpoint: 'session/follow',
        args: {
          request: {
            address: { kind: 'session', sessionId: SessionId('root') },
          },
        },
      },
      new AbortController().signal,
    );
    const stream = streamSource[Symbol.asyncIterator]();
    const pending = stream.next();
    void pending.catch(() => {});
    await entered.promise;
    fixture.carrier.abort(Error('actual carrier lost'));
    const drained = fixture.control.drainLocal();
    let finished = false;
    void drained.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    await Promise.resolve();
    try {
      expect(finished).toBe(false);
    } finally {
      release.resolve();
    }
    await drained;
    await expect(pending).rejects.toBeDefined();
    expect(fixture.catalog.follows).toHaveLength(0);
    await expect(activity.close()).rejects.toThrow('PRINCIPAL_JOIN_UNKNOWN');
    await expect(fixture.control.close()).rejects.toThrow(
      'PRINCIPAL_JOIN_UNKNOWN',
    );
  });

  it.each(['before', 'after'] as const)(
    'preserves native code/message/details on a %s-first-frame failure while close remains sticky unknown',
    async (position) => {
      const fixture = await setup();
      const activity = fixture.control.acquire(
        fixture.selected,
        new AbortController().signal,
      );
      const scope = await activity.run(new AbortController().signal);
      const failure = new RemoteError(
        'subagent/catalog-diagnostic',
        `native follow ${position} snapshot diagnostic`,
        {
          parentSessionId: SessionId('root'),
          childSessionId: SessionId('child'),
          reason: 'unavailable',
        },
      );
      const fail = async () => {
        throw failure;
      };
      if (position === 'before') fixture.catalog.beforeFollow = fail;
      else fixture.catalog.afterFollowSnapshot = fail;
      const streamSource = scope.stream(
        {
          endpoint: 'session/follow',
          scopeId: fixture.selected.scopeId,
          args: {
            request: {
              address: { kind: 'session', sessionId: SessionId('root') },
            },
          },
        },
        new AbortController().signal,
      );
      const stream = streamSource[Symbol.asyncIterator]();
      if (position === 'after')
        expect(await stream.next()).toMatchObject({
          value: { type: 'item', value: { type: 'snapshot' } },
        });
      await expect(stream.next()).rejects.toMatchObject({
        code: failure.code,
        message: failure.message,
        details: failure.details,
      });
      const closing = activity.close();
      expect(activity.close()).toBe(closing);
      await expect(closing).rejects.toThrow('PRINCIPAL_JOIN_UNKNOWN');
      await expect(closing).rejects.toMatchObject({
        cause: {
          errors: [
            expect.objectContaining({
              message: 'PRINCIPAL_JOIN_UNKNOWN',
              cause: expect.objectContaining({
                code: failure.code,
                message: failure.message,
                details: failure.details,
              }),
            }),
          ],
        },
      });
      await fixture.control.drainLocal();
      await expect(activity.close()).rejects.toThrow('PRINCIPAL_JOIN_UNKNOWN');
      await expect(fixture.control.close()).rejects.toThrow(
        'PRINCIPAL_JOIN_UNKNOWN',
      );
    },
  );

  it('joins an actual in-flight native catalog read and never dispatches its late business call after close', async () => {
    const fixture = await setup();
    const activity = fixture.control.acquire(
      fixture.selected,
      new AbortController().signal,
    );
    const scope = await activity.run(new AbortController().signal);
    const entered = deferred(),
      release = deferred();
    fixture.catalog.beforeList = async () => {
      entered.resolve();
      await release.promise;
    };
    const request = scope.invoke(
      {
        scopeId: fixture.selected.scopeId,
        endpoint: 'session/page',
        args: {
          request: {
            address: { kind: 'session', sessionId: SessionId('root') },
            throughSeq: 0,
          },
        },
      },
      new AbortController().signal,
    );
    void request.catch(() => {});
    await entered.promise;
    let finished = false;
    const closing = activity.close().then(() => {
      finished = true;
    });
    expect(scope.revoked.aborted).toBe(true);
    await Promise.resolve();
    expect(finished).toBe(false);
    release.resolve();
    await closing;
    await expect(request).rejects.toBeDefined();
    expect(fixture.catalog.pages).toHaveLength(0);
    await fixture.control.close();
  });

  it('withholds late business items after synchronous fence and joins real children even if nobody starts reading', async () => {
    const fixture = await setup();
    const activity = fixture.control.acquire(
      fixture.selected,
      new AbortController().signal,
    );
    const scope = await activity.run(new AbortController().signal);
    const stream = scope.stream(
      {
        endpoint: 'remoteAccess/follow',
        scopeId: fixture.selected.scopeId,
        args: {},
      },
      new AbortController().signal,
    );
    fixture.control.fence(Error('original authority revoked'));
    expect(scope.revoked.aborted).toBe(true);
    await activity.close();
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toBeDefined();
    await fixture.control.close();
  });

  it('carrier loss joins local pumps but remains remote unknown; confirmed-stop retirement never needs a dead Host ACK', async () => {
    const fixture = await setup();
    const activity = fixture.control.acquire(
      fixture.selected,
      new AbortController().signal,
    );
    const scope = await activity.run(new AbortController().signal);
    fixture.control.fence(Error('binding lost'));
    fixture.carrier.abort();
    await fixture.control.drainLocal();
    expect(scope.revoked.aborted).toBe(true);
    await expect(activity.close()).rejects.toThrow('PRINCIPAL_JOIN_UNKNOWN');
    await fixture.control.retireAfterNativeStop();
    expect(() =>
      fixture.control.acquire(
        { ...fixture.selected, scopeId: randomUUID() },
        new AbortController().signal,
      ),
    ).toThrow('PRINCIPAL_CONTROL_CLOSED');
  });

  it('withholds an actual ready delayed in transport after revocation and waits that stream terminal before closing the page', async () => {
    const fixture = await setup();
    const entered = deferred(),
      release = deferred();
    const original = fixture.wire.open;
    if (!original) throw Error('actual carrier missing');
    vi.spyOn(fixture.wire, 'open').mockImplementation(
      (channel, endpoint, payload, signal, uplink) => {
        const source = original(channel, endpoint, payload, signal, uplink);
        return {
          async *[Symbol.asyncIterator]() {
            for await (const row of source) {
              const value: unknown =
                typeof row === 'object' && row
                  ? Reflect.get(row, 'value')
                  : undefined;
              if (
                endpoint === 'allricePrincipal/streamScoped' &&
                typeof value === 'object' &&
                value &&
                Reflect.get(value, 'type') === 'ready'
              ) {
                entered.resolve();
                await release.promise;
              }
              yield row;
            }
          },
        };
      },
    );
    const activity = fixture.control.acquire(
      fixture.selected,
      new AbortController().signal,
    );
    const scope = await activity.run(new AbortController().signal);
    const stream = scope.stream(
      {
        kind: 'events',
        scopeId: fixture.selected.scopeId,
        payload: { args: {} },
      },
      new AbortController().signal,
    );
    await entered.promise;
    fixture.control.fence(Error('membership revoked'));
    const closing = activity.close();
    let finished = false;
    void closing.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    release.resolve();
    await closing;
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toBeDefined();
    await fixture.control.close();
  });

  it('does not replace missing exact closed with terminal/end or a successful local dispose', async () => {
    const fixture = await setup(25);
    const original = fixture.wire.open;
    if (!original) throw Error('actual fixture carrier missing');
    vi.spyOn(fixture.wire, 'open').mockImplementation(
      (channel, endpoint, payload, signal, uplink) => {
        const source = original(channel, endpoint, payload, signal, uplink);
        // Fault injection only: retain actual opened/native source, drop only
        // the exact ACK to model a truncated downlink. No fabricated baseline.
        return {
          async *[Symbol.asyncIterator]() {
            for await (const row of source)
              if (!(
                typeof row === 'object' &&
                row &&
                Reflect.get(row, 'type') === 'closed'
              ))
                yield row;
          },
        };
      },
    );
    const activity = fixture.control.acquire(
      fixture.selected,
      new AbortController().signal,
    );
    await activity.run(new AbortController().signal);
    await expect(activity.close()).rejects.toThrow('PRINCIPAL_JOIN_UNKNOWN');
    await fixture.control.drainLocal();
    await expect(fixture.control.close()).rejects.toThrow(
      'PRINCIPAL_JOIN_UNKNOWN',
    );
  });
});
