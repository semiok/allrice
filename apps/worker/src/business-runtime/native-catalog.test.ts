import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import type * as Database from '@allrice/database';
import { DataAccessError } from '@allrice/database';
import type { NativeWebOwner } from '../native-web/owner.js';
import {
  DEntryNativeUnavailable,
  dEntryNativeOwnerPort,
} from '../d-entry/native-owner.js';
import {
  deferred,
  nativeEntryFixture,
  nativeEntryServer,
} from '../d-entry/native-entry.fixture.js';
import {
  createDEntryNativeCatalogPort,
  installAssignedDEntryNativeCatalog,
  type PublishedNativeCatalog,
} from './native-catalog.js';

const authority = vi.hoisted(() => ({ identity: vi.fn(), roster: vi.fn() }));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  requireDEntryNativeIdentity: authority.identity,
  readPersonNativeWebRoster: authority.roster,
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.resetAllMocks();
});
function fixture() {
  // Consumer doubles only; no real Session, VM, startup or production installation.
  const base = nativeEntryFixture(),
    lifetime = new AbortController();
  const native = {
    binding: base.binding,
    revoked: base.revoked.signal,
    controlReady: vi.fn(() => true),
    readSessions: vi.fn<NativeWebOwner['readSessions']>(async () => ({
      ok: true as const,
      value: base.catalog,
    })),
    readSessionsFor: vi.fn<NativeWebOwner['readSessionsFor']>(async () => ({
      ok: true as const,
      value: base.catalog,
    })),
    retireAfterNativeStop: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const group = new AbortController();
  let publication: PublishedNativeCatalog = Object.freeze({
    receipt: base.owner.receipt,
    endpoint: base.endpoint,
    bindingRef: base.owner.bindingRef,
    revoked: group.signal,
    owner: native,
  });
  const roster = {
    personId: base.identity.personId,
    organizationId: base.identity.organizationId,
    digest: base.owner.receipt.rosterDigest,
    entries: [base.endpoint],
  };
  const vm = {
    resolve: vi.fn(async () => base.binding),
    assertCurrentBinding: vi.fn(async () => {}),
  };
  const host = {
    vm,
    readRoster: vi.fn(async () => roster),
    catalog: vi.fn(() => publication),
  };
  authority.identity.mockResolvedValue(base.identity);
  authority.roster.mockResolvedValue(roster);
  const assembly = createDEntryNativeCatalogPort({
    host,
    lifetime: lifetime.signal,
  });
  cleanups.push(assembly.close);
  return {
    base,
    native,
    roster,
    vm,
    host,
    assembly,
    lifetime,
    group,
    publication: () => publication,
    replace(next: PublishedNativeCatalog) {
      publication = next;
    },
    resolve: () =>
      assembly.port.resolve(
        base.context,
        base.identity,
        new AbortController().signal,
      ),
  };
}

it('uses each current Session RC, full readonly roster and exact original publication before and after Session/list', async () => {
  const f = fixture(),
    owner = await f.resolve();
  expect(f.native.readSessionsFor).not.toHaveBeenCalled();
  expect(f.vm.resolve).toHaveBeenCalledWith(
    f.base.context,
    expect.any(AbortSignal),
  );
  const current: RequestContext = {
    ...f.base.context,
    requestId: randomUUID(),
    sessionId: randomUUID(),
  };
  authority.identity.mockClear();
  await owner.assertCurrent(current, new AbortController().signal);
  expect(await owner.readSessions(new AbortController().signal)).toEqual({
    ok: true,
    value: f.base.catalog,
  });
  expect(f.native.readSessionsFor).toHaveBeenCalledExactlyOnceWith(
    current,
    expect.any(AbortSignal),
  );
  expect(f.native.readSessions).not.toHaveBeenCalled();
  expect(
    authority.identity.mock.calls.every(([context]) => context === current),
  ).toBe(true);
  expect(f.vm.assertCurrentBinding).toHaveBeenLastCalledWith(
    current,
    f.base.binding,
    expect.any(AbortSignal),
  );
  expect(f.host.readRoster).toHaveBeenLastCalledWith(
    current,
    expect.any(AbortSignal),
  );
  expect(f.native.close).not.toHaveBeenCalled();
  expect(owner).not.toHaveProperty('rpc');
  expect(owner).not.toHaveProperty('history');
});

it('denies a stale request before I/O and permits a later valid current RC without revoking the shared owner', async () => {
  const f = fixture(),
    owner = await f.resolve();
  authority.identity.mockRejectedValueOnce(
    new DataAccessError('authorization_denied'),
  );
  await expect(
    owner.readSessions(new AbortController().signal),
  ).rejects.toMatchObject({ code: 'authorization_denied' });
  expect(f.native.readSessionsFor).not.toHaveBeenCalled();
  expect(owner.revoked.aborted).toBe(false);
  await expect(
    owner.readSessions(new AbortController().signal),
  ).resolves.toMatchObject({ ok: true });
  expect(f.native.readSessionsFor).toHaveBeenCalledTimes(1);
  expect(f.native.close).not.toHaveBeenCalled();
});

it.each([
  'roster',
  'person',
  'organization',
  'missing-entry',
  'binding',
  'endpoint',
] as const)(
  'rejects current %s drift before any native read',
  async (change) => {
    const f = fixture(),
      owner = await f.resolve();
    if (change === 'roster')
      f.host.readRoster.mockResolvedValue({
        ...f.roster,
        digest: 'new-current-roster',
      });
    if (change === 'person')
      f.host.readRoster.mockResolvedValue({
        ...f.roster,
        personId: randomUUID(),
      });
    if (change === 'organization')
      f.host.readRoster.mockResolvedValue({
        ...f.roster,
        organizationId: randomUUID(),
      });
    if (change === 'missing-entry')
      f.host.readRoster.mockResolvedValue({ ...f.roster, entries: [] });
    if (change === 'binding')
      f.replace({
        ...f.publication(),
        receipt: {
          ...f.publication().receipt,
          binding: { ...f.base.binding, leaseEpoch: 2 },
        },
      });
    if (change === 'endpoint')
      f.replace({
        ...f.publication(),
        endpoint: { ...f.base.endpoint, hostPort: 54321 },
      });
    await expect(
      owner.readSessions(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(f.native.readSessionsFor).not.toHaveBeenCalled();
  },
);

it.each(['receipt', 'endpoint', 'ref', 'owner'] as const)(
  'does not rebind a resolved handle to a replacement %s',
  async (change) => {
    const f = fixture(),
      owner = await f.resolve(),
      original = f.publication();
    f.replace({
      ...original,
      ...(change === 'receipt' ? { receipt: { ...original.receipt } } : {}),
      ...(change === 'endpoint' ? { endpoint: { ...original.endpoint } } : {}),
      ...(change === 'ref' ? { bindingRef: 'new-host-group-ref' } : {}),
      ...(change === 'owner' ? { owner: { ...f.native } } : {}),
    });
    await expect(
      owner.readSessions(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(f.native.readSessionsFor).not.toHaveBeenCalled();
  },
);

it('drops a result when current authority changes during I/O, after its actual read settles', async () => {
  const f = fixture(),
    owner = await f.resolve(),
    entered = deferred<void>(),
    joined = deferred<void>();
  f.native.readSessionsFor.mockImplementationOnce(async () => {
    entered.resolve();
    await joined.promise;
    return { ok: true, value: f.base.catalog };
  });
  let ended = false;
  const reading = owner
    .readSessions(new AbortController().signal)
    .catch((error: unknown) => error)
    .finally(() => {
      ended = true;
    });
  try {
    await entered.promise;
    authority.identity.mockResolvedValue({
      ...f.base.identity,
      employeeRevision: 2,
    });
    await new Promise<void>((done) => setImmediate(done));
    expect(ended).toBe(false);
  } finally {
    joined.resolve();
  }
  expect(await reading).toMatchObject({ code: 'authorization_denied' });
  expect(f.native.readSessionsFor).toHaveBeenCalledTimes(1);
  expect(f.native.close).not.toHaveBeenCalled();
});

it('close cancels new admission but waits for the actual readonly SQL guard', async () => {
  const f = fixture(),
    entered = deferred<void>(),
    joined = deferred<void>(),
    caller = new AbortController();
  f.host.readRoster.mockImplementationOnce(async () => {
    entered.resolve();
    await joined.promise;
    return f.roster;
  });
  const resolving = f.assembly.port
    .resolve(f.base.context, f.base.identity, caller.signal)
    .catch((error: unknown) => error);
  await entered.promise;
  caller.abort();
  let ended = false;
  const closing = f.assembly.close().then(() => {
    ended = true;
  });
  try {
    await new Promise<void>((done) => setImmediate(done));
    expect(ended).toBe(false);
    await expect(f.resolve()).rejects.toBeInstanceOf(DEntryNativeUnavailable);
    expect(f.host.catalog).not.toHaveBeenCalled();
  } finally {
    joined.resolve();
  }
  expect(await resolving).toBeDefined();
  await closing;
  expect(f.native.readSessionsFor).not.toHaveBeenCalled();
});

it('close joins a native read that ignores cancellation, without closing the shared native owner', async () => {
  const f = fixture(),
    owner = await f.resolve(),
    entered = deferred<void>(),
    joined = deferred<void>();
  f.native.readSessionsFor.mockImplementationOnce(async () => {
    entered.resolve();
    await joined.promise;
    return { ok: true, value: f.base.catalog };
  });
  const reading = owner
    .readSessions(new AbortController().signal)
    .catch((error: unknown) => error);
  await entered.promise;
  let ended = false;
  const closing = f.assembly.close().then(() => {
    ended = true;
  });
  try {
    await new Promise<void>((done) => setImmediate(done));
    expect(owner.revoked.aborted).toBe(true);
    expect(ended).toBe(false);
    expect(f.native.close).not.toHaveBeenCalled();
  } finally {
    joined.resolve();
  }
  expect(await reading).toBeInstanceOf(DEntryNativeUnavailable);
  await closing;
});

it.each(['group', 'native'] as const)(
  'actual %s revocation invalidates the issued handle before I/O',
  async (source) => {
    const f = fixture(),
      owner = await f.resolve();
    (source === 'group' ? f.group : f.base.revoked).abort();
    expect(owner.revoked.aborted).toBe(true);
    expect(owner.controlReady()).toBe(false);
    await expect(
      owner.readSessions(new AbortController().signal),
    ).rejects.toBeDefined();
    expect(f.native.readSessionsFor).not.toHaveBeenCalled();
  },
);

it('the concrete installer binds real readonly producer calls; catalog installation still leaves root/RPC/resource closed', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  await expect(
    dEntryNativeOwnerPort.resolve(f.base.context, f.base.identity, signal),
  ).rejects.toBeInstanceOf(DEntryNativeUnavailable);
  const startup = {
    catalog: vi.fn(() => ({ ...f.publication(), owner: f.native })),
  };
  const installed = installAssignedDEntryNativeCatalog({
    vm: f.vm,
    startup,
    lifetime: f.lifetime.signal,
  });
  cleanups.push(installed.close);
  const server = await nativeEntryServer(f.base, {
    ...f.base.deps,
    owner: dEntryNativeOwnerPort,
    data: () => undefined,
  });
  cleanups.push(server.close);
  expect((await server.request()).status).toBe(200);
  expect(authority.roster).toHaveBeenCalledWith(f.base.context);
  expect(startup.catalog).toHaveBeenCalledWith(
    f.base.binding,
    f.base.identity.employeeInstanceId,
  );
  expect(f.native.readSessionsFor).not.toHaveBeenCalled();
  const prompt = {
    ...f.base.body,
    endpoint: 'session/prompt',
    payload: {
      args: {
        request: {
          requestId: 'catalog-cannot-send',
          sessionId: 'dsh-root',
          mode: 'queue',
          content: [{ type: 'text', text: 'hello' }],
        },
      },
    },
  };
  for (const [path, body] of [
    ['native-root', f.base.body],
    ['native-rpc', prompt],
    ['native-resource', { ...f.base.body, nativeSessionId: 'dsh-child' }],
  ] as const)
    expect((await server.request(path, body)).status).toBe(503);
  expect(f.base.data.acquireRoot).not.toHaveBeenCalled();
  expect(f.base.data.acquireRpc).not.toHaveBeenCalled();
  expect(f.base.owner.readSessions).not.toHaveBeenCalled();
  expect(f.native.readSessionsFor).not.toHaveBeenCalled();
  await installed.close();
  await expect(
    dEntryNativeOwnerPort.resolve(f.base.context, f.base.identity, signal),
  ).rejects.toBeInstanceOf(DEntryNativeUnavailable);
});

it('lifetime abort uninstalls synchronously and revokes previously issued discovery without substituting another Host', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  const installed = installAssignedDEntryNativeCatalog({
    vm: f.vm,
    startup: { catalog: () => ({ ...f.publication(), owner: f.native }) },
    lifetime: f.lifetime.signal,
  });
  cleanups.push(installed.close);
  const owner = await dEntryNativeOwnerPort.resolve(
    f.base.context,
    f.base.identity,
    signal,
  );
  f.lifetime.abort();
  expect(owner.revoked.aborted).toBe(true);
  await expect(
    dEntryNativeOwnerPort.resolve(f.base.context, f.base.identity, signal),
  ).rejects.toBeInstanceOf(DEntryNativeUnavailable);
  expect(f.native.close).not.toHaveBeenCalled();
});
