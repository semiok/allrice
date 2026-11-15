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
  loadEmployeeRuntimeReferences,
} from './employee-runtime-content.ts';
import { releaseConversationRuntime } from '../conversation/conversation-runtime.ts';
import type { ReferenceImageExecution } from '../reference-image-read.ts';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
  'base64',
);
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('v1.8 publication image reads at real Run and lease boundaries', () => {
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
    bytes = png,
    mediaType = 'image/png',
    fileName = 'reference.png',
  ) {
    const saved = await publishReference(
      x.publisher,
      {
        origin: 'upload',
        workspaceId: x.publisher.workspaceId,
        requestId: randomUUID(),
        fileName,
        mediaType,
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
    return { ...saved, listed: listed!, pin: referenceReadPin(listed!) };
  }
  type Run = Awaited<ReturnType<typeof x.run>>;
  const image = {
    attachmentId: `sha256:${'e'.repeat(64)}`,
    mediaType: 'image/png' as const,
    bytes: 80,
    width: 1,
    height: 1,
    name: 'reference.png',
  };
  function execution(): ReferenceImageExecution {
    return {
      storage: runtimeFixtureStorage(f.db),
      call: {
        id: randomUUID(),
        name: 'workspace.reference.read_image',
        nativeSessionId: 'native-image',
      },
      native: {
        route: vi.fn(async () => ({ supported: true as const })),
        save: vi.fn(async () => ({ image })),
      },
    };
  }
  const invoke = (
    run: Run,
    pin: unknown,
    port = execution(),
    signal?: AbortSignal,
  ) =>
    executeEmployeeReferenceTool(
      run.scope,
      run.runtime.generationId,
      run.worker,
      'workspace.reference.read_image',
      pin,
      signal,
      port,
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

  it('selects actual PNG despite unsupported text processing and misleading name/MIME; does not pre-read', async () => {
    const saved = await publish(
      png,
      'application/octet-stream',
      'not-an-extension',
    );
    expect(saved.listed).toMatchObject({
      processing: 'unsupported',
      fullTextReady: false,
      canReference: true,
      readCapabilities: { text: false, image: true, archive: false },
    });
    const selected = await readReferenceInputSelection(
      x.context,
      x.context.workspaceId!,
      saved.revisionId,
    );
    expect(selected).toMatchObject({
      canReference: true,
      readCapabilities: { image: true },
    });
    expect(selected.selection).not.toHaveProperty('readCapabilities');
    const run = await x.run(undefined, [saved.revisionId]);
    expect(
      await loadEmployeeRuntimeReferences(
        run.scope,
        run.runtime.generationId,
        run.worker,
      ),
    ).toEqual([]);
    expect(await receipts(run)).toEqual([]);
    const port = execution();
    const first = await invoke(run, saved.pin, port);
    expect(first).toMatchObject({
      itemCount: 1,
      referenceImage: {
        kind: 'image',
        image,
        sourceChecksum: `sha256:${createHash('sha256').update(png).digest('hex')}`,
      },
    });
    expect(port.native.save).toHaveBeenCalledWith({
      data: png,
      mediaType: 'image/png',
      name: saved.listed.fileName,
    });
    const secondPort = execution();
    const second = await invoke(run, saved.pin, secondPort);
    expect(second).toEqual(first);
    expect(await receipts(run)).toMatchObject([
      {
        schemaVersion: 2,
        readKind: 'image',
        call: port.call,
        contentChecksum: image.attachmentId,
        citation: { referenceLabel: 'R1' },
      },
    ]);
  });
  it('does not qualify user MIME/filename when actual content is not an image', async () => {
    const saved = await publish(
      Buffer.from('plain content'),
      'image/png',
      'claimed.png',
    );
    expect(saved.listed).toMatchObject({
      canReference: false,
      readCapabilities: { image: false },
    });
    await expect(
      readReferenceInputSelection(
        x.context,
        x.context.workspaceId!,
        saved.revisionId,
      ),
    ).rejects.toMatchObject({ code: 'REFERENCE_SELECTION_UNAVAILABLE' });
    const run = await x.run();
    const port = execution();
    await expect(invoke(run, saved.pin, port)).rejects.toMatchObject({
      code: 'REFERENCE_READ_UNSUPPORTED',
      reason: 'media_type',
    });
    expect(port.native.save).not.toHaveBeenCalled();
    expect(await receipts(run)).toEqual([]);
  });
  it('rejects unknown/text route before reading bytes, with a user-facing explanation', async () => {
    const saved = await publish();
    const run = await x.run();
    const port = execution();
    port.native.route = vi.fn(async () => ({
      error: {
        code: 'REFERENCE_READ_UNSUPPORTED',
        reason: 'image_route',
        message:
          '当前模型路由未明确支持图片输入，暂时无法查看这张企业资料图片。',
        retryable: false,
      },
    }));
    const get = vi.spyOn(port.storage, 'get');
    try {
      await expect(invoke(run, saved.pin, port)).rejects.toMatchObject({
        reason: 'image_route',
        message: expect.stringContaining('无法查看'),
      });
      expect(get).not.toHaveBeenCalled();
      expect(port.native.save).not.toHaveBeenCalled();
      expect(await receipts(run)).toEqual([]);
    } finally {
      get.mockRestore();
    }
  });
  it.each(['revoked', 'wrong-pin', 'old-grant', 'expired-lease'] as const)(
    'rejects %s before route and storage',
    async (kind) => {
      const saved = await publish();
      const freeze =
        kind === 'old-grant'
          ? vi
              .spyOn(contracts, 'freezeReferenceToolNames')
              .mockImplementation((names) => [...names])
          : undefined;
      let run: Run;
      try {
        run = await x.run();
      } finally {
        freeze?.mockRestore();
      }
      const port = execution();
      let pin = saved.pin;
      if (kind === 'revoked') await revoke(saved);
      if (kind === 'wrong-pin')
        pin = { ...pin, digest: `sha256:${'d'.repeat(64)}` };
      if (kind === 'expired-lease')
        await f.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${run.worker.jobId}`;
      await expect(invoke(run, pin, port)).rejects.toBeInstanceOf(Error);
      expect(port.native.route).not.toHaveBeenCalled();
      expect(port.native.save).not.toHaveBeenCalled();
      expect(await receipts(run)).toEqual([]);
    },
  );
  it.each(['revoked', 'expired-lease', 'canceled'] as const)(
    'does not commit or return after native persistence then %s',
    async (kind) => {
      const saved = await publish();
      const run = await x.run();
      const port = execution();
      const controller = new AbortController();
      port.native.save = vi.fn(async () => {
        if (kind === 'revoked') await revoke(saved);
        if (kind === 'expired-lease')
          await f.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${run.worker.jobId}`;
        if (kind === 'canceled') controller.abort();
        return { image };
      });
      await expect(
        invoke(run, saved.pin, port, controller.signal),
      ).rejects.toBeInstanceOf(Error);
      expect(port.native.save).toHaveBeenCalledTimes(1);
      expect(await receipts(run)).toEqual([]);
    },
  );
  it('concurrent final receipt slot commits one result and refuses the other', async () => {
    const saved = await publish();
    const other = await publish();
    const text = await x.publish('a'.repeat(63));
    const run = await x.run();
    for (let offset = 0; offset < 63; offset++)
      await executeEmployeeReferenceTool(
        run.scope,
        run.runtime.generationId,
        run.worker,
        'workspace.reference.read',
        { ...text.pin, offset, limit: 1 },
      );
    const outcomes = await Promise.allSettled([
      invoke(run, saved.pin),
      invoke(run, other.pin),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'REFERENCE_READ_LIMIT', reason: 'receipt_budget' },
    });
    const reads = await receipts(run);
    expect(reads).toHaveLength(64);
    expect(reads[63]).toMatchObject({
      readKind: 'image',
      citation: { referenceLabel: 'R64' },
      contentChecksum: image.attachmentId,
    });
    expect(reads[63]!.citation.reference.checksum).not.toBe(image.attachmentId);
  }, 120000);
});
