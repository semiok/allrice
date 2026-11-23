import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  HostHistoryBinding,
  HostHistorySnapshot,
  HostHistoryStorePort,
  HostHistoryPage,
  RequestContext,
  StorageObject,
} from '@allrice/contracts';
import { makeObjectKey } from '@allrice/contracts';
import type * as Database from '@allrice/database';
import { DataAccessError, type DEntryHistoryRootPin } from '@allrice/database';
import {
  HostHistoryStore,
  hostHistoryDigest,
  HostHistoryIntegrityError,
  HostHistorySourceStore,
  LocalStorageAdapter,
  type HostHistorySource,
} from '@allrice/storage';
import { createColdHistorySource } from './history-source';
import {
  createDEntryHistoryHandlers,
  parseDEntryHistoryRequest,
} from './history';
import type { DEntryHistoryAttachmentPort } from './history-download';

const authority = vi.hoisted(() => ({
  identity: vi.fn(),
  generation: vi.fn(),
}));
vi.mock('./identity', () => ({ resolveDEntryIdentity: authority.identity }));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getSessionExecutionGeneration: authority.generation,
}));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const signal = () => new AbortController().signal;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cold-history-'));
  roots.push(root);
  const raw = new HostHistoryStore(root),
    sources = new HostHistorySourceStore(root, raw);
  const b: HostHistoryBinding = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    personId: randomUUID(),
    employeeInstanceId: randomUUID(),
    threadId: randomUUID(),
    nativeInstanceRef: 'original-instance',
    nativeProfileRef: 'original-profile',
    nativeSessionId: 'root',
    rootNativeSessionId: 'root',
    parentNativeSessionId: null,
    configurationRef: 'original-release',
    configurationDigest: hostHistoryDigest('original-config'),
    executionGeneration: '4.0',
  };
  const pin: DEntryHistoryRootPin = {
    identity: {
      organizationId: b.organizationId,
      workspaceId: b.workspaceId,
      personId: b.personId,
      employeeInstanceId: b.employeeInstanceId,
      employeeRevision: 4,
      employeeVersionId: randomUUID(),
      threadId: b.threadId,
    },
    rootNativeSessionId: 'root',
    rootOriginDigest: hostHistoryDigest('original-sql-root'),
    rootBindingRef: 'original-root-binding',
    vmId: randomUUID(),
  };
  const context = {
    organizationId: b.organizationId,
    workspaceId: b.workspaceId,
    sessionId: randomUUID(),
    actor: { id: b.personId, type: 'user' },
  } as RequestContext;
  authority.identity.mockResolvedValue(pin.identity);
  authority.generation.mockResolvedValue('4.0');
  const header = {
    id: 'root',
    version: 4 as const,
    createdAt: 1,
    isSeeded: false,
  };
  const snapshot = (count: number): HostHistorySnapshot => ({
    schemaVersion: 1,
    binding: b,
    source: {
      dshVersion: '0.2.1-rc.2',
      sessionFormatVersion: 4,
      headerHash: hostHistoryDigest(header),
      inheritedEventCount: 0,
      throughSeq: count - 1,
      eventHashes: Array.from({ length: count }, (_, index) =>
        hostHistoryDigest({ index }),
      ),
    },
    entries: [],
    attachments: [],
    lastTurn: { startSeq: null, endSeq: null, reason: null },
  });
  const firstDigest = await raw.publish(snapshot(0), signal());
  const key = {
    organizationId: b.organizationId,
    workspaceId: b.workspaceId,
    personId: b.personId,
    employeeInstanceId: b.employeeInstanceId,
    threadId: b.threadId,
    rootNativeSessionId: pin.rootNativeSessionId,
    rootOriginDigest: pin.rootOriginDigest,
    rootBindingRef: pin.rootBindingRef,
    vmId: pin.vmId,
  };
  const manifest: HostHistorySource = {
    schemaVersion: 1,
    key,
    sessions: [{ binding: b, snapshotDigest: firstDigest, header }],
    edges: [],
  };
  return {
    root,
    raw,
    sources,
    b,
    pin,
    context,
    snapshot,
    key,
    manifest,
    firstDigest,
  };
}

