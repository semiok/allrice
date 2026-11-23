import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionId } from '@deepseek-ai/dsh-session';
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';
import * as PrincipalHost from '@allrice/d-entry-principal/host';
import { TYPERT_REMOTE } from '@allrice/d-entry-principal/remote';
import {
  hostFixture,
  deferred,
  issue,
  observeNativeFollow,
} from './host-fixture.js';

type Fixture = Awaited<ReturnType<typeof hostFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function setup(selected = issue(), install = true) {
  const value = await hostFixture(selected, install);
  fixtures.push(value);
  return value;
}
async function opened(fixture: Fixture) {
  const handle = TYPERT_REMOTE.methods['allricePrincipal/openScope'].invoke(
    fixture.node.remote,
    { issue: fixture.selected },
    new AbortController().signal,
  );
  const iterator = handle[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || first.value.type !== 'opened')
    throw Error('missing actual opened frame');
  return { handle, iterator, first: first.value };
}
async function close(
  stream: { send(value: 'close'): void; end(): void },
  iterator: AsyncIterator<{ type: string }>,
) {
  stream.send('close');
  stream.end();
  expect(await iterator.next()).toMatchObject({
    done: false,
    value: { type: 'closed' },
  });
  expect(await iterator.next()).toMatchObject({ done: true });
}
function page(fixture: Fixture, scopeId = fixture.selected.scopeId) {
  return TYPERT_REMOTE.methods['allricePrincipal/invokeScoped'].invoke(
    fixture.node.remote,
    {
      call: {
        scopeId,
        endpoint: 'session/page',
        args: {
          request: {
            address: { kind: 'session', sessionId: SessionId('root') },
            throughSeq: 0,
          },
        },
      },
    },
  );
}
function follow(
  fixture: Fixture,
  endpoint: 'remoteAccess/follow' | 'session/follow',
) {
  return TYPERT_REMOTE.methods['allricePrincipal/streamScoped'].invoke(
    fixture.node.remote,
    {
      call:
        endpoint === 'remoteAccess/follow'
          ? { endpoint, scopeId: fixture.selected.scopeId, args: {} }
          : {
              endpoint,
              scopeId: fixture.selected.scopeId,
              args: {
                request: {
                  address: { kind: 'session', sessionId: SessionId('root') },
                },
              },
            },
    },
  );
}

