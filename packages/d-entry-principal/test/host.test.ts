import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionId } from '@deepseek-ai/dsh-session';
import * as PrincipalHost from '@allrice/d-entry-principal/host';
import { TYPERT_REMOTE } from '@allrice/d-entry-principal/remote';
import { hostFixture, deferred, issue } from './host-fixture.js';

type Fixture = Awaited<ReturnType<typeof hostFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function setup(selected = issue(), install = true) { const value = await hostFixture(selected, install); fixtures.push(value); return value; }
async function opened(fixture: Fixture) {
  const handle = TYPERT_REMOTE.methods['allricePrincipal/openScope'].invoke(fixture.node.remote, { issue: fixture.selected }, new AbortController().signal);
  const iterator = handle[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || first.value.type !== 'opened') throw Error('missing actual opened frame');
  return { handle, iterator, first: first.value };
}
async function close(stream: { send(value: 'close'): void; end(): void }, iterator: AsyncIterator<{ type: string }>) {
  stream.send('close'); stream.end();
  expect(await iterator.next()).toMatchObject({ done: false, value: { type: 'closed' } });
  expect(await iterator.next()).toMatchObject({ done: true });
}

describe('public rc.2 Host issuer, generated faces and real in-process Node carrier', () => {
  it('registers the generated three descriptors and issues non-owner snapshot/follow on the exact same child Peer', async () => {
    const fixture = await setup();
    for (const name of ['openScope', 'invokeScoped', 'streamScoped']) {
      const descriptor = fixture.host.typert.local.get(`allricePrincipal/${name}`);
      expect(descriptor?.parameters.every((parameter) => parameter.codec.mode === 'strict')).toBe(true);
      expect(!!descriptor?.uplink).toBe(name !== 'invokeScoped');
    }
    const scope = await opened(fixture);
    expect(scope.first.baseline.owner).toBe(false);
    expect(scope.first.principal.kind).toBe('allrice-d-entry');
    expect(scope.first.baseline.grants.map((grant) => grant.resource)).toEqual(expect.arrayContaining([{ kind: 'session', id: 'root' }, { kind: 'session', id: 'child' }]));
    expect(JSON.stringify(scope.first.baseline)).not.toContain('other');
    expect(JSON.stringify(scope.first.baseline)).not.toContain('event:');
    const openedNative = vi.spyOn(fixture.host.typertGateway.wireStream, 'open');
    const handle = TYPERT_REMOTE.methods['allricePrincipal/streamScoped'].invoke(fixture.node.remote, { call: { scopeId: fixture.selected.scopeId, endpoint: 'remoteAccess/follow', args: {} } }, new AbortController().signal);
    const iterator = handle[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({ value: { type: 'item', value: scope.first.baseline } });
    const page = await TYPERT_REMOTE.methods['allricePrincipal/invokeScoped'].invoke(fixture.node.remote, { call: { scopeId: fixture.selected.scopeId, endpoint: 'session/page', args: { request: { address: { kind: 'session', sessionId: SessionId('root') }, throughSeq: 0 } } } }, new AbortController().signal);
    expect(page).toEqual({ ok: true, value: { endpoint: 'session/page', value: { records: [], hasMore: false } } });
    const peer = fixture.catalog.pages[0];
    expect(peer).toBeDefined(); expect(peer).not.toBe(fixture.parent);
    expect(peer?.interactions).toBe('answer');
    expect(peer?.principal).toEqual(scope.first.principal);
    if (!peer) throw Error('native page was not dispatched');
    expect(openedNative.mock.calls.find((call) => call[0] === 'remoteAccess/follow')?.[3]).toBe(peer);
    expect(fixture.host.remoteAccess.snapshotFor(peer.principal)).toEqual(scope.first.baseline);
    await close(handle, iterator); await close(scope.handle, scope.iterator);
    expect(peer.signal.aborted).toBe(true);
  });

  it('uses the native special $events entry and first actual ready without granting waterfall/result or business event actions', async () => {
    const fixture = await setup(); const scope = await opened(fixture);
    const openedNative = vi.spyOn(fixture.host.typertGateway.wireStream, 'open');
    const handle = TYPERT_REMOTE.methods['allricePrincipal/streamScoped'].invoke(fixture.node.remote, { call: { kind: 'events', scopeId: fixture.selected.scopeId, payload: { args: {} } } }, new AbortController().signal);
    const iterator = handle[Symbol.asyncIterator]();
    const ready = await iterator.next();
    expect(ready).toMatchObject({ value: { type: 'item', value: { type: 'ready', clientId: expect.any(String), host: { home: '/home/native-fixture' } } } });
    expect(fixture.host.typertGateway.hasLiveClient()).toBe(false);
    const peer = openedNative.mock.calls.find((call) => call[0] === '$events')?.[3];
    if (!peer) throw Error('actual issued Peer was not used for events');
    expect(peer.principal).toEqual(scope.first.principal); expect(peer.interactions).toBe('answer');
    const response = await fixture.host.connection.createSharedFetchHandler('/api').fetch(new Request('http://127.0.0.1/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: '$events/result', payload: { args: {} } }) }), peer);
    expect(await response.json()).toMatchObject({ result: { ok: false, error: { code: 'gateway/invocation-unavailable' } } });
    // No session event grant is approved. Both native session-resource and
    // global notifications are filtered by the actual Gateway before delivery.
    fixture.emit({ event: 'api-session/status', args: [SessionId('root'), true], resources: { session: (sessionId) => sessionId } });
    fixture.emit({ event: 'global-not-approved', args: [] });
    await close(handle, iterator); await close(scope.handle, scope.iterator);
  });

  it('rejects a different parent, undeclared global/control/list actions and raw nested extras before normal decode can erase them', async () => {
    const fixture = await setup(); const scope = await opened(fixture);
    const other = fixture.host.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' });
    const call = { scopeId: fixture.selected.scopeId, endpoint: 'session/page', args: { request: { address: { kind: 'session', sessionId: 'root' }, throughSeq: 0 } } };
    await expect(fixture.host.typertGateway.invoke({ namespace: 'allricePrincipal', method: 'invokeScoped', args: { call }, peer: other })).rejects.toThrow('PRINCIPAL_SCOPE_CLOSED');
    for (const endpoint of ['session/list', 'session/control', 'session/modelCatalog', 'settings/read', 'workspace/list', '$events/result']) {
      await expect(fixture.host.typertGateway.invoke({ namespace: 'allricePrincipal', method: 'invokeScoped', args: { call: { ...call, endpoint } }, peer: fixture.parent })).rejects.toBeDefined();
    }
    await expect(fixture.host.typertGateway.invoke({ namespace: 'allricePrincipal', method: 'invokeScoped', args: { call: { ...call, args: { request: { ...call.args.request, address: { ...call.args.request.address, owner: true } } } } }, peer: fixture.parent })).rejects.toBeDefined();
    expect(fixture.catalog.pages).toHaveLength(0);
    await close(scope.handle, scope.iterator); await other.dispose();
  });

  it('denies a sibling session and history writes through native resource policy, without affecting another page', async () => {
    const fixture = await setup(); const first = await opened(fixture);
    const secondIssue = { ...fixture.selected, scopeId: randomUUID() };
    const second = TYPERT_REMOTE.methods['allricePrincipal/openScope'].invoke(fixture.node.remote, { issue: secondIssue }, new AbortController().signal);
    const secondIterator = second[Symbol.asyncIterator]();
    expect(await secondIterator.next()).toMatchObject({ value: { type: 'opened' } });
    const denied = await TYPERT_REMOTE.methods['allricePrincipal/invokeScoped'].invoke(fixture.node.remote, { call: { scopeId: fixture.selected.scopeId, endpoint: 'session/page', args: { request: { address: { kind: 'session', sessionId: SessionId('other') }, throughSeq: 0 } } } });
    expect(denied.ok).toBe(false);
    expect(JSON.stringify(first.first.baseline)).not.toContain('session/prompt');
    await close(first.handle, first.iterator);
    const page = await TYPERT_REMOTE.methods['allricePrincipal/invokeScoped'].invoke(fixture.node.remote, { call: { scopeId: secondIssue.scopeId, endpoint: 'session/page', args: { request: { address: { kind: 'session', sessionId: SessionId('child') }, throughSeq: 0 } } } });
    expect(page.ok).toBe(true); await close(second, secondIterator);
  });

  it('joins a setup read before pre-ACK close, publishes no late opened, and completes exact closed/end without self waiting', async () => {
    const fixture = await setup(); const entered = deferred(), release = deferred();
    fixture.catalog.beforeList = async () => { entered.resolve(); await release.promise; };
    const handle = TYPERT_REMOTE.methods['allricePrincipal/openScope'].invoke(fixture.node.remote, { issue: fixture.selected });
    const iterator = handle[Symbol.asyncIterator](); const first = iterator.next();
    await entered.promise; handle.send('close'); handle.end();
    let settled = false; void first.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    release.resolve(); expect(await first).toMatchObject({ value: { type: 'closed' } });
    expect(await iterator.next()).toMatchObject({ done: true });
  });

  it('opens on the generated call before any user read, then carries close on that same native uplink and reaches closed/end', async () => {
    const fixture = await setup(); const read = vi.spyOn(fixture.catalog, 'list');
    const handle = TYPERT_REMOTE.methods['allricePrincipal/openScope'].invoke(fixture.node.remote, { issue: fixture.selected });
    await vi.waitFor(() => { expect(read).toHaveBeenCalledOnce(); });
    handle.send('close'); handle.end();
    const frames = [];
    for await (const frame of handle) frames.push(frame);
    expect(frames.at(-1)).toEqual({ type: 'closed', scopeId: fixture.selected.scopeId });
    expect(frames.filter((frame) => frame.type === 'opened').length).toBeLessThanOrEqual(1);
  });

  it('fails closed on invalid identity/UUID and rolls metadata back after partial service initialization', async () => {
    const fixture = await setup(issue(), false);
    const duplicate = fixture.host.remoteAccess.registerPolicy('allrice-d-entry', { bindings: () => [] });
    await expect(Promise.resolve(fixture.host.plugin(PrincipalHost, fixture.config))).rejects.toBeDefined();
    for (const name of ['openScope', 'invokeScoped', 'streamScoped']) expect(fixture.host.typert.local.get(`allricePrincipal/${name}`)).toBeUndefined();
    duplicate();
    const good = await setup();
    for (const change of [{ scopeId: 'not-uuid' }, { identity: { ...good.selected.identity, personId: randomUUID() } }, { identity: { ...good.selected.identity, threadId: null } }]) {
      const handle = good.wire.open?.('/api', 'allricePrincipal/openScope', { args: { issue: { ...good.selected, ...change } } }, new AbortController().signal);
      if (!handle) throw Error('missing actual carrier');
      await expect(handle[Symbol.asyncIterator]().next()).rejects.toBeDefined();
    }
    expect(good.catalog.pages).toHaveLength(0);
  });

  it('fences every scope on actual parent Peer loss and rejects later dispatch', async () => {
    const fixture = await setup(); const scope = await opened(fixture);
    await fixture.parent.dispose();
    await expect(scope.iterator.next()).rejects.toBeDefined();
    const value = await TYPERT_REMOTE.methods['allricePrincipal/invokeScoped'].invoke(fixture.node.remote, { call: { scopeId: fixture.selected.scopeId, endpoint: 'session/page', args: { request: { address: { kind: 'session', sessionId: SessionId('root') }, throughSeq: 0 } } } });
    expect(value.ok).toBe(false); expect(fixture.catalog.pages).toHaveLength(0);
  });

  it('withdraws both generated metadata and the actual policy when post-install verification fails', async () => {
    const fixture = await setup(issue(), false);
    const local = fixture.host.typert.local;
    const get = local.get.bind(local);
    const fault = vi.spyOn(local, 'get').mockImplementation((endpoint) => endpoint === 'allricePrincipal/streamScoped' ? undefined : get(endpoint));
    await expect(Promise.resolve(fixture.host.plugin(PrincipalHost, fixture.config))).rejects.toBeDefined();
    fault.mockRestore();
    expect(fixture.host.typert.local.get('allricePrincipal/openScope')).toBeUndefined();
    const dispose = fixture.host.remoteAccess.registerPolicy('allrice-d-entry', { bindings: () => [] });
    dispose();
  });
});