async function contentFixture() {
  const f = await fixture();
  const bytes = new TextEncoder().encode('nonempty committed attachment');
  const object: StorageObject = {
    id: randomUUID(),
    organizationId: f.b.organizationId,
    workspaceId: f.b.workspaceId,
    ownerId: f.b.personId,
    key: '',
    checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    sizeBytes: bytes.byteLength,
    mediaType: 'text/plain',
    immutable: true,
    deletedAt: null,
    retentionUntil: null,
  };
  object.key = makeObjectKey({
    organizationId: object.organizationId,
    workspaceId: object.workspaceId,
    ownerId: object.ownerId,
    category: 'exports',
    objectId: object.id,
  });
  const objects = new LocalStorageAdapter(join(f.root, 'objects'));
  await objects.put(object, new Blob([bytes]).stream());
  const attachment = {
    sourceSeq: 0,
    objectId: object.id,
    checksum: object.checksum,
    sizeBytes: object.sizeBytes,
    mediaType: object.mediaType,
    fileName: 'history.txt',
  };
  const snapshot = (count: number): HostHistorySnapshot => ({
    ...f.snapshot(count),
    entries: Array.from({ length: count }, (_, seq) => ({
      kind: 'message',
      seq,
      time: seq,
      role: 'user',
      text: `original-${seq}`,
      interrupted: false,
    })),
    attachments: [attachment],
  });
  f.manifest.sessions[0]!.snapshotDigest = await f.raw.publish(
    snapshot(3),
    signal(),
  );
  await f.sources.publish(f.manifest, signal());
  const owner = {
    object,
    revoked: signal(),
    reauthorize: vi.fn(async (active: AbortSignal) => {
      active.throwIfAborted();
      return object;
    }),
    open: vi.fn(async (active: AbortSignal) => {
      active.throwIfAborted();
      return objects.get(object);
    }),
    close: vi.fn(async () => undefined),
  };
  const files: DEntryHistoryAttachmentPort = {
    spoolDirectory: join(f.root, 'spool'),
    acquire: vi.fn(async (_context, _id, active) => {
      active.throwIfAborted();
      return owner;
    }),
  };
  const request = (params: Record<string, string | number> = {}) => {
    const query = new URLSearchParams({
      workspaceId: f.b.workspaceId,
      employeeInstanceId: f.b.employeeInstanceId,
      threadId: f.b.threadId,
      nativeSessionId: f.b.nativeSessionId,
    });
    for (const [key, value] of Object.entries(params))
      query.set(key, String(value));
    return new Request(`https://allrice.example/history?${query}`);
  };
  const compose = (request: Request, method: 'history' | 'download') => {
    const scope = createColdHistorySource({
      sources: f.sources,
      signal: request.signal,
      selection: parseDEntryHistoryRequest(request, method),
    });
    const close = vi.fn(() => scope.close());
    const handlers = createDEntryHistoryHandlers({
      context: async () => f.context,
      binding: scope.binding,
      store: scope.store,
      files,
      resources: {
        resolve: (_identity, id, active) =>
          scope.resolveColdResource(f.context, f.pin, id, active),
      },
      closeAuthority: close,
    });
    return {
      scope,
      close,
      async serve() {
        const response = await handlers[method](request);
        if (method !== 'download' || response.status !== 200 || !response.body)
          await close();
        return response;
      },
    };
  };
  return {
    ...f,
    bytes,
    object,
    owner,
    files,
    request,
    compose,
    snapshot,
    digest: f.manifest.sessions[0]!.snapshotDigest,
  };
}

