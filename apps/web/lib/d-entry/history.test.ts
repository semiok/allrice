import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type * as FileSystem from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { DataAccessError } from '@allrice/database';
import {
  HostHistoryAttachmentSchema,
  HostHistorySnapshotSchema,
  makeObjectKey,
  type DEntryIdentity,
  type HostHistoryBinding,
  type HostHistoryPage,
  type RequestContext,
  type StorageObject,
} from '@allrice/contracts';
import {
  HostHistoryStore,
  LocalStorageAdapter,
  HostHistoryIntegrityError,
  hostHistoryDigest,
} from '@allrice/storage';
import { captureHostHistory } from '../../../worker/src/harness/host-history';
import { createDEntryHistoryHandlers } from './history';
import type { DEntryNativeResource } from './native-resource';
import { DEntryDependencyUnavailable } from './release-policy';

type SessionInspection = Awaited<
  ReturnType<Parameters<typeof captureHostHistory>[0]['native']['inspect']>
>;

const authority = vi.hoisted(() => ({
  identity: vi.fn(),
  generation: vi.fn(),
}));
const spoolIO = vi.hoisted(() => ({
  historyOrder: undefined as { directory: string; names: string[] } | undefined,
  files: [] as Array<{
    closed: boolean;
    closedPromise: Promise<void>;
    close: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FileSystem>();
  return {
    ...fs,
    async readdir(...args: Parameters<typeof fs.readdir>) {
      const names = await fs.readdir(...args);
      const order = spoolIO.historyOrder;
      if (order && String(args[0]) === order.directory)
        names.sort(
          (a, b) =>
            order.names.indexOf(String(a)) - order.names.indexOf(String(b)),
        );
      return names;
    },
    async open(...args: Parameters<typeof fs.open>) {
      const handle = await fs.open(...args);
      if (String(args[0]).includes('/spool/history-')) {
        const close = handle.close.bind(handle);
        let closed!: () => void;
        const tracked = {
          closed: false,
          closedPromise: new Promise<void>((resolve) => {
            closed = resolve;
          }),
          close: vi.fn(async () => {
            await close();
            tracked.closed = true;
            closed();
          }),
        };
        handle.close = tracked.close;
        spoolIO.files.push(tracked);
      }
      return handle;
    },
  };
});
vi.mock('./identity', () => ({ resolveDEntryIdentity: authority.identity }));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getSessionExecutionGeneration: authority.generation,
}));

const directories: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  spoolIO.files = [];
  spoolIO.historyOrder = undefined;
  authority.generation.mockResolvedValue('4.0');
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function fixture(
  bytes = new TextEncoder().encode('真实宿主附件字节 731'),
) {
  const root = resolve('.local/met274-history-tests', randomUUID());
  await mkdir(root, { recursive: true });
  directories.push(root);
  const binding: HostHistoryBinding = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    personId: randomUUID(),
    employeeInstanceId: randomUUID(),
    threadId: randomUUID(),
    nativeInstanceRef: 'host-instance-pin',
    nativeProfileRef: 'employee-profile',
    nativeSessionId: 'native-root',
    rootNativeSessionId: 'native-root',
    parentNativeSessionId: null,
    configurationRef: 'recorded-release-digest',
    configurationDigest: hostHistoryDigest({ configuration: 'synthetic' }),
    executionGeneration: '4.0',
  };
  const identity: DEntryIdentity = {
    ...binding,
    employeeRevision: 1,
    employeeVersionId: randomUUID(),
  };
  const context: RequestContext = {
    requestId: randomUUID(),
    sessionId: randomUUID(),
    actor: { type: 'user', id: binding.personId },
    organizationId: binding.organizationId,
    workspaceId: binding.workspaceId,
    memberships: [],
    authenticatedAt: new Date().toISOString(),
  };
  authority.identity.mockResolvedValue(identity);
  const revoked = new AbortController();
  const resource: DEntryNativeResource = {
    organizationId: binding.organizationId,
    personId: binding.personId,
    employeeInstanceId: binding.employeeInstanceId,
    threadId: binding.threadId,
    nativeSessionId: binding.nativeSessionId,
    rootNativeSessionId: binding.rootNativeSessionId,
    parentNativeSessionId: null,
    bindingRef: 'current-host-epoch',
    revoked: revoked.signal,
  };
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'system/message',
      data: { message: { content: 'PRIVATE_SYSTEM_CONTEXT' } },
      surfaceOp: 'append',
    },
    {
      type: 'user/message',
      data: {
        role: 'user',
        source: { kind: 'runtime-context' },
        content: 'PRIVATE_RUNTIME_CONTEXT',
      },
      surfaceOp: 'append',
    },
    {
      type: 'user/message',
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: '关机以后我还要看上次的聊天和文件。',
      },
      surfaceOp: 'append',
    },
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        stream: [],
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '这是上次已显示的内容。' },
            { type: 'reasoning', text: 'PRIVATE_REASONING' },
            {
              type: 'tool-call',
              id: 'effect-call',
              name: 'business_publish',
              arguments: '{"value":1}',
            },
          ],
        },
      },
      surfaceOp: 'append',
    },
    {
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: 'effect-call',
        name: 'business_publish',
        arguments: '{"value":1}',
      },
    },
    {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'effect-call',
          isError: true,
          content: [{ type: 'text', text: '原生结果未知。' }],
        },
        error: {
          code: 'TOOL_OUTCOME_UNKNOWN',
          name: 'ToolOutcomeUnknownError',
        },
      },
      surfaceOp: 'append',
    },
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 2,
        stream: [],
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              id: 'never-started',
              name: 'other_action',
              arguments: '{"value":2}',
            },
          ],
        },
      },
      surfaceOp: 'append',
    },
    {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 2,
        message: {
          role: 'tool',
          toolCallId: 'never-started',
          isError: true,
          content: [{ type: 'text', text: '原生记录未开始。' }],
        },
        error: { code: 'TOOL_NOT_STARTED', name: 'ToolNotStartedError' },
      },
      surfaceOp: 'append',
    },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } },
  ].map((event, seq) => ({ ...event, seq, time: 1000 + seq }));
  const nativeData = {
    meta: {
      id: 'native-root',
      version: 4,
      createdAt: 1000,
      isSeeded: false,
      cwd: '/work/private-native-cwd',
    },
    inheritedEventCount: 0,
    events,
  } as unknown as SessionInspection;
  const execution = { vmStarts: 0, modelRequests: 0, replays: 0 };
  const native = {
    binding: structuredClone(binding),
    inspect: vi.fn<
      Parameters<typeof captureHostHistory>[0]['native']['inspect']
    >(async (_id, signal) => {
      signal?.throwIfAborted();
      return nativeData;
    }),
    resolveAgent: vi.fn(() => {
      execution.vmStarts++;
      execution.replays++;
      throw new Error('Forbidden');
    }),
    prompt: vi.fn(() => {
      execution.modelRequests++;
      throw new Error('Forbidden');
    }),
  };
  const object: StorageObject = {
    id: randomUUID(),
    organizationId: binding.organizationId,
    workspaceId: binding.workspaceId,
    ownerId: binding.personId,
    key: `organizations/${binding.organizationId}/workspaces/${binding.workspaceId}/owners/${binding.personId}/exports/${randomUUID()}`,
    checksum: hostHistoryDigest('placeholder'),
    sizeBytes: bytes.byteLength,
    mediaType: 'text/plain',
    retentionUntil: null,
    deletedAt: null,
    immutable: true,
  };
  const { createHash } = await import('node:crypto');
  object.checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  object.key = makeObjectKey({
    organizationId: object.organizationId,
    workspaceId: object.workspaceId,
    ownerId: object.ownerId,
    category: 'exports',
    objectId: object.id,
  });
  const objectStorage = new LocalStorageAdapter(join(root, 'objects'));
  await objectStorage.put(object, new Blob([bytes]).stream());
  const attachment = {
    sourceSeq: 6,
    objectId: object.id,
    checksum: object.checksum,
    sizeBytes: object.sizeBytes,
    mediaType: object.mediaType,
    fileName: 'receipt.txt',
  };
  const attachments = vi.fn<
    Parameters<typeof captureHostHistory>[0]['attachments']
  >(async () => [attachment]);
  const store = new HostHistoryStore(root);
  const capture = () =>
    captureHostHistory({
      binding,
      native,
      authorize: async () => ({ binding, revoked: revoked.signal }),
      store,
      signal: new AbortController().signal,
      attachments,
    });
  const resources = { resolve: vi.fn(async () => resource) };
  const bindingPort = vi.fn(async () => binding);
  const objectRevoked = new AbortController();
  const owner = {
    object,
    revoked: objectRevoked.signal,
    reauthorize: vi.fn(async (signal: AbortSignal) => {
      signal.throwIfAborted();
      return object;
    }),
    open: vi.fn(async (signal: AbortSignal) => {
      signal.throwIfAborted();
      return objectStorage.get(object);
    }),
    close: vi.fn(async (): Promise<void> => undefined),
  };
  const files = {
    spoolDirectory: join(root, 'spool'),
    acquire: vi.fn(
      async (
        _context: RequestContext,
        _objectId: string,
        signal: AbortSignal,
      ) => {
        signal.throwIfAborted();
        return owner;
      },
    ),
  };
  const handlers = createDEntryHistoryHandlers({
    resources,
    binding: bindingPort,
    store: new HostHistoryStore(root),
    context: async () => context,
    files,
  });
  const request = (
    params: Record<string, string | number> = {},
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({
      workspaceId: binding.workspaceId,
      employeeInstanceId: binding.employeeInstanceId,
      threadId: binding.threadId,
      nativeSessionId: binding.nativeSessionId,
    });
    for (const [key, value] of Object.entries(params))
      query.set(key, String(value));
    return new Request(`https://allrice.example/api/history?${query}`, {
      signal,
    });
  };
  return {
    root,
    binding,
    identity,
    resource,
    context,
    nativeData,
    native,
    capture,
    execution,
    store,
    attachment,
    attachments,
    bytes,
    object,
    resources,
    bindingPort,
    files,
    owner,
    objectRevoked,
    handlers,
    request,
    revoked,
  };
}

