import { randomUUID, createHash } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { zipSync } from 'fflate';
import { ReferenceReadsSchema } from '@allrice/contracts';
import * as contracts from '@allrice/contracts';
import * as database from '../core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from '../runtime.fixture.ts';
import { referenceToolFixture } from '../reference-tool.fixture.ts';
import {
  publishReference,
  listReferencePublications,
  changeReferencePublication,
} from '../reference-library.ts';
import { readReferenceInputSelection } from '../reference-runtime.ts';
import { referenceReadPin } from '../reference-search.ts';
import {
  executeEmployeeReferenceTool,
  loadEmployeeRuntimeReferenceContext,
} from './employee-runtime-content.ts';
import { releaseConversationRuntime } from '../conversation/conversation-runtime.ts';
import type { ReferenceImageExecution } from '../reference-image-read.ts';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
  'base64',
);
const sha = (bytes: Uint8Array | string) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('R4b exact parent ZIP permissions and typed read ledger', () => {
  let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let x: Awaited<ReturnType<typeof referenceToolFixture>>;
  beforeAll(async () => {
    f = await createRuntimeFixtureDatabase();
    vi.spyOn(database, 'getDatabase').mockReturnValue(f.db);
    x = await referenceToolFixture(f);
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await f?.close();
  }, 30000);
  afterEach(async () => {
    const rows =
      await f.db`select organization_id,workspace_id,session_id,active_run_id,worker_id from allrice_conversation_runtimes where state='running'`;
    for (const row of rows)
      await releaseConversationRuntime({
        organizationId: row.organization_id,
        workspaceId: row.workspace_id,
        sessionId: row.session_id,
        runId: row.active_run_id,
        workerId: row.worker_id,
        outcome: 'idle',
      });
    await f.db`update allrice_jobs set status='canceled',completed_at=clock_timestamp() where status='running'`;
    await f.db`update allrice_runs set state='canceled',completed_at=clock_timestamp() where state='running'`;
    await f.db`update allrice_employee_runs set status='canceled',completed_at=clock_timestamp() where status='running'`;
  });
  async function publish(
    files: Record<string, Uint8Array> = {
      'note.txt': Buffer.from('正文😀abc'),
      'image.png': png,
    },
    name = 'bundle.zip',
  ) {
    const bytes = Buffer.from(zipSync(files, { level: 0 }));
    const saved = await publishReference(
      x.publisher,
      {
        origin: 'upload',
        workspaceId: x.publisher.workspaceId,
        requestId: randomUUID(),
        fileName: name,
        mediaType: 'application/octet-stream',
        contentBase64: bytes.toString('base64'),
        audience: { scope: 'company', departmentIds: [] },
      },
      runtimeFixtureStorage(f.db),
    );
    await f.db`update allrice_knowledge_processing set state='unsupported' where revision_id=${saved.revisionId}`;
    const [listed] = await listReferencePublications(
      x.context,
      x.context.workspaceId!,
      saved.sourceId,
    );
    return { ...saved, bytes, listed: listed!, pin: referenceReadPin(listed!) };
  }
  type Run = Awaited<ReturnType<typeof x.run>>;
  type Name =
    'workspace.reference.archive_list' | 'workspace.reference.archive_read';
  const image = {
    attachmentId: 'sha256:' + 'f'.repeat(64),
    mediaType: 'image/webp' as const,
    bytes: 50,
    width: 1,
    height: 1,
  };
  function execution(name: Name): ReferenceImageExecution {
    return {
      storage: runtimeFixtureStorage(f.db),
      call: { id: randomUUID(), name, nativeSessionId: 'native-zip' },
      native: {
        deadlineAt: Date.now() + 30000,
        route: vi.fn(async () => ({ supported: true as const })),
        save: vi.fn(async () => ({ image })),
      },
      parseText: vi.fn(async (bytes) => {
        const text = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
        return {
          mediaType: 'text/plain',
          fullText: {
            kind: 'text' as const,
            text,
            warnings: ['preserved parser warning'],
            units: [{ label: '正文', start: 0, end: text.length }],
          },
        };
      }),
    };
  }
  const invoke = (
    run: Run,
    name: Name,
    args: unknown,
    port = execution(name),
    signal?: AbortSignal,
  ) =>
    executeEmployeeReferenceTool(
      run.scope,
      run.runtime.generationId,
      run.worker,
      name,
      args,
      signal,
      port,
    );
  const read = async (
    run: Run,
    args: unknown,
    port?: ReferenceImageExecution,
    signal?: AbortSignal,
  ) =>
    JSON.parse(
      (
        await invoke(
          run,
          'workspace.reference.archive_read',
          args,
          port,
          signal,
        )
      ).modelContent,
    );
  const list = async (run: Run, args: unknown) =>
    JSON.parse(
      (await invoke(run, 'workspace.reference.archive_list', args))
        .modelContent,
    );
  const receipts = async (run: Run) => {
    const [row] =
      await f.db`select reference_reads from allrice_employee_runs where run_id=${run.scope.runId}`;
    return ReferenceReadsSchema.parse(row!.reference_reads ?? []);
  };
  const revoke = (saved: { sourceId: string }) =>
    changeReferencePublication(x.publisher, saved.sourceId, {
      workspaceId: x.publisher.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 1,
      action: 'delete',
    });
  it('keeps 50 images in one publication, selects metadata without a read, and pages the exact directory', async () => {
    const saved = await publish(
      Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [`图片/${i}.png`, png]),
      ),
      'misleading.bin',
    );
    expect(saved.listed).toMatchObject({
      processing: 'unsupported',
      canReference: true,
      readCapabilities: { text: false, image: false, archive: true },
      fullTextReady: false,
    });
    const selected = await readReferenceInputSelection(
      x.context,
      x.context.workspaceId!,
      saved.revisionId,
    );
    expect(selected.selection).not.toHaveProperty('readCapabilities');
    const run = await x.run(undefined, [saved.revisionId]);
    expect(
      await loadEmployeeRuntimeReferenceContext(
        run.scope,
        run.runtime.generationId,
        run.worker,
      ),
    ).toMatchObject({
      knowledge: [],
      references: [{ readCapabilities: { archive: true } }],
    });
    expect(await receipts(run)).toEqual([]);
    const first = await list(run, { ...saved.pin, limit: 10 });
    expect(first.entries).toHaveLength(10);
    expect(first.totalEntries).toBe(50);
    expect(first.entries[0]).toMatchObject({
      readAs: 'image',
      contentVerification: 'not_read',
    });
    expect(first.entries[0]).not.toHaveProperty('checksum');
    const same = await list(run, { ...saved.pin, limit: 10 });
    expect(same).toEqual(first);
    expect(await receipts(run)).toHaveLength(1);
    let cursor = first.nextCursor;
    const collected = [...first.entries];
    while (cursor) {
      const page = await list(run, { ...saved.pin, cursor });
      expect(page.citation.locator.startEntryIndex).toBe(cursor.nextEntryIndex);
      collected.push(...page.entries);
      cursor = page.nextCursor;
    }
    expect(collected).toHaveLength(50);
    const port = execution('workspace.reference.archive_read');
    const result = await read(
      run,
      { ...saved.pin, entryId: collected[17].entryId, as: 'image' },
      port,
    );
    expect(port.native.save).toHaveBeenCalledWith({
      data: png,
      mediaType: 'image/png',
      name: '17.png',
    });
    expect(result).toMatchObject({
      kind: 'image',
      sourceChecksum: sha(png),
      reference: saved.pin,
      member: { path: '图片/17.png', checksum: sha(png) },
    });
    expect(result.sourceChecksum).not.toBe(saved.pin.checksum);
    expect((await receipts(run)).at(-1)).toMatchObject({
      readKind: 'image',
      origin: { toolName: 'workspace.reference.archive_read' },
      contentChecksum: image.attachmentId,
    });
    const [count] =
      await f.db`select count(*)::int n from allrice_knowledge_sources where id=${saved.sourceId}`;
    expect(count!.n).toBe(1);
  });
  it('preserves full member text checksum, surrogate paging, warnings, deduplication and EOF without a receipt', async () => {
    const saved = await publish();
    const run = await x.run();
    const dir = await list(run, saved.pin);
    const base = { ...saved.pin, entryId: dir.entries[0].entryId, as: 'text' };
    const first = await read(run, {
      ...base,
      offset: 2,
      limit: 1,
      expectedTextChecksum: sha('正文😀abc'),
    });
    expect(first).toMatchObject({
      content: '😀',
      start: 2,
      end: 4,
      nextOffset: 4,
      textChecksum: sha('正文😀abc'),
      warnings: ['preserved parser warning'],
    });
    expect((await receipts(run))[1]).toMatchObject({
      readKind: 'archive_member_text',
      contentChecksum: sha('😀'),
    });
    expect(
      await read(run, {
        ...base,
        offset: 2,
        limit: 1,
        expectedTextChecksum: first.textChecksum,
      }),
    ).toEqual(first);
    const eof = await read(run, {
      ...base,
      offset: first.totalCharacters,
      expectedTextChecksum: first.textChecksum,
    });
    expect(eof).toMatchObject({
      content: '',
      citation: null,
      receiptId: null,
      nextOffset: null,
    });
    expect(await receipts(run)).toHaveLength(2);
    await expect(
      read(run, {
        ...base,
        offset: first.totalCharacters + 1,
        expectedTextChecksum: first.textChecksum,
      }),
    ).rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
    await expect(
      read(run, { ...base, expectedTextChecksum: sha('wrong') }),
    ).rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
  });
  it('binds directory cursor and entry IDs to all pin fields, even when names and bytes match', async () => {
    const a = await publish(),
      b = await publish();
    const run = await x.run();
    const dir = await list(run, { ...a.pin, limit: 1 });
    await expect(
      list(run, { ...b.pin, cursor: dir.nextCursor }),
    ).rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
    await expect(
      read(run, { ...b.pin, entryId: dir.entries[0].entryId, as: 'text' }),
    ).rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
    await expect(
      list(run, {
        ...a.pin,
        cursor: { ...dir.nextCursor, nextEntryIndex: 999 },
      }),
    ).rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
    await expect(
      list(run, { ...a.pin, digest: b.pin.digest }),
    ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
    await revoke(a);
    await expect(
      read(run, { ...a.pin, entryId: dir.entries[0].entryId, as: 'text' }),
    ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
  });
  it('records an empty directory exactly once, and fits complete long paths inside the 12000-character envelope', async () => {
    const empty = await publish({}),
      run = await x.run();
    const page = await list(run, empty.pin);
    expect(page).toMatchObject({
      entries: [],
      totalEntries: 0,
      nextCursor: null,
    });
    expect(await list(run, empty.pin)).toEqual(page);
    const files = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [
        `${i}-${'a'.repeat(950)}.txt`,
        Buffer.from('x'),
      ]),
    );
    const large = await publish(files),
      result = await list(run, large.pin);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(12000);
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.length).toBeLessThan(20);
    expect(result.entries[0].path).toBe(Object.keys(files)[0]);
    expect(result.nextCursor.nextEntryIndex).toBe(result.entries.length);
    expect(await receipts(run)).toHaveLength(2);
  });
  it('refuses image routes before original reads while independent directory/text paths still work', async () => {
    const saved = await publish(),
      run = await x.run(),
      dir = await list(run, saved.pin);
    const port = execution('workspace.reference.archive_read');
    port.native.route = vi.fn(async () => ({
      error: {
        code: 'REFERENCE_READ_UNSUPPORTED' as const,
        reason: 'image_route' as const,
        message: '当前模型不支持看图，本次未读取图片内容。',
        retryable: false,
      },
    }));
    const get = vi.spyOn(port.storage, 'get');
    await expect(
      read(
        run,
        { ...saved.pin, entryId: dir.entries[1].entryId, as: 'image' },
        port,
      ),
    ).rejects.toMatchObject({
      reason: 'image_route',
      message: '当前模型不支持看图，本次未读取图片内容。',
    });
    expect(get).not.toHaveBeenCalled();
    expect(port.native.save).not.toHaveBeenCalled();
    await read(
      run,
      { ...saved.pin, entryId: dir.entries[0].entryId, as: 'text' },
      port,
    );
    expect(await receipts(run)).toHaveLength(2);
  });
  it.each(['revoke', 'lease', 'cancel'] as const)(
    'rechecks %s after native save and leaves no successful image receipt',
    async (mode) => {
      const saved = await publish(),
        run = await x.run(),
        dir = await list(run, saved.pin);
      const controller = new AbortController(),
        port = execution('workspace.reference.archive_read');
      port.native.save = async () => {
        if (mode === 'revoke') await revoke(saved);
        else if (mode === 'lease')
          await f.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${run.worker.jobId}`;
        else controller.abort(new Error('canceled'));
        return { image };
      };
      await expect(
        read(
          run,
          { ...saved.pin, entryId: dir.entries[1].entryId, as: 'image' },
          port,
          controller.signal,
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(await receipts(run)).toHaveLength(1);
    },
  );
  it('rechecks revoke after parsing failure before exposing member errors', async () => {
    const saved = await publish(),
      run = await x.run(),
      dir = await list(run, saved.pin),
      port = execution('workspace.reference.archive_read');
    port.parseText = async () => {
      await revoke(saved);
      throw new Error('private parser details');
    };
    await expect(
      read(
        run,
        { ...saved.pin, entryId: dir.entries[0].entryId, as: 'text' },
        port,
      ),
    ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
    expect(await receipts(run)).toHaveLength(1);
  });
  it('refuses frozen old grants without touching storage', async () => {
    const saved = await publish();
    const freeze = vi
      .spyOn(contracts, 'freezeReferenceToolNames')
      .mockImplementation((names) => [...names]);
    let run: Run;
    try {
      run = await x.run();
    } finally {
      freeze.mockRestore();
    }
    const port = execution('workspace.reference.archive_list');
    const get = vi.spyOn(port.storage, 'get');
    await expect(
      invoke(run, 'workspace.reference.archive_list', saved.pin, port),
    ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
    expect(get).not.toHaveBeenCalled();
  });
  it('shares the final receipt slot with all previous read kinds atomically', async () => {
    const a = await publish(),
      b = await publish(),
      text = await x.publish('a'.repeat(63)),
      run = await x.run();
    for (let offset = 0; offset < 63; offset++)
      await executeEmployeeReferenceTool(
        run.scope,
        run.runtime.generationId,
        run.worker,
        'workspace.reference.read',
        { ...text.pin, offset, limit: 1 },
      );
    const results = await Promise.allSettled([
      list(run, a.pin),
      list(run, b.pin),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({
      reason: { code: 'REFERENCE_READ_LIMIT', reason: 'receipt_budget' },
    });
    expect(await receipts(run)).toHaveLength(64);
  }, 120000);
});
