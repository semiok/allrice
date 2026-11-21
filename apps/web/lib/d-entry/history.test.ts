import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { DataAccessError } from '@allrice/database';
import {
  HostHistorySnapshotSchema,
  makeObjectKey,
  type DEntryIdentity,
  type HostHistoryBinding,
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

type SessionInspection = Awaited<
  ReturnType<Parameters<typeof captureHostHistory>[0]['native']['inspect']>
>;

const authority = vi.hoisted(() => ({
  identity: vi.fn(),
  generation: vi.fn(),
}));
vi.mock('./identity', () => ({ resolveDEntryIdentity: authority.identity }));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getSessionExecutionGeneration: authority.generation,
}));

const directories: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  authority.generation.mockResolvedValue('4.0');
});
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function fixture() {
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
    inspect: vi.fn(async () => nativeData),
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
  const bytes = new TextEncoder().encode('真实宿主附件字节 731');
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
  const attachments = vi.fn(async () => [attachment]);
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
  const files = {
    authorize: vi.fn(async () => object),
    open: vi.fn(async (current: StorageObject) => objectStorage.get(current)),
  };
  const handlers = createDEntryHistoryHandlers({
    resources,
    binding: bindingPort,
    store: new HostHistoryStore(root),
    context: async () => context,
    files,
  });
  const request = (params: Record<string, string | number> = {}) => {
    const query = new URLSearchParams({
      workspaceId: binding.workspaceId,
      employeeInstanceId: binding.employeeInstanceId,
      threadId: binding.threadId,
      nativeSessionId: binding.nativeSessionId,
    });
    for (const [key, value] of Object.entries(params))
      query.set(key, String(value));
    return new Request(`https://allrice.example/api/history?${query}`);
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
    f.files.authorize.mockResolvedValueOnce({
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
    expect(f.files.open).not.toHaveBeenCalled();
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

  it.each(['revoke', 'cancel'])(
    'cancels an actual stalled attachment reader on %s without a VM',
    async (mode) => {
      const f = await fixture();
      const saved = await f.capture();
      let opened!: () => void;
      const started = new Promise<void>((resolve) => {
        opened = resolve;
      });
      let cancelled = false;
      f.files.open.mockImplementation(
        async () =>
          new ReadableStream<Uint8Array>({
            pull() {
              opened();
            },
            cancel() {
              cancelled = true;
            },
          }),
      );
      const response = await f.handlers.download(
        f.request({ snapshotDigest: saved.digest, objectId: f.object.id }),
      );
      const reader = response.body!.getReader();
      const pending = reader.read();
      await started;
      if (mode === 'revoke') {
        f.revoked.abort();
        await expect(pending).rejects.toThrow();
      } else {
        await reader.cancel();
        await pending;
      }
      expect(cancelled).toBe(true);
      expect(f.execution).toEqual({
        vmStarts: 0,
        modelRequests: 0,
        replays: 0,
      });
    },
  );

  it('enforces current attachment authority for each chunk and exact streamed checksum', async () => {
    const f = await fixture();
    const saved = await f.capture();
    f.files.open.mockImplementation(
      async () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array([1, 2, 3]));
            c.close();
          },
        }),
    );
    const wrongBytes = await f.handlers.download(
      f.request({ snapshotDigest: saved.digest, objectId: f.object.id }),
    );
    await expect(wrongBytes.arrayBuffer()).rejects.toBeInstanceOf(
      HostHistoryIntegrityError,
    );
    f.files.authorize.mockRejectedValueOnce(
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
  });
  it('stops the actual download between chunks when object permission is revoked', async () => {
    const f = await fixture();
    const saved = await f.capture();
    let permitted = true;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    f.files.authorize.mockImplementation(async () => {
      if (!permitted) throw new DataAccessError('authorization_denied');
      return f.object;
    });
    f.files.open.mockImplementation(
      async () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            c.enqueue(f.bytes.slice(0, 4));
          },
          cancel() {
            cancelled = true;
          },
        }),
    );
    const response = await f.handlers.download(
      f.request({ snapshotDigest: saved.digest, objectId: f.object.id }),
    );
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(f.bytes.slice(0, 4));
    permitted = false;
    controller.enqueue(f.bytes.slice(4));
    await expect(reader.read()).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    expect(cancelled).toBe(true);
    expect(f.execution.modelRequests).toBe(0);
  });

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