describe('host-only native recovery history BFF', () => {
  it('“关机仍看聊天/展开工具/下载附件” reads persisted history with VM/gateway off and no execution', async () => {
    const f = await fixture();
    const saved = await f.capture();
    f.native.inspect.mockRejectedValue(new Error('VM and gateway are off'));
    const response = await f.handlers.history(f.request({ limit: 100 }));
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.notice).toBe('interrupted');
    expect(page.externalEffects).toBe('unverified');
    expect(
      page.entries.filter((entry: { kind: string }) => entry.kind === 'tool'),
    ).toMatchObject([
      {
        name: 'business_publish',
        arguments: '{"value":1}',
        outcome: 'outcome-unknown',
        result: { text: '原生结果未知。' },
      },
      {
        name: 'other_action',
        outcome: 'not-started',
        result: { text: '原生记录未开始。' },
      },
    ]);
    expect(JSON.stringify(page)).not.toMatch(
      /PRIVATE_|private-native-cwd|eventHashes|storage.key/,
    );
    const downloaded = await f.handlers.download(
      f.request({ snapshotDigest: saved.digest, objectId: f.object.id }),
    );
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('content-type')).toBe(
      'application/octet-stream',
    );
    expect(downloaded.headers.get('content-disposition')).toContain(
      'attachment;',
    );
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(f.bytes);
    expect(f.owner.close).toHaveBeenCalledTimes(1);
    expect(spoolIO.files).toHaveLength(1);
    expect(spoolIO.files[0]!.closed).toBe(true);
    expect(await readdir(f.files.spoolDirectory)).toEqual([]);
    expect(f.native.inspect).toHaveBeenCalledTimes(1);
    expect(f.execution).toEqual({ vmStarts: 0, modelRequests: 0, replays: 0 });
  });

  it('distinguishes an unfinished prefix from interrupted and refuses a missing source sequence', async () => {
    const f = await fixture();
    const prefix = { ...f.nativeData, events: f.nativeData.events.slice(0, 6) };
    f.native.inspect.mockResolvedValue(prefix);
    f.attachments.mockResolvedValue([]);
    const saved = await f.capture();
    expect(
      saved.snapshot.entries.find((entry) => entry.kind === 'tool'),
    ).toMatchObject({ outcome: 'unfinished', result: null });
    expect(
      (await (await f.handlers.history(f.request({ limit: 100 }))).json())
        .notice,
    ).toBe('unfinished');
    f.native.inspect.mockResolvedValue({
      ...prefix,
      events: [prefix.events[0]!, prefix.events[2]!],
    });
    await expect(f.capture()).rejects.toBeInstanceOf(HostHistoryIntegrityError);
    expect(
      (await f.store.read(f.binding, new AbortController().signal))?.digest,
    ).toBe(saved.digest);
  });

  it('retains native append-origin history, omits replacement/system/reasoning and hides technical secrets/paths', async () => {
    const f = await fixture();
    const source = structuredClone(f.nativeData);
    const extra = [
      {
        type: 'assistant/message',
        surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 },
        data: {
          turn: 1,
          step: 3,
          message: {
            content: [{ type: 'text', text: 'MODEL_ONLY_REPLACEMENT' }],
          },
        },
      },
      {
        type: 'tool/call',
        data: {
          turn: 2,
          step: 1,
          callId: 'secret-slot',
          name: 'read',
          arguments:
            '{"path":"/work/hidden","headers":{"authorization":"Bearer SYNTHETIC_ONLY"}}',
        },
      },
    ].map((event, i) => ({
      ...event,
      seq: source.events.length + i,
      time: 2000 + i,
    }));
    f.native.inspect.mockResolvedValue({
      ...source,
      events: [...source.events, ...extra],
    } as unknown as SessionInspection);
    const saved = await f.capture();
    const serialized = JSON.stringify(saved.snapshot);
    expect(serialized).toContain('这是上次已显示的内容。');
    expect(serialized).toContain('已隐藏');
    expect(serialized).not.toMatch(
      /PRIVATE_|MODEL_ONLY_REPLACEMENT|SYNTHETIC_ONLY|\/work\//,
    );
    expect(saved.snapshot.source.eventHashes).toHaveLength(
      source.events.length + 2,
    );
  });

  it('does not promote a native success into confirmed external delivery', async () => {
    const f = await fixture();
    const source = structuredClone(f.nativeData) as unknown as {
      events: Array<{
        data: { message?: { isError?: boolean }; error?: unknown };
      }>;
    };
    source.events[6]!.data.message!.isError = false;
    delete source.events[6]!.data.error;
    f.native.inspect.mockResolvedValue(source as unknown as SessionInspection);
    await f.capture();
    const page = await (
      await f.handlers.history(f.request({ limit: 100 }))
    ).json();
    expect(
      page.entries.find(
        (entry: { name?: string }) => entry.name === 'business_publish',
      ).outcome,
    ).toBe('result-recorded');
    expect(page.externalEffects).toBe('unverified');
  });

  it('deduplicates repeated/concurrent exports and reloads from a new store instance', async () => {
    const f = await fixture();
    const publications = await Promise.all([
      f.capture(),
      f.capture(),
      f.capture(),
    ]);
    expect(new Set(publications.map((item) => item.digest)).size).toBe(1);
    const directories = (await readdir(f.root)).filter((name) =>
      /^[a-f0-9]{64}$/.test(name),
    );
    expect(directories).toHaveLength(1);
    expect(await readdir(join(f.root, directories[0]!))).toEqual([
      `${publications[0]!.digest.slice(7)}.json`,
    ]);
    expect(
      (
        await new HostHistoryStore(f.root).read(
          f.binding,
          new AbortController().signal,
        )
      )?.digest,
    ).toBe(publications[0]!.digest);
  });

  it('pins pagination to the original snapshot after later captures and rejects fabricated cursors', async () => {
    const f = await fixture();
    await f.capture();
    const first = await (
      await f.handlers.history(f.request({ limit: 1 }))
    ).json();
    const next = first.nextCursor;
    f.native.inspect.mockResolvedValue({
      ...f.nativeData,
      events: [
        ...f.nativeData.events,
        {
          seq: f.nativeData.events.length,
          time: 9999,
          type: 'turn/start',
          data: { turn: 2 },
        },
      ],
    } as unknown as SessionInspection);
    const newer = await f.capture();
    const oldPage = await (
      await f.handlers.history(f.request({ limit: 100, ...next }))
    ).json();
    expect(oldPage.snapshotDigest).toBe(first.snapshotDigest);
    expect(oldPage.notice).toBe('interrupted');
    expect(
      (await (await f.handlers.history(f.request({ limit: 100 }))).json())
        .snapshotDigest,
    ).toBe(newer.digest);
    expect(
      (
        await f.handlers.history(
          f.request({ limit: 1, afterSeq: 999, snapshotDigest: newer.digest }),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await f.handlers.history(
          f.request({ limit: 1, snapshotDigest: `sha256:${'a'.repeat(64)}` }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await f.handlers.history(f.request({ limit: 1, afterSeq: 0 }))).status,
    ).toBe(400);
  });

  it('rejects rollback, divergent native prefixes, unsupported versions and corrupt snapshot bytes', async () => {
    const f = await fixture();
    const saved = await f.capture();
    expect(
      HostHistorySnapshotSchema.safeParse({
        ...saved.snapshot,
        schemaVersion: 2,
      }).success,
    ).toBe(false);
    f.native.inspect.mockResolvedValue({
      ...f.nativeData,
      events: f.nativeData.events.slice(0, 6),
    });
    f.attachments.mockResolvedValue([]);
    await expect(f.capture()).rejects.toBeInstanceOf(HostHistoryIntegrityError);
    const changed = structuredClone(f.nativeData) as unknown as {
      events: Array<{ data: { turn?: number } }>;
    };
    changed.events[0]!.data.turn = 42;
    f.native.inspect.mockResolvedValue(changed as unknown as SessionInspection);
    await expect(f.capture()).rejects.toBeInstanceOf(HostHistoryIntegrityError);
    const directory = (await readdir(f.root)).find((name) =>
      /^[a-f0-9]{64}$/.test(name),
    )!;
    const file = join(f.root, directory, `${saved.digest.slice(7)}.json`);
    const corrupted = JSON.parse(await readFile(file, 'utf8'));
    corrupted.entries[0].text = 'tampered';
    await writeFile(file, JSON.stringify(corrupted));
    expect((await f.handlers.history(f.request({ limit: 100 }))).status).toBe(
      409,
    );
    expect(
      await f.store.read(
        { ...f.binding, personId: randomUUID() },
        new AbortController().signal,
      ),
    ).toBeNull();
  });

  it('rechecks owner/root/config/lease and never leaks history or file bytes after denial', async () => {
    const f = await fixture();
    const saved = await f.capture();
    authority.identity.mockRejectedValueOnce(
      new DataAccessError('authorization_denied'),
    );
    expect((await f.handlers.history(f.request({ limit: 100 }))).status).toBe(
      403,
    );
    f.resources.resolve.mockResolvedValueOnce({
      ...f.resource,
      personId: randomUUID(),
    });
    expect((await f.handlers.history(f.request({ limit: 100 }))).status).toBe(
      403,
    );
    f.bindingPort.mockResolvedValueOnce({
      ...f.binding,
      rootNativeSessionId: 'other-root',
      parentNativeSessionId: 'other-root',
    });
    expect((await f.handlers.history(f.request({ limit: 100 }))).status).toBe(
      403,
    );
    f.owner.reauthorize.mockResolvedValueOnce({
      ...f.object,
      checksum: `sha256:${'0'.repeat(64)}`,
    });
    expect(
      (
        await f.handlers.download(
          f.request({ snapshotDigest: saved.digest, objectId: f.object.id }),
        )
      ).status,
    ).toBe(404);
    expect(f.owner.open).not.toHaveBeenCalled();
    f.revoked.abort();
    expect(
      (await f.handlers.history(f.request({ limit: 100 }))).status,
    ).not.toBe(200);
    expect(f.execution.vmStarts).toBe(0);
  });

  it('allows a verified child history through the root while exposing no write handler', async () => {
    const f = await fixture();
    Object.assign(f.binding, {
      nativeSessionId: 'native-child',
      parentNativeSessionId: 'native-root',
    });
    Object.assign(f.native.binding, {
      nativeSessionId: 'native-child',
      parentNativeSessionId: 'native-root',
    });
    Object.assign(f.resource, {
      nativeSessionId: 'native-child',
      parentNativeSessionId: 'native-root',
    });
    f.native.inspect.mockResolvedValue({
      ...f.nativeData,
      meta: { ...f.nativeData.meta, id: 'native-child' },
    } as SessionInspection);
    await f.capture();
    expect((await f.handlers.history(f.request({ limit: 100 }))).status).toBe(
      200,
    );
    expect(Object.keys(f.handlers).sort()).toEqual(['download', 'history']);
    expect(f.native.resolveAgent).not.toHaveBeenCalled();
  });

  it('keeps history readable but refuses downloads without a real attachment owner binding', async () => {
    const f = await fixture();
    const saved = await f.capture();
    const handlers = createDEntryHistoryHandlers({
      resources: f.resources,
      binding: f.bindingPort,
      store: f.store,
      context: async () => f.context,
    });
    expect((await handlers.history(f.request({ limit: 100 }))).status).toBe(
      200,
    );
    const response = await handlers.download(
      f.request({ snapshotDigest: saved.digest, objectId: f.object.id }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'DEPENDENCY_UNAVAILABLE' },
    });
    expect(f.files.acquire).not.toHaveBeenCalled();
    expect(spoolIO.files).toEqual([]);
  });

  it('rejects a schema-valid unencodable filename before acquiring an owner or spool', async () => {
    const f = await fixture();
    f.attachment.fileName = '\ud800';
    expect(HostHistoryAttachmentSchema.parse(f.attachment).fileName).toBe(
      '\ud800',
    );
    const saved = await f.capture();
    const response = await f.handlers.download(
      f.request({ snapshotDigest: saved.digest, objectId: f.object.id }),
    );
    expect(response.status).toBe(500);
    expect(f.files.acquire).not.toHaveBeenCalled();
    expect(f.owner.open).not.toHaveBeenCalled();
    expect(f.owner.close).not.toHaveBeenCalled();
    expect(spoolIO.files).toEqual([]);
    await expect(readdir(f.files.spoolDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('cancels a prepared body and joins owner/spool release if Response construction fails', async () => {
    const f = await fixture();
    const saved = await f.capture();
    let closing!: () => void;
    const closeStarted = new Promise<void>((resolve) => {
      closing = resolve;
    });
    let release!: () => void;
    const closeFinished = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.owner.close.mockImplementation(async () => {
      closing();
      await closeFinished;
    });
    const NativeResponse = Response;
    let constructionFailed = false;
    vi.stubGlobal(
      'Response',
      class extends NativeResponse {
        constructor(body?: BodyInit | null, init?: ResponseInit) {
          if (body instanceof ReadableStream) {
            constructionFailed = true;
            throw new Error('Injected Response construction failure');
          }
          super(body, init);
        }
      },
    );
    let settled = false;
    const pending = f.handlers.download(
      f.request({ snapshotDigest: saved.digest, objectId: f.object.id }),
    );
    void pending.then(() => {
      settled = true;
    });
    await closeStarted;
    expect(constructionFailed).toBe(true);
    expect(f.files.acquire).toHaveBeenCalledTimes(1);
    expect(spoolIO.files).toHaveLength(1);
    await spoolIO.files[0]!.closedPromise;
    expect(settled).toBe(false);
    release();
    const response = await pending;
    expect(response.status).toBe(500);
    expect(f.owner.close).toHaveBeenCalledTimes(1);
    expect(spoolIO.files[0]!.closed).toBe(true);
    expect(await readdir(f.files.spoolDirectory)).toEqual([]);
  });

  it.each(['root-revoke', 'object-revoke', 'request-cancel'])(
    'cancels an actual stalled source on %s and awaits its cleanup without a VM',
    async (mode) => {
      const f = await fixture();
      const saved = await f.capture();
      let opened!: () => void;
      const started = new Promise<void>((resolve) => {
        opened = resolve;
      });
      let cancelled = false;
      let finishCancel!: () => void;
      let cancelling!: () => void;
      const cancelStarted = new Promise<void>((resolve) => {
        cancelling = resolve;
      });
      const cancelFinished = new Promise<void>((resolve) => {
        finishCancel = resolve;
      });
      f.owner.open.mockImplementation(
        async () =>
          new ReadableStream<Uint8Array>(
            {
              start(controller) {
                controller.enqueue(f.bytes.slice(0, 4));
              },
              pull() {
                opened();
              },
              async cancel() {
                cancelled = true;
                cancelling();
                await cancelFinished;
              },
            },
            { highWaterMark: 0 },
          ),
      );
      const requestAbort = new AbortController();
      let settled = false;
      const pending = f.handlers.download(
        f.request(
          { snapshotDigest: saved.digest, objectId: f.object.id },
          requestAbort.signal,
        ),
      );
      void pending.then(() => {
        settled = true;
      });
      await started;
      const reason = new DataAccessError('authorization_denied');
      if (mode === 'root-revoke') f.revoked.abort(reason);
      else if (mode === 'object-revoke') f.objectRevoked.abort(reason);
      else requestAbort.abort(reason);
      await cancelStarted;
      expect(cancelled).toBe(true);
      expect(settled).toBe(false);
      expect(f.revoked.signal.aborted).toBe(mode === 'root-revoke');
      finishCancel();
      expect((await pending).status).toBe(403);
      expect(f.owner.close).toHaveBeenCalledTimes(1);
      expect(spoolIO.files.every((file) => file.closed)).toBe(true);
      expect(await readdir(f.files.spoolDirectory)).toEqual([]);
      expect(f.execution).toEqual({
        vmStarts: 0,
        modelRequests: 0,
        replays: 0,
      });
    },
  );

  it.each(['same-length', 'short'])(
    'rejects %s wrong single-chunk bytes before the first successful body read',
    async (mode) => {
      const f = await fixture();
      const saved = await f.capture();
      const wrong =
        mode === 'short'
          ? new Uint8Array([1, 2, 3])
          : f.bytes.map((byte) => byte ^ 1);
      f.owner.open.mockImplementation(
        async () =>
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(wrong);
              c.close();
            },
          }),
      );
      const wrongBytes = await f.handlers.download(
        f.request({ snapshotDigest: saved.digest, objectId: f.object.id }),
      );
      expect(wrongBytes.status).toBe(409);
      expect(wrongBytes.headers.get('content-type')).not.toBe(
        'application/octet-stream',
      );
      expect(wrongBytes.headers.get('content-length')).toBeNull();
      const first = await wrongBytes.body!.getReader().read();
      expect(first.value).not.toEqual(wrong);
      expect(f.owner.close).toHaveBeenCalledTimes(1);
      expect(spoolIO.files.every((file) => file.closed)).toBe(true);
      expect(await readdir(f.files.spoolDirectory)).toEqual([]);
      f.owner.reauthorize.mockRejectedValueOnce(
        new DataAccessError('authorization_denied'),
      );
      expect(
        (
          await f.handlers.download(
            f.request({ snapshotDigest: saved.digest, objectId: f.object.id }),
          )
        ).status,
      ).toBe(403);
      expect(f.execution.replays).toBe(0);
    },
  );
  it('retains current object authorization checks between source chunks', async () => {
    const f = await fixture();
    const saved = await f.capture();
    let permitted = true;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    f.owner.reauthorize.mockImplementation(async () => {
      if (!permitted) throw new DataAccessError('authorization_denied');
      return f.object;
    });
    let nextRead!: () => void;
    const pendingRead = new Promise<void>((resolve) => {
      nextRead = resolve;
    });
    f.owner.open.mockImplementation(
      async () =>
        new ReadableStream<Uint8Array>(
          {
            start(c) {
              controller = c;
              c.enqueue(f.bytes.slice(0, 4));
            },
            pull() {
              nextRead();
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
    );
    const response = f.handlers.download(
      f.request({ snapshotDigest: saved.digest, objectId: f.object.id }),
    );
    await pendingRead;
    permitted = false;
    controller.enqueue(f.bytes.slice(4));
    expect((await response).status).toBe(403);
    expect(cancelled).toBe(true);
    expect(spoolIO.files.every((file) => file.closed)).toBe(true);
    expect(f.owner.close).toHaveBeenCalledTimes(1);
    expect(f.execution.modelRequests).toBe(0);
  });

  it.each(['reject', 'late-stream'])(
    'awaits object-revoked pending open (%s) and releases late resources',
    async (mode) => {
      const f = await fixture();
      const saved = await f.capture();
      let opened!: () => void;
      const opening = new Promise<void>((resolve) => {
        opened = resolve;
      });
      let cancelled!: () => void;
      const cancelling = new Promise<void>((resolve) => {
        cancelled = resolve;
      });
      let settle!: () => void;
      const released = new Promise<void>((resolve) => {
        settle = resolve;
      });
      let sourceCancelled = false;
      f.owner.open.mockImplementation(async (signal) => {
        signal.addEventListener('abort', cancelled, { once: true });
        opened();
        try {
          await released;
          if (mode === 'reject') signal.throwIfAborted();
          return new ReadableStream<Uint8Array>({
            cancel() {
              sourceCancelled = true;
            },
          });
        } finally {
          signal.removeEventListener('abort', cancelled);
        }
      });
      let done = false;
      const pending = f.handlers.download(
        f.request({ snapshotDigest: saved.digest, objectId: f.object.id }),
      );
      void pending.then(() => {
        done = true;
      });
      await opening;
      f.objectRevoked.abort(new DataAccessError('authorization_denied'));
      await cancelling;
      expect(done).toBe(false);
      expect(f.owner.close).not.toHaveBeenCalled();
      settle();
      expect((await pending).status).toBe(403);
      expect(sourceCancelled).toBe(mode === 'late-stream');
      expect(f.revoked.signal.aborted).toBe(false);
      expect(f.owner.close).toHaveBeenCalledTimes(1);
      expect(spoolIO.files).toHaveLength(1);
      expect(spoolIO.files[0]!.closed).toBe(true);
      expect(await readdir(f.files.spoolDirectory)).toEqual([]);
    },
  );

  it('releases a verified spool on object revocation before any body read', async () => {
    const f = await fixture();
    const saved = await f.capture();
    const response = await f.handlers.download(
      f.request({ snapshotDigest: saved.digest, objectId: f.object.id }),
    );
    expect(response.status).toBe(200);
    expect(spoolIO.files[0]!.closed).toBe(false);
    f.objectRevoked.abort(new DataAccessError('authorization_denied'));
    // No next source chunk or consumer pull is needed to release the spool.
    await spoolIO.files[0]!.closedPromise;
    await expect(response.body!.getReader().read()).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    expect(f.revoked.signal.aborted).toBe(false);
    expect(f.owner.close).toHaveBeenCalledTimes(1);
    expect(await readdir(f.files.spoolDirectory)).toEqual([]);
  });

  it('keeps verified bytes pinned when the original source buffer changes', async () => {
    const f = await fixture();
    const saved = await f.capture();
    const source = f.bytes.slice();
    f.owner.open.mockImplementation(
      async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(source);
            controller.close();
          },
        }),
    );
    const response = await f.handlers.download(
      f.request({ snapshotDigest: saved.digest, objectId: f.object.id }),
    );
    source.fill(0);
    const reader = response.body!.getReader();
    expect(new Uint8Array((await reader.read()).value!)).toEqual(f.bytes);
    await spoolIO.files[0]!.closedPromise;
    expect(spoolIO.files[0]!.closed).toBe(true);
    expect(f.owner.close).toHaveBeenCalledTimes(1);
    expect((await reader.read()).done).toBe(true);
  });

  it('rechecks object authority between verified output blocks', async () => {
    const f = await fixture(new Uint8Array(65540).fill(7));
    const saved = await f.capture();
    const response = await f.handlers.download(
      f.request({ snapshotDigest: saved.digest, objectId: f.object.id }),
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(new Uint8Array((await reader.read()).value!)).toEqual(
      f.bytes.slice(0, 65536),
    );
    f.owner.reauthorize.mockRejectedValueOnce(
      new DataAccessError('authorization_denied'),
    );
    await expect(reader.read()).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    expect(f.revoked.signal.aborted).toBe(false);
    expect(spoolIO.files[0]!.closed).toBe(true);
    expect(f.owner.close).toHaveBeenCalledTimes(1);
  });

  it.each(['before-pull', 'pending-pull'])(
    'awaits consumer cancellation and owner release (%s)',
    async (mode) => {
      const f = await fixture();
      const saved = await f.capture();
      const response = await f.handlers.download(
        f.request({ snapshotDigest: saved.digest, objectId: f.object.id }),
      );
      expect(response.status).toBe(200);
      let closing!: () => void;
      const closeStarted = new Promise<void>((resolve) => {
        closing = resolve;
      });
      let release!: () => void;
      const closeFinished = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.owner.close.mockImplementation(async () => {
        closing();
        await closeFinished;
      });
      const reader = response.body!.getReader();
      let pendingRead:
        Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
      if (mode === 'pending-pull') {
        let checking!: () => void;
        const checkStarted = new Promise<void>((resolve) => {
          checking = resolve;
        });
        f.owner.reauthorize.mockImplementationOnce(async (signal) => {
          checking();
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          signal.throwIfAborted();
          return f.object;
        });
        pendingRead = reader.read();
        await checkStarted;
      }
      let cancelled = false;
      const cancellation = reader.cancel().then(() => {
        cancelled = true;
      });
      await closeStarted;
      expect(cancelled).toBe(false);
      release();
      await cancellation;
      if (pendingRead) expect((await pendingRead).done).toBe(true);
      expect(f.owner.close).toHaveBeenCalledTimes(1);
      expect(spoolIO.files[0]!.closed).toBe(true);
      expect(await readdir(f.files.spoolDirectory)).toEqual([]);
    },
  );

  it('refuses concurrent conflicting projections instead of overwriting an original', async () => {
    const f = await fixture();
    const saved = await f.capture();
    const other = new HostHistoryStore(join(f.root, 'racing'));
    const branch = structuredClone(saved.snapshot);
    branch.entries[0] = {
      ...branch.entries[0]!,
      text: 'conflicting projection',
    } as (typeof branch.entries)[number];
    const results = await Promise.allSettled([
      other.publish(saved.snapshot, new AbortController().signal),
      other.publish(branch, new AbortController().signal),
    ]);
    expect(results.some((result) => result.status === 'rejected')).toBe(true);
    const stored = await other
      .read(f.binding, new AbortController().signal)
      .catch((error) => error);
    expect(
      stored === null ||
        stored instanceof HostHistoryIntegrityError ||
        stored.digest === saved.digest ||
        stored.digest === hostHistoryDigest(branch),
    ).toBe(true);
    expect(
      (await f.store.read(f.binding, new AbortController().signal))?.digest,
    ).toBe(saved.digest);
  });
  it('refuses a mismatched native source and rechecks export authority before storage publication', async () => {
    const f = await fixture();
    f.native.binding.personId = randomUUID();
    await expect(f.capture()).rejects.toBeInstanceOf(HostHistoryIntegrityError);
    expect(f.native.inspect).not.toHaveBeenCalled();
    f.native.binding = structuredClone(f.binding);
    let admissions = 0;
    await expect(
      captureHostHistory({
        binding: f.binding,
        native: f.native,
        store: f.store,
        signal: new AbortController().signal,
        attachments: f.attachments,
        authorize: async () => {
          if (++admissions === 2) f.revoked.abort();
          return { binding: f.binding, revoked: f.revoked.signal };
        },
      }),
    ).rejects.toThrow();
    expect(
      await f.store.read(f.binding, new AbortController().signal),
    ).toBeNull();
  });
});

/** Contract fixtures only: 271 root/config, 273 inspect/checkpoint and object
 * ACL owners are not production-bound. No execute/receipt signature exists in
 * v1; the explicit execution below stays local to its test. */
describe('v1 recovery contracts with unbound-owner test substitutes', () => {
  it('fixes the inspected source cut before waiting for immutable attachment export', async () => {
    const f = await fixture();
    const original = structuredClone(f.nativeData);
    const entered = gate();
    const drained = gate();
    f.attachments.mockImplementationOnce(async () => {
      entered.release();
      await drained.promise;
      return [f.attachment];
    });
    const pending = f.capture();
    await entered.promise;
    // An advancing attached source must not relabel the already-projected
    // entries with a later header, prefix or event hash.
    const advancing = f.nativeData as unknown as {
      meta: { createdAt: number };
      inheritedEventCount: number;
      events: SessionInspection['events'][number][];
    };
    advancing.meta.createdAt++;
    advancing.inheritedEventCount = 1;
    advancing.events[6] = {
      ...advancing.events[6]!,
      time: 9000,
    };
    advancing.events.push({
      seq: advancing.events.length,
      time: 9001,
      type: 'turn/start',
      data: { turn: 2 },
    } as SessionInspection['events'][number]);
    drained.release();
    const saved = await pending;
    expect(saved.snapshot.source).toMatchObject({
      headerHash: hostHistoryDigest(original.meta),
      inheritedEventCount: original.inheritedEventCount,
      throughSeq: original.events.length - 1,
      eventHashes: original.events.map(hostHistoryDigest),
    });
    expect(saved.snapshot.lastTurn.reason).toBe('interrupted');
    expect(
      (
        await new HostHistoryStore(f.root).read(
          f.binding,
          new AbortController().signal,
        )
      )?.snapshot,
    ).toEqual(saved.snapshot);
  });

  it.each(['tool-result', 'attachment'] as const)(
    'refuses restored same-cursor %s conflicts even when the longest prefix is read first',
    async (conflict) => {
      const f = await fixture();
      const original = await f.capture();
      f.native.inspect.mockResolvedValue({
        ...f.nativeData,
        events: [
          ...f.nativeData.events,
          {
            seq: f.nativeData.events.length,
            time: 9000,
            type: 'turn/start',
            data: { turn: 2 },
          },
        ],
      } as SessionInspection);
      const latest = await f.capture();
      const branch = structuredClone(original.snapshot);
      if (conflict === 'attachment')
        branch.attachments[0]!.checksum = `sha256:${'0'.repeat(64)}`;
      else {
        const tool = branch.entries.find((entry) => entry.kind === 'tool')!;
        if (tool.kind !== 'tool' || !tool.result)
          throw new Error('Fixture lacks the original recorded tool result');
        tool.result.text = 'conflicting restored tool result';
      }
      const branchDigest = hostHistoryDigest(branch);
      const directory = join(f.root, hostHistoryDigest(f.binding).slice(7));
      const name = (digest: string) => `${digest.slice(7)}.json`;
      // Restore a set of individually valid immutable files, as can also
      // result from racing publishers. No file replaces an original.
      await writeFile(
        join(directory, name(branchDigest)),
        JSON.stringify(branch),
        { flag: 'wx', mode: 0o600 },
      );
      spoolIO.historyOrder = {
        directory,
        names: [name(latest.digest), name(original.digest), name(branchDigest)],
      };
      const reopened = new HostHistoryStore(f.root);
      for (const digest of [undefined, original.digest, latest.digest])
        await expect(
          reopened.read(f.binding, new AbortController().signal, digest),
        ).rejects.toBeInstanceOf(HostHistoryIntegrityError);
      expect((await f.handlers.history(f.request({ limit: 100 }))).status).toBe(
        409,
      );
      expect(
        await readFile(join(directory, name(original.digest)), 'utf8'),
      ).toBe(JSON.stringify(original.snapshot));
    },
  );

  it('reopens paginated unfinished tool data without upgrading an old cursor to a later result or attachment', async () => {
    const f = await fixture();
    f.native.inspect.mockResolvedValue({
      ...f.nativeData,
      events: f.nativeData.events.slice(0, 6),
    });
    f.attachments.mockResolvedValue([]);
    const prefix = await f.capture();
    const first: HostHistoryPage = await (
      await f.handlers.history(f.request({ limit: 1 }))
    ).json();
    expect(first.nextCursor).not.toBeNull();
    f.native.inspect.mockResolvedValue(f.nativeData);
    f.attachments.mockResolvedValue([f.attachment]);
    const later = await f.capture();
    f.native.inspect.mockRejectedValue(new Error('VM/model/auth offline'));
    // Reconstruct both the store and BFF: no prior in-memory history survives.
    const reopened = createDEntryHistoryHandlers({
      resources: f.resources,
      binding: f.bindingPort,
      store: new HostHistoryStore(f.root),
      context: async () => f.context,
      files: f.files,
    });
    const old: HostHistoryPage = await (
      await reopened.history(f.request({ limit: 100, ...first.nextCursor! }))
    ).json();
    expect(old.snapshotDigest).toBe(prefix.digest);
    expect(old.notice).toBe('unfinished');
    expect(old.entries.find((entry) => entry.kind === 'tool')).toMatchObject({
      callId: 'effect-call',
      arguments: '{"value":1}',
      outcome: 'unfinished',
      result: null,
    });
    expect(old.attachments).toEqual([]);
    expect(old.nextCursor).toBeNull();
    const current: HostHistoryPage = await (
      await reopened.history(f.request({ limit: 100 }))
    ).json();
    expect(current.snapshotDigest).toBe(later.digest);
    expect(
      current.entries.find((entry) => entry.kind === 'tool'),
    ).toMatchObject({
      outcome: 'outcome-unknown',
      result: { seq: 6, text: '原生结果未知。' },
    });
    expect(current.attachments).toEqual([f.attachment]);
    expect(f.native.inspect).toHaveBeenCalledTimes(2);
    expect(f.execution).toEqual({ vmStarts: 0, modelRequests: 0, replays: 0 });
  });

  it.each([
    {
      fault: 'crash-prefix',
      length: 6,
      notice: 'unfinished',
      outcome: 'unfinished',
    },
    {
      fault: 'stream-loss',
      length: 7,
      notice: 'unfinished',
      outcome: 'outcome-unknown',
    },
    {
      fault: 'native-interrupted',
      length: 10,
      notice: 'interrupted',
      outcome: 'outcome-unknown',
    },
  ] as const)(
    'rereads a $fault record after reopening without repairing or replaying the old execution',
    async ({ length, notice, outcome }) => {
      const f = await fixture();
      f.native.inspect.mockResolvedValue({
        ...f.nativeData,
        events: f.nativeData.events.slice(0, length),
      });
      if (length < 7) f.attachments.mockResolvedValue([]);
      const saved = await f.capture();
      f.native.inspect.mockRejectedValue(new Error('Source remains offline'));
      const refreshAuthentication = vi.fn(() => {
        throw new Error('Cold history must not refresh native authentication');
      });
      // Deliberately unavailable runtime: the BFF only has host storage ports.
      Object.assign(f.native, { refreshAuthentication });
      for (let reopen = 0; reopen < 2; reopen++) {
        const handlers = createDEntryHistoryHandlers({
          resources: f.resources,
          binding: f.bindingPort,
          store: new HostHistoryStore(f.root),
          context: async () => f.context,
        });
        const response = await handlers.history(f.request({ limit: 100 }));
        expect(response.status).toBe(200);
        const page: HostHistoryPage = await response.json();
        expect(page.snapshotDigest).toBe(saved.digest);
        expect(page.notice).toBe(notice);
        expect(page.externalEffects).toBe('unverified');
        expect(
          page.entries.find((entry) => entry.kind === 'tool'),
        ).toMatchObject({
          callId: 'effect-call',
          outcome,
        });
        expect(Object.keys(handlers).sort()).toEqual(['download', 'history']);
      }
      expect(f.native.inspect).toHaveBeenCalledTimes(1);
      expect(f.native.resolveAgent).not.toHaveBeenCalled();
      expect(f.native.prompt).not.toHaveBeenCalled();
      expect(refreshAuthentication).not.toHaveBeenCalled();
      expect(f.execution).toEqual({
        vmStarts: 0,
        modelRequests: 0,
        replays: 0,
      });
    },
  );

  it('keeps commit-before-ack unknown on reread; an explicit new execution has its own identity', async () => {
    const f = await fixture();
    // Test-only business/execute owner: v1 has no frozen API for either.
    // This proves history isolation, not a production receipt binding or VM kill.
    const effects = new Map<string, number>();
    const execute = vi.fn(async (executionId: string, loseAck: boolean) => {
      effects.set(executionId, (effects.get(executionId) ?? 0) + 1);
      if (loseAck) throw new Error('Committed before ACK was lost');
    });
    await expect(execute('old-execution', true)).rejects.toThrow('ACK');
    const original = await f.capture();
    const request = f.request({ limit: 100 });
    for (let reopen = 0; reopen < 2; reopen++) {
      const handlers = createDEntryHistoryHandlers({
        resources: f.resources,
        binding: f.bindingPort,
        store: new HostHistoryStore(f.root),
        context: async () => f.context,
      });
      const page: HostHistoryPage = await (
        await handlers.history(request)
      ).json();
      expect(page.externalEffects).toBe('unverified');
      expect(page.entries.find((entry) => entry.kind === 'tool')).toMatchObject(
        {
          outcome: 'outcome-unknown',
        },
      );
    }
    expect([...effects]).toEqual([['old-execution', 1]]);
    expect(execute).toHaveBeenCalledTimes(1);
    // Only this separate explicit call executes; a history read cannot invoke it.
    await execute('explicit-new-execution', false);
    expect([...effects]).toEqual([
      ['old-execution', 1],
      ['explicit-new-execution', 1],
    ]);
    expect(
      (
        await new HostHistoryStore(f.root).read(
          f.binding,
          new AbortController().signal,
          original.digest,
        )
      )?.snapshot,
    ).toEqual(original.snapshot);
    expect(f.native.resolveAgent).not.toHaveBeenCalled();
    expect(f.native.prompt).not.toHaveBeenCalled();
  });

  it.each(['inspect', 'attachments'] as const)(
    'joins a revoked pending %s export before rejecting, without publishing a late result',
    async (stage) => {
      const f = await fixture();
      const entered = gate();
      const aborted = gate();
      const drained = gate();
      const reason = new DataAccessError('authorization_denied');
      const hold = async (signal: AbortSignal) => {
        signal.addEventListener('abort', aborted.release, { once: true });
        entered.release();
        await drained.promise;
        signal.removeEventListener('abort', aborted.release);
      };
      if (stage === 'inspect')
        f.native.inspect.mockImplementationOnce(async (_id, signal) => {
          await hold(signal!);
          return f.nativeData;
        });
      else
        f.attachments.mockImplementationOnce(async (_binding, signal) => {
          await hold(signal);
          return [f.attachment];
        });
      const publish = vi.spyOn(f.store, 'publish');
      let settled = false;
      const pending = f.capture();
      const outcome = pending.then(
        () => {
          settled = true;
          return null;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await entered.promise;
      f.revoked.abort(reason);
      await aborted.promise;
      expect(settled).toBe(false);
      expect(publish).not.toHaveBeenCalled();
      drained.release();
      expect(await outcome).toBe(reason);
      expect(publish).not.toHaveBeenCalled();
      expect(
        await new HostHistoryStore(f.root).read(
          f.binding,
          new AbortController().signal,
        ),
      ).toBeNull();
    },
  );

  it('rereads an export committed before its acknowledgement was lost without recapturing or executing', async () => {
    const f = await fixture();
    const publish = f.store.publish.bind(f.store);
    const committed = gate();
    const ack = gate();
    let digest!: string;
    vi.spyOn(f.store, 'publish').mockImplementationOnce(
      async (snapshot, signal) => {
        digest = await publish(snapshot, signal);
        committed.release();
        await ack.promise;
        throw new Error('Checkpoint committed; acknowledgement lost');
      },
    );
    const pending = f.capture();
    const rejected = expect(pending).rejects.toThrow('acknowledgement lost');
    await committed.promise;
    const reopened = new HostHistoryStore(f.root);
    expect(
      (await reopened.read(f.binding, new AbortController().signal))?.digest,
    ).toBe(digest);
    ack.release();
    await rejected;
    f.native.inspect.mockRejectedValue(new Error('Source offline after crash'));
    const page: HostHistoryPage = await (
      await f.handlers.history(f.request({ limit: 100 }))
    ).json();
    expect(page.snapshotDigest).toBe(digest);
    expect(page.externalEffects).toBe('unverified');
    expect(f.native.inspect).toHaveBeenCalledTimes(1);
    expect(f.store.publish).toHaveBeenCalledTimes(1);
    expect(f.execution).toEqual({ vmStarts: 0, modelRequests: 0, replays: 0 });
  });

  it.each(['root', 'config', 'request'] as const)(
    'joins pending acquire and a late handle close after %s revocation',
    async (scope) => {
      const f = await fixture();
      const saved = await f.capture();
      const entered = gate();
      const aborted = gate();
      const acquired = gate();
      const closing = gate();
      const closed = gate();
      f.files.acquire.mockImplementationOnce(
        async (_context, _objectId, signal) => {
          signal.addEventListener('abort', aborted.release, { once: true });
          entered.release();
          await acquired.promise;
          signal.removeEventListener('abort', aborted.release);
          return f.owner;
        },
      );
      f.owner.close.mockImplementationOnce(async () => {
        closing.release();
        await closed.promise;
      });
      const cancel = new AbortController();
      let settled = false;
      const pending = f.handlers.download(
        f.request(
          {
            snapshotDigest: saved.digest,
            objectId: f.object.id,
          },
          cancel.signal,
        ),
      );
      void pending.then(() => {
        settled = true;
      });
      await entered.promise;
      const reason = new DataAccessError('authorization_denied');
      if (scope === 'request') cancel.abort(reason);
      else {
        // Test-only 271/config authority: no production config notification
        // interface is invented. The owner must revoke its real resource signal.
        if (scope === 'config')
          f.bindingPort.mockResolvedValue({
            ...f.binding,
            configurationDigest: hostHistoryDigest({ changed: true }),
          });
        f.revoked.abort(reason);
      }
      await aborted.promise;
      expect(settled).toBe(false);
      expect(f.owner.close).not.toHaveBeenCalled();
      acquired.release();
      await closing.promise;
      expect(settled).toBe(false);
      closed.release();
      expect((await pending).status).toBe(403);
      expect(f.owner.open).not.toHaveBeenCalled();
      expect(f.owner.close).toHaveBeenCalledTimes(1);
      expect(spoolIO.files).toEqual([]);
    },
  );

  it.each(['root', 'config'] as const)(
    'joins a late history binding after %s revocation and admits no storage read',
    async (scope) => {
      const f = await fixture();
      await f.capture();
      const entered = gate();
      const aborted = gate();
      const drained = gate();
      const binding = vi.fn(
        async (_resource: DEntryNativeResource, signal: AbortSignal) => {
          signal.addEventListener('abort', aborted.release, { once: true });
          entered.release();
          await drained.promise;
          signal.removeEventListener('abort', aborted.release);
          return f.binding;
        },
      );
      const store = new HostHistoryStore(f.root);
      const read = vi.spyOn(store, 'read');
      const handlers = createDEntryHistoryHandlers({
        resources: f.resources,
        binding,
        store,
        context: async () => f.context,
      });
      let settled = false;
      const pending = handlers.history(f.request({ limit: 100 }));
      void pending.then(() => {
        settled = true;
      });
      await entered.promise;
      if (scope === 'config')
        f.binding.configurationDigest = hostHistoryDigest({ changed: true });
      f.revoked.abort(new DataAccessError('authorization_denied'));
      await aborted.promise;
      expect(settled).toBe(false);
      drained.release();
      expect((await pending).status).toBe(403);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each(['root', 'config', 'object'] as const)(
    'joins pending object reauthorization and close after %s revocation',
    async (scope) => {
      const f = await fixture();
      const saved = await f.capture();
      const entered = gate();
      const aborted = gate();
      const drained = gate();
      const closing = gate();
      const closed = gate();
      f.owner.reauthorize.mockImplementationOnce(async (signal) => {
        signal.addEventListener('abort', aborted.release, { once: true });
        entered.release();
        await drained.promise;
        signal.removeEventListener('abort', aborted.release);
        return f.object;
      });
      f.owner.close.mockImplementationOnce(async () => {
        closing.release();
        await closed.promise;
      });
      let settled = false;
      const pending = f.handlers.download(
        f.request({
          snapshotDigest: saved.digest,
          objectId: f.object.id,
        }),
      );
      void pending.then(() => {
        settled = true;
      });
      await entered.promise;
      const reason = new DataAccessError('authorization_denied');
      if (scope === 'object') f.objectRevoked.abort(reason);
      else {
        if (scope === 'config')
          f.bindingPort.mockResolvedValue({
            ...f.binding,
            configurationDigest: hostHistoryDigest({ changed: true }),
          });
        f.revoked.abort(reason);
      }
      await aborted.promise;
      expect(settled).toBe(false);
      expect(f.owner.close).not.toHaveBeenCalled();
      drained.release();
      await closing.promise;
      expect(settled).toBe(false);
      closed.release();
      expect((await pending).status).toBe(403);
      expect(f.owner.open).not.toHaveBeenCalled();
      expect(f.owner.close).toHaveBeenCalledTimes(1);
      expect(spoolIO.files).toEqual([]);
    },
  );

  it.each(['root-source', 'configuration'] as const)(
    'fails closed when the production %s is unbound, without reading storage or opening a file',
    async (missing) => {
      const f = await fixture();
      const saved = await f.capture();
      const store = new HostHistoryStore(f.root);
      const read = vi.spyOn(store, 'read');
      const unavailable = new DEntryDependencyUnavailable('native-route');
      if (missing === 'root-source')
        f.resources.resolve.mockRejectedValue(unavailable);
      else f.bindingPort.mockRejectedValue(unavailable);
      const handlers = createDEntryHistoryHandlers({
        resources: f.resources,
        binding: f.bindingPort,
        store,
        context: async () => f.context,
        files: f.files,
      });
      for (const response of [
        await handlers.history(f.request({ limit: 100 })),
        await handlers.download(
          f.request({ snapshotDigest: saved.digest, objectId: f.object.id }),
        ),
      ]) {
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          error: { code: 'DEPENDENCY_UNAVAILABLE', retryable: false },
        });
      }
      expect(read).not.toHaveBeenCalled();
      expect(f.files.acquire).not.toHaveBeenCalled();
      expect(f.native.inspect).toHaveBeenCalledTimes(1);
      expect(f.execution).toEqual({
        vmStarts: 0,
        modelRequests: 0,
        replays: 0,
      });
    },
  );
});