describe('request-owned cold history composition', () => {
  it('joins a nonempty successful attachment EOF without aborting its completed authority signal', async () => {
    const f = await contentFixture();
    const composed = f.compose(
      f.request({ snapshotDigest: f.digest, objectId: f.object.id }),
      'download',
    );
    const response = await composed.serve();
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).resolves.toEqual(f.bytes.buffer);
    expect(composed.close).toHaveBeenCalledTimes(1);
    expect(f.owner.close).toHaveBeenCalledTimes(1);
    await expect(
      composed.scope.resolveColdResource(f.context, f.pin, 'root', signal()),
    ).rejects.toBeDefined();
  });
  it('reopens the original committed page cursor and attachment after a newer checkpoint, refusing unpublished digests', async () => {
    const f = await contentFixture();
    const first = await f.compose(f.request({ limit: 1 }), 'history').serve();
    expect(first.status).toBe(200);
    const page = (await first.json()) as HostHistoryPage;
    expect(page.nextCursor).toEqual({ snapshotDigest: f.digest, afterSeq: 0 });
    const nextDigest = await f.raw.publish(f.snapshot(4), signal());
    const next = structuredClone(f.manifest);
    next.sessions[0]!.snapshotDigest = nextDigest;
    await f.sources.publish(next, signal());
    const old = await f
      .compose(f.request({ ...page.nextCursor!, limit: 1 }), 'history')
      .serve();
    expect(old.status).toBe(200);
    const continued = (await old.json()) as HostHistoryPage;
    expect(continued.snapshotDigest).toBe(f.digest);
    expect(continued.entries.map((entry) => entry.seq)).toEqual([1]);
    expect(continued.source.throughSeq).toBe(2);
    const downloaded = await f
      .compose(
        f.request({ snapshotDigest: f.digest, objectId: f.object.id }),
        'download',
      )
      .serve();
    expect(downloaded.status).toBe(200);
    await expect(downloaded.arrayBuffer()).resolves.toEqual(f.bytes.buffer);
    const fresh = await f.compose(f.request({ limit: 1 }), 'history').serve();
    expect(((await fresh.json()) as HostHistoryPage).snapshotDigest).toBe(
      nextDigest,
    );
    const unpublished = await f.raw.publish(f.snapshot(5), signal());
    for (const method of ['history', 'download'] as const) {
      const response = await f
        .compose(
          f.request({
            snapshotDigest: unpublished,
            ...(method === 'download'
              ? { objectId: f.object.id }
              : { limit: 1 }),
          }),
          method,
        )
        .serve();
      expect(response.status).toBe(409);
    }
    expect(f.files.acquire).toHaveBeenCalledTimes(1);
  });
  it('reads a stopped/absent VM entirely from committed host files and original config', async () => {
    const f = await fixture();
    await f.sources.publish(f.manifest, signal());
    // No VM/native/lease/prewarm/Agent/credential port exists in this composition.
    const scope = createColdHistorySource({
      sources: f.sources,
      signal: signal(),
    });
    const resource = await scope.resolveColdResource(
      f.context,
      f.pin,
      'root',
      signal(),
    );
    expect(resource.parentNativeSessionId).toBeNull();
    expect(resource.bindingRef).toBe(f.pin.rootBindingRef);
    const binding = await scope.binding(resource, signal());
    expect(binding).toEqual(f.b);
    expect((await scope.store.read(binding, signal()))!.digest).toBe(
      f.firstDigest,
    );
    await scope.close();
    await expect(scope.binding(resource, signal())).rejects.toBeDefined();
  });
  it('freezes resource, binding and all explicit page/download digests to one manifest', async () => {
    const f = await fixture();
    await f.sources.publish(f.manifest, signal());
    const scope = createColdHistorySource({
      sources: f.sources,
      signal: signal(),
    });
    const resource = await scope.resolveColdResource(
      f.context,
      f.pin,
      'root',
      signal(),
    );
    const nextDigest = await f.raw.publish(f.snapshot(1), signal());
    const next = structuredClone(f.manifest);
    next.sessions[0]!.snapshotDigest = nextDigest;
    await f.sources.publish(next, signal());
    expect(
      (await scope.store.read(
        await scope.binding(resource, signal()),
        signal(),
      ))!.digest,
    ).toBe(f.firstDigest);
    await expect(
      scope.store.read(f.b, signal(), nextDigest),
    ).rejects.toBeInstanceOf(HostHistoryIntegrityError);
    const repeat = await scope.resolveColdResource(
      f.context,
      f.pin,
      'root',
      signal(),
    );
    expect(repeat.bindingRef).toBe(resource.bindingRef);
    expect(await scope.binding(repeat, signal())).toEqual(f.b);
    const fresh = createColdHistorySource({
      sources: f.sources,
      signal: signal(),
    });
    await fresh.resolveColdResource(f.context, f.pin, 'root', signal());
    expect((await fresh.store.read(f.b, signal()))!.digest).toBe(nextDigest);
    await Promise.all([scope.close(), fresh.close()]);
  });
  it('does not turn raw publish success into a cold source', async () => {
    const f = await fixture();
    const scope = createColdHistorySource({
      sources: f.sources,
      signal: signal(),
    });
    await expect(
      scope.resolveColdResource(f.context, f.pin, 'root', signal()),
    ).rejects.toThrow();
    await expect(
      scope.store.read(f.b, signal(), f.firstDigest),
    ).rejects.toBeDefined();
    await scope.close();
  });
  it('authorizes a stored child only through the same committed parent catalog proof', async () => {
    const f = await fixture();
    const event = {
      type: 'subagent/catalog' as const,
      seq: 0,
      time: 2,
      data: {
        version: 0 as const,
        childId: 'child',
        childCreatedAt: 2,
        mode: 'one-shot' as const,
      },
    };
    const parent = f.snapshot(1);
    parent.source.eventHashes = [hostHistoryDigest(event)];
    const childHeader = {
      id: 'child',
      version: 4 as const,
      createdAt: 2,
      isSeeded: false,
    };
    const child: HostHistorySnapshot = {
      ...f.snapshot(0),
      binding: {
        ...f.b,
        nativeSessionId: 'child',
        parentNativeSessionId: 'root',
      },
    };
    child.source.headerHash = hostHistoryDigest(childHeader);
    f.manifest.sessions[0]!.snapshotDigest = await f.raw.publish(
      parent,
      signal(),
    );
    f.manifest.sessions.push({
      binding: child.binding,
      snapshotDigest: await f.raw.publish(child, signal()),
      header: childHeader,
    });
    f.manifest.edges.push({
      parentNativeSessionId: 'root',
      childNativeSessionId: 'child',
      parentEvent: event,
    });
    const sourceDigest = await f.sources.publish(f.manifest, signal());
    const scope = createColdHistorySource({
      sources: f.sources,
      signal: signal(),
    });
    const resource = await scope.resolveColdResource(
      f.context,
      f.pin,
      'child',
      signal(),
    );
    expect(resource.parentNativeSessionId).toBe('root');
    expect(resource.bindingRef).toBe(
      hostHistoryDigest({ sourceDigest, binding: child.binding }),
    );
    expect(await scope.binding(resource, signal())).toEqual(child.binding);
    expect(
      (await scope.store.read(child.binding, signal()))!.snapshot.binding,
    ).toEqual(child.binding);
    await expect(
      scope.binding({ ...resource, parentNativeSessionId: null }, signal()),
    ).rejects.toBeDefined();
    await scope.close();
  });
  it('rejects a changed current root/birth/config binding or another request', async () => {
    const f = await fixture();
    await f.sources.publish(f.manifest, signal());
    const scope = createColdHistorySource({
      sources: f.sources,
      signal: signal(),
    });
    const resource = await scope.resolveColdResource(
      f.context,
      f.pin,
      'root',
      signal(),
    );
    for (const field of [
      'rootNativeSessionId',
      'rootOriginDigest',
      'rootBindingRef',
      'vmId',
    ] as const) {
      await expect(
        scope.resolveColdResource(
          f.context,
          { ...f.pin, [field]: 'changed' },
          'root',
          signal(),
        ),
      ).rejects.toBeInstanceOf(DataAccessError);
    }
    await expect(
      scope.resolveColdResource(
        { ...f.context, sessionId: randomUUID() },
        f.pin,
        'root',
        signal(),
      ),
    ).rejects.toBeDefined();
    await expect(
      scope.resolveColdResource(f.context, f.pin, 'missing-child', signal()),
    ).rejects.toBeDefined();
    await expect(
      scope.binding({ ...resource, bindingRef: 'current-epoch' }, signal()),
    ).rejects.toBeDefined();
    await expect(
      scope.store.read(
        { ...f.b, configurationRef: 'current-release' },
        signal(),
      ),
    ).rejects.toBeDefined();
    await scope.close();
  });
  it('uses existing request revocation and joins source read on close, without a live lease/watch', async () => {
    const f = await fixture();
    await f.sources.publish(f.manifest, signal());
    const entered = gate(),
      finish = gate(),
      controller = new AbortController();
    const read = f.sources.read.bind(f.sources);
    vi.spyOn(f.sources, 'read').mockImplementation(async (key, active) => {
      entered.release();
      await finish.promise;
      return read(key, active);
    });
    const scope = createColdHistorySource({
      sources: f.sources,
      signal: controller.signal,
    });
    const work = scope.resolveColdResource(
      f.context,
      f.pin,
      'root',
      controller.signal,
    );
    await entered.promise;
    controller.abort();
    let joined = false;
    const closing = scope.close().then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    finish.release();
    await expect(work).rejects.toBeDefined();
    await closing;
    expect(joined).toBe(true);
  });
  it('joins a cancelled raw snapshot read through the same pinned committed adapter', async () => {
    const f = await fixture(),
      entered = gate(),
      finish = gate();
    const originalRead = f.raw.read.bind(f.raw);
    let hold = false;
    const wrapped: HostHistoryStorePort = {
      publish: f.raw.publish.bind(f.raw),
      async read(...args) {
        if (hold) {
          entered.release();
          await finish.promise;
        }
        return originalRead(...args);
      },
    };
    const sources = new HostHistorySourceStore(f.root, wrapped);
    await sources.publish(f.manifest, signal());
    const controller = new AbortController(),
      scope = createColdHistorySource({ sources, signal: controller.signal });
    await scope.resolveColdResource(f.context, f.pin, 'root', signal());
    hold = true;
    const work = scope.store.read(f.b, signal());
    await entered.promise;
    const closing = scope.close();
    let done = false;
    void closing.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    finish.release();
    await expect(work).rejects.toBeDefined();
    await closing;
    expect(done).toBe(true);
  });
});