describe('public rc.2 Host issuer, generated faces and real in-process Node carrier', () => {
  it('registers the generated three descriptors and issues non-owner snapshot/follow on the exact same child Peer', async () => {
    const fixture = await setup();
    for (const name of ['openScope', 'invokeScoped', 'streamScoped']) {
      const descriptor = fixture.host.typert.local.get(
        `allricePrincipal/${name}`,
      );
      expect(
        descriptor?.parameters.every(
          (parameter) => parameter.codec.mode === 'strict',
        ),
      ).toBe(true);
      expect(!!descriptor?.uplink).toBe(name !== 'invokeScoped');
    }
    const scope = await opened(fixture);
    expect(scope.first.baseline.owner).toBe(false);
    expect(scope.first.principal.kind).toBe('allrice-d-entry');
    expect(scope.first.baseline.grants.map((grant) => grant.resource)).toEqual(
      expect.arrayContaining([
        { kind: 'session', id: 'root' },
        { kind: 'session', id: 'child' },
      ]),
    );
    expect(JSON.stringify(scope.first.baseline)).not.toContain('other');
    expect(JSON.stringify(scope.first.baseline)).not.toContain('event:');
    const openedNative = vi.spyOn(
      fixture.host.typertGateway.wireStream,
      'open',
    );
    const handle = TYPERT_REMOTE.methods[
      'allricePrincipal/streamScoped'
    ].invoke(
      fixture.node.remote,
      {
        call: {
          scopeId: fixture.selected.scopeId,
          endpoint: 'remoteAccess/follow',
          args: {},
        },
      },
      new AbortController().signal,
    );
    const iterator = handle[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({
      value: { type: 'item', value: scope.first.baseline },
    });
    const page = await TYPERT_REMOTE.methods[
      'allricePrincipal/invokeScoped'
    ].invoke(
      fixture.node.remote,
      {
        call: {
          scopeId: fixture.selected.scopeId,
          endpoint: 'session/page',
          args: {
            request: {
              address: { kind: 'session', sessionId: SessionId('root') },
              throughSeq: 0,
            },
          },
        },
      },
      new AbortController().signal,
    );
    expect(page).toEqual({
      ok: true,
      value: {
        endpoint: 'session/page',
        value: { records: [], hasMore: false },
      },
    });
    const peer = fixture.catalog.pages[0];
    expect(peer).toBeDefined();
    expect(peer).not.toBe(fixture.parent);
    expect(peer?.interactions).toBe('answer');
    expect(peer?.principal).toEqual(scope.first.principal);
    if (!peer) throw Error('native page was not dispatched');
    expect(
      openedNative.mock.calls.find(
        (call) => call[0] === 'remoteAccess/follow',
      )?.[3],
    ).toBe(peer);
    expect(fixture.host.remoteAccess.snapshotFor(peer.principal)).toEqual(
      scope.first.baseline,
    );
    await close(handle, iterator);
    await close(scope.handle, scope.iterator);
    expect(peer.signal.aborted).toBe(true);
  });

  it('uses the native special $events entry and first actual ready without granting waterfall/result or business event actions', async () => {
    const fixture = await setup();
    const scope = await opened(fixture);
    const openedNative = vi.spyOn(
      fixture.host.typertGateway.wireStream,
      'open',
    );
    const handle = TYPERT_REMOTE.methods[
      'allricePrincipal/streamScoped'
    ].invoke(
      fixture.node.remote,
      {
        call: {
          kind: 'events',
          scopeId: fixture.selected.scopeId,
          payload: { args: {} },
        },
      },
      new AbortController().signal,
    );
    const iterator = handle[Symbol.asyncIterator]();
    const ready = await iterator.next();
    expect(ready).toMatchObject({
      value: {
        type: 'item',
        value: {
          type: 'ready',
          clientId: expect.any(String),
          host: { home: '/home/native-fixture' },
        },
      },
    });
    expect(fixture.host.typertGateway.hasLiveClient()).toBe(false);
    const peer = openedNative.mock.calls.find(
      (call) => call[0] === '$events',
    )?.[3];
    if (!peer) throw Error('actual issued Peer was not used for events');
    expect(peer.principal).toEqual(scope.first.principal);
    expect(peer.interactions).toBe('answer');
    const response = await fixture.host.connection
      .createSharedFetchHandler('/api')
      .fetch(
        new Request('http://127.0.0.1/api/$events/result', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: randomUUID(),
            method: '$events/result',
            payload: { args: {} },
          }),
        }),
        peer,
      );
    expect(await response.json()).toMatchObject({
      result: { ok: false, error: { code: 'gateway/invocation-unavailable' } },
    });
    // No session event grant is approved. Both native session-resource and
    // global notifications are filtered by the actual Gateway before delivery.
    fixture.emit({
      event: 'api-session/status',
      args: [SessionId('root'), true],
      resources: { session: (sessionId) => sessionId },
    });
    fixture.emit({ event: 'global-not-approved', args: [] });
    await close(handle, iterator);
    await close(scope.handle, scope.iterator);
  });

  it('uses the real native Gateway JSON guard before broadcast and removes its event registration on an invalid source value', async () => {
    const fixture = await setup();
    // An isolated native owner exercises the Gateway source contract. The
    // issued AllRice non-owner policy above remains unchanged and denies emits.
    const peer = fixture.host.connection.createPeer({
      principal: { kind: 'owner' },
      interactions: 'answer',
    });
    const source = await fixture.host.typertGateway.wireStream.open(
      '$events',
      { args: {} },
      { async *[Symbol.asyncIterator]() {} },
      peer,
      new AbortController().signal,
    );
    const iterator = source[Symbol.asyncIterator]();
    try {
      expect(await iterator.next()).toMatchObject({
        value: {
          type: 'ready',
          clientId: expect.any(String),
          host: { home: '/home/native-fixture' },
        },
      });
      const args = [null, false, 'native', -2, [1, { nested: true }]];
      fixture.emit({ event: 'native-json-domain-only', args });
      expect(await iterator.next()).toEqual({
        done: false,
        value: { type: 'emit', event: 'native-json-domain-only', args },
      });
      const pending = iterator.next();
      fixture.emit({ event: 'invalid-before-broadcast', args: [undefined] });
      // The official registration fails and ends its queue. It does not
      // promise the same TypeError to every connected consumer.
      expect(await pending).toMatchObject({ done: true });
      expect(fixture.host.typertGateway.hasLiveClient()).toBe(false);
      const unavailable = await fixture.host.typertGateway.wireStream.open(
        '$events',
        { args: {} },
        { async *[Symbol.asyncIterator]() {} },
        peer,
        new AbortController().signal,
      );
      await expect(
        unavailable[Symbol.asyncIterator]().next(),
      ).rejects.toMatchObject({ code: 'gateway/service-unavailable' });
    } finally {
      await iterator.return?.();
      await peer.dispose();
    }
  });

  it.each([
    { name: 'undefined', args: () => [undefined] },
    { name: 'negative zero', args: () => [-0] },
    { name: 'non-finite number', args: () => [Infinity] },
    { name: 'function', args: () => [() => undefined] },
    { name: 'symbol', args: () => [Symbol('not-json')] },
    { name: 'bigint', args: () => [1n] },
    { name: 'sparse array', args: () => Array<unknown>(1) },
    {
      name: 'extra array own key',
      args: () => Object.assign([1], { extra: true }),
    },
    {
      name: 'cycle',
      args: () => {
        const values: unknown[] = [];
        values.push(values);
        return values;
      },
    },
  ])(
    'rejects $name in original emit args at the owned boundary, joins the real event iterator and leaves a sibling activity live',
    async ({ args }) => {
      const fixture = await setup();
      const scope = await opened(fixture);
      const entered = deferred(),
        release = deferred();
      let joined = false;
      const open = fixture.host.typertGateway.wireStream.open.bind(
        fixture.host.typertGateway.wireStream,
      );
      const fault = vi
        .spyOn(fixture.host.typertGateway.wireStream, 'open')
        .mockImplementation(async (...input) => {
          const source = await open(...input);
          if (input[0] !== '$events') return source;
          return {
            [Symbol.asyncIterator]() {
              const iterator = source[Symbol.asyncIterator]();
              let reads = 0;
              return {
                async next(): Promise<IteratorResult<unknown>> {
                  if (++reads === 1) return iterator.next();
                  // Negative output corruption occurs after the actual native
                  // ready. No synthetic positive emit or permission is used.
                  return {
                    done: false,
                    value: {
                      type: 'emit',
                      event: 'corrupted-after-gateway',
                      args: args(),
                    },
                  };
                },
                async return(): Promise<IteratorResult<unknown>> {
                  entered.resolve();
                  await release.promise;
                  const result = await iterator.return?.();
                  joined = true;
                  return result ?? { done: true, value: undefined };
                },
              };
            },
          };
        });
      const handle = TYPERT_REMOTE.methods[
        'allricePrincipal/streamScoped'
      ].invoke(fixture.node.remote, {
        call: {
          kind: 'events',
          scopeId: fixture.selected.scopeId,
          payload: { args: {} },
        },
      });
      const iterator = handle[Symbol.asyncIterator]();
      expect(await iterator.next()).toMatchObject({
        value: { type: 'item', value: { type: 'ready' } },
      });
      const pending = iterator.next();
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await entered.promise;
      try {
        expect(settled).toBe(false);
        expect(joined).toBe(false);
      } finally {
        release.resolve();
      }
      await expect(pending).rejects.toBeDefined();
      expect(joined).toBe(true);
      expect(await iterator.next()).toMatchObject({ done: true });
      fault.mockRestore();
      const sibling = TYPERT_REMOTE.methods[
        'allricePrincipal/streamScoped'
      ].invoke(fixture.node.remote, {
        call: {
          kind: 'events',
          scopeId: fixture.selected.scopeId,
          payload: { args: {} },
        },
      });
      const siblingIterator = sibling[Symbol.asyncIterator]();
      expect(await siblingIterator.next()).toMatchObject({
        value: { type: 'item', value: { type: 'ready' } },
      });
      await close(sibling, siblingIterator);
      await close(scope.handle, scope.iterator);
    },
  );

  it.each(['remoteAccess/follow', 'session/follow'] as const)(
    'typed close joins the real pending second next/return of %s before exact closed/end',
    async (endpoint) => {
      const fixture = await setup(),
        scope = await opened(fixture);
      const observed = observeNativeFollow(fixture.host, endpoint);
      const exiting = deferred(),
        release = deferred();
      if (endpoint === 'session/follow')
        fixture.catalog.afterFollow = async () => {
          exiting.resolve();
          await release.promise;
        };
      const call =
        endpoint === 'remoteAccess/follow'
          ? { scopeId: fixture.selected.scopeId, endpoint, args: {} }
          : {
              scopeId: fixture.selected.scopeId,
              endpoint,
              args: {
                request: {
                  address: {
                    kind: 'session' as const,
                    sessionId: SessionId('root'),
                  },
                },
              },
            };
      const handle = TYPERT_REMOTE.methods[
        'allricePrincipal/streamScoped'
      ].invoke(fixture.node.remote, { call }, new AbortController().signal);
      const iterator = handle[Symbol.asyncIterator]();
      expect(await iterator.next()).toMatchObject({
        value: {
          type: 'item',
          value: {
            type: endpoint === 'remoteAccess/follow' ? 'baseline' : 'snapshot',
          },
        },
      });
      const pending = iterator.next();
      void pending.catch(() => {});
      await observed.pending.promise;
      expect(observed.pendingSettled).toBe(false);
      handle.send('close');
      handle.end();
      if (endpoint === 'session/follow') {
        await exiting.promise;
        expect(observed.pendingSettled).toBe(false);
        expect(observed.returnJoined).toBe(false);
        release.resolve();
      }
      expect(await pending).toEqual({
        done: false,
        value: { type: 'closed', scopeId: fixture.selected.scopeId },
      });
      expect(observed.pendingSettled).toBe(true);
      expect(observed.returnJoined).toBe(true);
      expect(
        observed.errors.map((error) => remoteErrorOf(error)?.code),
      ).toEqual(['gateway/cancelled']);
      expect(await iterator.next()).toMatchObject({ done: true });
      await close(scope.handle, scope.iterator);
    },
  );

  it.each(['child', 'page'] as const)(
    '%s close joins a held session/follow setup read before exact closed/end, without late follow or sibling loss',
    async (mode) => {
      const fixture = await setup(),
        scope = await opened(fixture);
      const otherIssue = { ...fixture.selected, scopeId: randomUUID() };
      const other = TYPERT_REMOTE.methods['allricePrincipal/openScope'].invoke(
        fixture.node.remote,
        { issue: otherIssue },
      );
      const otherIterator = other[Symbol.asyncIterator]();
      expect(await otherIterator.next()).toMatchObject({
        value: { type: 'opened' },
      });
      const entered = deferred(),
        release = deferred();
      let readSettled = false;
      fixture.catalog.beforeList = async () => {
        entered.resolve();
        await release.promise;
        readSettled = true;
      };
      const native = vi.spyOn(fixture.host.typertGateway.wireStream, 'open');
      const handle = TYPERT_REMOTE.methods[
        'allricePrincipal/streamScoped'
      ].invoke(fixture.node.remote, {
        call: {
          scopeId: fixture.selected.scopeId,
          endpoint: 'session/follow',
          args: {
            request: {
              address: { kind: 'session', sessionId: SessionId('root') },
            },
          },
        },
      });
      const iterator = handle[Symbol.asyncIterator]();
      const pending = iterator.next();
      let finished = false;
      void pending.then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      await entered.promise;
      const pageClosing =
        mode === 'page' ? close(scope.handle, scope.iterator) : undefined;
      if (mode === 'child') {
        handle.send('close');
        handle.end();
      }
      let pageFinished = false;
      void pageClosing?.then(() => {
        pageFinished = true;
      });
      await Promise.resolve();
      try {
        expect(readSettled).toBe(false);
        expect(finished).toBe(false);
        expect(pageFinished).toBe(false);
        expect(fixture.catalog.follows).toHaveLength(0);
      } finally {
        release.resolve();
      }
      expect(await pending).toEqual({
        done: false,
        value: { type: 'closed', scopeId: fixture.selected.scopeId },
      });
      expect(readSettled).toBe(true);
      expect(await iterator.next()).toMatchObject({ done: true });
      expect(fixture.catalog.follows).toHaveLength(0);
      expect(
        native.mock.calls.some((call) => call[0] === 'session/follow'),
      ).toBe(false);
      if (pageClosing) await pageClosing;
      else await close(scope.handle, scope.iterator);
      fixture.catalog.beforeList = undefined;
      expect(
        await TYPERT_REMOTE.methods['allricePrincipal/invokeScoped'].invoke(
          fixture.node.remote,
          {
            call: {
              scopeId: otherIssue.scopeId,
              endpoint: 'session/page',
              args: {
                request: {
                  address: { kind: 'session', sessionId: SessionId('root') },
                  throughSeq: 0,
                },
              },
            },
          },
        ),
      ).toMatchObject({ ok: true });
      await close(other, otherIterator);
    },
  );

  it.each(['remoteAccess/follow', 'session/follow'] as const)(
    'page close fences overlapping page/%s before awaiting the real refresh and delivers no late native work',
    async (endpoint) => {
      const fixture = await setup(),
        scope = await opened(fixture);
      const entered = deferred(),
        release = deferred();
      let readSignal: AbortSignal | undefined,
        readSettled = false;
      fixture.catalog.beforeList = async (signal) => {
        readSignal = signal;
        entered.resolve();
        await release.promise;
        readSettled = true;
      };
      const unary = page(fixture);
      let unarySettled = false;
      void unary.then(
        () => {
          unarySettled = true;
        },
        () => {
          unarySettled = true;
        },
      );
      await entered.promise;
      const native = vi.spyOn(fixture.host.typertGateway.wireStream, 'open');
      const handle = follow(fixture, endpoint);
      const iterator = handle[Symbol.asyncIterator]();
      const first = iterator.next();
      let streamSettled = false;
      void first.then(
        () => {
          streamSettled = true;
        },
        () => {
          streamSettled = true;
        },
      );
      const closing = (async () => {
        await vi.waitFor(() =>
          expect(
            fixture.host.allricePrincipal.scopes.get(fixture.selected.scopeId)
              ?.children.size,
          ).toBe(1),
        );
        await close(scope.handle, scope.iterator);
      })();
      let closed = false;
      void closing.then(
        () => {
          closed = true;
        },
        () => {
          closed = true;
        },
      );
      try {
        await vi.waitFor(() => expect(readSignal?.aborted).toBe(true));
        expect(readSettled).toBe(false);
        expect(unarySettled).toBe(false);
        expect(streamSettled).toBe(false);
        expect(closed).toBe(false);
        const baseline = fixture.host.remoteAccess.snapshotFor(
          scope.first.principal,
        );
        expect(baseline.owner).toBe(false);
        if (baseline.owner) throw Error('issued Peer received owner baseline');
        expect(baseline.grants).toEqual([]);
      } finally {
        release.resolve();
      }
      expect(await unary).toMatchObject({ ok: false });
      expect(await first).toEqual({
        done: false,
        value: { type: 'closed', scopeId: fixture.selected.scopeId },
      });
      expect(await iterator.next()).toMatchObject({ done: true });
      await closing;
      expect(readSettled).toBe(true);
      expect(native.mock.calls.some((call) => call[0] === endpoint)).toBe(
        false,
      );
      expect(fixture.catalog.pages).toHaveLength(0);
      expect(fixture.catalog.follows).toHaveLength(0);
      expect(await page(fixture)).toMatchObject({ ok: false });
      fixture.catalog.beforeList = undefined;
      const otherIssue = { ...fixture.selected, scopeId: randomUUID() };
      const other = TYPERT_REMOTE.methods['allricePrincipal/openScope'].invoke(
        fixture.node.remote,
        { issue: otherIssue },
      );
      const otherIterator = other[Symbol.asyncIterator]();
      expect(await otherIterator.next()).toMatchObject({
        value: { type: 'opened' },
      });
      expect(await page(fixture, otherIssue.scopeId)).toMatchObject({
        ok: true,
      });
      await close(other, otherIterator);
    },
  );

  it('keeps native root removal fenced while overlapping page/self-follow await a real read, preserves its failure and joins without late delivery', async () => {
    const fixture = await setup(),
      scope = await opened(fixture);
    const entered = deferred(),
      release = deferred();
    let readSettled = false;
    fixture.catalog.beforeList = async () => {
      entered.resolve();
      await release.promise;
      readSettled = true;
    };
    const unary = page(fixture);
    void unary.catch(() => {});
    await entered.promise;
    const native = vi.spyOn(fixture.host.typertGateway.wireStream, 'open');
    const handle = follow(fixture, 'remoteAccess/follow');
    const iterator = handle[Symbol.asyncIterator]();
    const first = iterator.next();
    void first.catch(() => {});
    try {
      await vi.waitFor(() =>
        expect(
          fixture.host.allricePrincipal.scopes.get(fixture.selected.scopeId)
            ?.children.size,
        ).toBe(1),
      );
      fixture.catalog.items = fixture.catalog.items.filter(
        (row) => String(row.sessionId) !== 'root',
      );
      fixture.host.emit('api-session/removed', SessionId('root'));
      const baseline = fixture.host.remoteAccess.snapshotFor(
        scope.first.principal,
      );
      expect(baseline.owner).toBe(false);
      if (baseline.owner) throw Error('issued Peer received owner baseline');
      expect(baseline.grants).toEqual([]);
      expect(readSettled).toBe(false);
      expect(fixture.catalog.pages).toHaveLength(0);
      expect(fixture.catalog.follows).toHaveLength(0);
    } finally {
      release.resolve();
    }
    expect(await unary).toMatchObject({ ok: false });
    await expect(first).rejects.toThrow('PRINCIPAL_ROOT_INVALID');
    expect(await iterator.next()).toMatchObject({ done: true });
    await close(scope.handle, scope.iterator);
    expect(readSettled).toBe(true);
    expect(
      native.mock.calls.some((call) => call[0] === 'remoteAccess/follow'),
    ).toBe(false);
    expect(await page(fixture)).toMatchObject({ ok: false });
    expect(fixture.catalog.pages).toHaveLength(0);
    expect(fixture.parent.signal.aborted).toBe(false);
  });

  it('rejects a different parent, undeclared global/control/list actions and raw nested extras before normal decode can erase them', async () => {
    const fixture = await setup();
    const scope = await opened(fixture);
    const other = fixture.host.connection.createPeer({
      principal: { kind: 'owner' },
      interactions: 'none',
    });
    const call = {
      scopeId: fixture.selected.scopeId,
      endpoint: 'session/page',
      args: {
        request: {
          address: { kind: 'session', sessionId: 'root' },
          throughSeq: 0,
        },
      },
    };
    await expect(
      fixture.host.typertGateway.invoke({
        namespace: 'allricePrincipal',
        method: 'invokeScoped',
        args: { call },
        peer: other,
      }),
    ).rejects.toThrow('PRINCIPAL_SCOPE_CLOSED');
    for (const endpoint of [
      'session/list',
      'session/control',
      'session/modelCatalog',
      'settings/read',
      'workspace/list',
      '$events/result',
    ]) {
      await expect(
        fixture.host.typertGateway.invoke({
          namespace: 'allricePrincipal',
          method: 'invokeScoped',
          args: { call: { ...call, endpoint } },
          peer: fixture.parent,
        }),
      ).rejects.toBeDefined();
    }
    await expect(
      fixture.host.typertGateway.invoke({
        namespace: 'allricePrincipal',
        method: 'invokeScoped',
        args: {
          call: {
            ...call,
            args: {
              request: {
                ...call.args.request,
                address: { ...call.args.request.address, owner: true },
              },
            },
          },
        },
        peer: fixture.parent,
      }),
    ).rejects.toBeDefined();
    expect(fixture.catalog.pages).toHaveLength(0);
    await close(scope.handle, scope.iterator);
    await other.dispose();
  });

  it('denies a sibling session and history writes through native resource policy, without affecting another page', async () => {
    const fixture = await setup();
    const first = await opened(fixture);
    const secondIssue = { ...fixture.selected, scopeId: randomUUID() };
    const second = TYPERT_REMOTE.methods['allricePrincipal/openScope'].invoke(
      fixture.node.remote,
      { issue: secondIssue },
      new AbortController().signal,
    );
    const secondIterator = second[Symbol.asyncIterator]();
    expect(await secondIterator.next()).toMatchObject({
      value: { type: 'opened' },
    });
    const denied = await TYPERT_REMOTE.methods[
      'allricePrincipal/invokeScoped'
    ].invoke(fixture.node.remote, {
      call: {
        scopeId: fixture.selected.scopeId,
        endpoint: 'session/page',
        args: {
          request: {
            address: { kind: 'session', sessionId: SessionId('other') },
            throughSeq: 0,
          },
        },
      },
    });
    expect(denied.ok).toBe(false);
    expect(JSON.stringify(first.first.baseline)).not.toContain(
      'session/prompt',
    );
    await close(first.handle, first.iterator);
    const page = await TYPERT_REMOTE.methods[
      'allricePrincipal/invokeScoped'
    ].invoke(fixture.node.remote, {
      call: {
        scopeId: secondIssue.scopeId,
        endpoint: 'session/page',
        args: {
          request: {
            address: { kind: 'session', sessionId: SessionId('child') },
            throughSeq: 0,
          },
        },
      },
    });
    expect(page.ok).toBe(true);
    await close(second, secondIterator);
  });

  it('joins a setup read before pre-ACK close, publishes no late opened, and completes exact closed/end without self waiting', async () => {
    const fixture = await setup();
    const entered = deferred(),
      release = deferred();
    fixture.catalog.beforeList = async () => {
      entered.resolve();
      await release.promise;
    };
    const handle = TYPERT_REMOTE.methods['allricePrincipal/openScope'].invoke(
      fixture.node.remote,
      { issue: fixture.selected },
    );
    const iterator = handle[Symbol.asyncIterator]();
    const first = iterator.next();
    await entered.promise;
    handle.send('close');
    handle.end();
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    expect(await first).toMatchObject({ value: { type: 'closed' } });
    expect(await iterator.next()).toMatchObject({ done: true });
  });

  it('opens on the generated call before any user read, then carries close on that same native uplink and reaches closed/end', async () => {
    const fixture = await setup();
    const read = vi.spyOn(fixture.catalog, 'list');
    const handle = TYPERT_REMOTE.methods['allricePrincipal/openScope'].invoke(
      fixture.node.remote,
      { issue: fixture.selected },
    );
    await vi.waitFor(() => {
      expect(read).toHaveBeenCalledOnce();
    });
    handle.send('close');
    handle.end();
    const frames = [];
    for await (const frame of handle) frames.push(frame);
    expect(frames.at(-1)).toEqual({
      type: 'closed',
      scopeId: fixture.selected.scopeId,
    });
    expect(
      frames.filter((frame) => frame.type === 'opened').length,
    ).toBeLessThanOrEqual(1);
  });

  it('fails closed on invalid identity/UUID and rolls metadata back after partial service initialization', async () => {
    const fixture = await setup(issue(), false);
    const duplicate = fixture.host.remoteAccess.registerPolicy(
      'allrice-d-entry',
      { bindings: () => [] },
    );
    await expect(
      Promise.resolve(fixture.host.plugin(PrincipalHost, fixture.config)),
    ).rejects.toBeDefined();
    for (const name of ['openScope', 'invokeScoped', 'streamScoped'])
      expect(
        fixture.host.typert.local.get(`allricePrincipal/${name}`),
      ).toBeUndefined();
    duplicate();
    const good = await setup();
    for (const change of [
      { scopeId: 'not-uuid' },
      { identity: { ...good.selected.identity, personId: randomUUID() } },
      { identity: { ...good.selected.identity, threadId: null } },
    ]) {
      const handle = good.wire.open?.(
        '/api',
        'allricePrincipal/openScope',
        { args: { issue: { ...good.selected, ...change } } },
        new AbortController().signal,
      );
      if (!handle) throw Error('missing actual carrier');
      await expect(handle[Symbol.asyncIterator]().next()).rejects.toBeDefined();
    }
    expect(good.catalog.pages).toHaveLength(0);
  });

  it('fences every scope on actual parent Peer loss and rejects later dispatch', async () => {
    const fixture = await setup();
    const scope = await opened(fixture);
    await fixture.parent.dispose();
    await expect(scope.iterator.next()).rejects.toBeDefined();
    const value = await TYPERT_REMOTE.methods[
      'allricePrincipal/invokeScoped'
    ].invoke(fixture.node.remote, {
      call: {
        scopeId: fixture.selected.scopeId,
        endpoint: 'session/page',
        args: {
          request: {
            address: { kind: 'session', sessionId: SessionId('root') },
            throughSeq: 0,
          },
        },
      },
    });
    expect(value.ok).toBe(false);
    expect(fixture.catalog.pages).toHaveLength(0);
  });

  it('withdraws both generated metadata and the actual policy when post-install verification fails', async () => {
    const fixture = await setup(issue(), false);
    const local = fixture.host.typert.local;
    const get = vi
      .fn(local.get)
      .mockImplementation((endpoint) =>
        endpoint === 'allricePrincipal/streamScoped'
          ? undefined
          : local.get(endpoint),
      );
    // The public accessor creates a new Context-bound view on every read.
    const fault = vi
      .spyOn(fixture.host.typert, 'local', 'get')
      .mockReturnValue({ ...local, get });
    try {
      await expect(
        Promise.resolve(
          fixture.host.plugin(PrincipalHost, fixture.config),
        ).then(() => undefined),
      ).rejects.toThrow('PRINCIPAL_METADATA_INVALID');
      expect(get).toHaveBeenCalledWith('allricePrincipal/streamScoped');
    } finally {
      fault.mockRestore();
    }
    expect(
      fixture.host.typert.local.get('allricePrincipal/openScope'),
    ).toBeUndefined();
    const dispose = fixture.host.remoteAccess.registerPolicy(
      'allrice-d-entry',
      { bindings: () => [] },
    );
    dispose();
  });
});
