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
import * as contracts from '@allrice/contracts';
import * as database from '../core/client.ts';
import * as search from '../reference-search.ts';
import { createRuntimeFixtureDatabase } from '../runtime.fixture.ts';
import { referenceToolFixture } from '../reference-tool.fixture.ts';
import { changeReferencePublication } from '../reference-library.ts';
import {
  executeEmployeeReferenceTool,
  assertEmployeeContentContext,
} from './employee-runtime-content.ts';
import { hasRevokedReferencePublicationHistory } from '../reference-runtime.ts';
import { completeJob } from '../execution/queue.ts';
import { sendChatMessage } from '../workspace/service.ts';
import { releaseConversationRuntime } from '../conversation/conversation-runtime.ts';

function referenceGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('R3 actual-read receipts and private Run authority', () => {
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
    // Fixture-only terminal cleanup; no native processes run in this suite.
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
  type Run = Awaited<ReturnType<typeof x.run>>;
  const invoke = (
    run: Run,
    name: contracts.ReferenceToolName,
    input: unknown,
  ) =>
    executeEmployeeReferenceTool(
      run.scope,
      run.runtime.generationId,
      run.worker,
      name,
      input,
    );
  const receipts = async (run: Run) =>
    contracts.ReferenceReadsSchema.parse(
      (
        await f.db`select reference_reads from allrice_employee_runs where run_id=${run.scope.runId}`
      )[0]!.reference_reads,
    );
  const withdraw = (sourceId: string, audience?: contracts.ReferenceAudience) =>
    changeReferencePublication(x.publisher, sourceId, {
      workspaceId: x.publisher.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 1,
      ...(audience ? { action: 'audience', audience } : { action: 'delete' }),
    });

  it('“查企业资料里的差旅上限并列出处” freezes tools at real admission and records exact search/read excerpts with stable labels', async () => {
    const text = '背景。'.repeat(2000) + '差旅上限九百元。';
    const saved = await x.publish(text);
    const run = await x.run();
    expect(
      run.resolved.executionSnapshot!.capabilitySnapshot.bindings.toolNames,
    ).toEqual(expect.arrayContaining([...contracts.referenceToolNames]));
    const found = JSON.parse(
      (await invoke(run, 'workspace.reference.search', { query: '差旅上限' }))
        .modelContent,
    );
    const result = found.results.find(
      (item: { sourceId: string }) => item.sourceId === saved.sourceId,
    );
    expect(result).toMatchObject({
      ...saved.pin,
      excerpt: {
        content: '差旅上限九百元。',
        start: 6000,
        citation: { referenceLabel: 'R1' },
      },
    });
    const first = await receipts(run);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      origin: { kind: 'tool', toolName: 'workspace.reference.search' },
      runId: run.scope.runId,
      generationId: run.runtime.generationId,
      citation: {
        reference: saved.pin,
        locator: { start: 6000, end: text.length },
      },
      contentChecksum:
        'sha256:' +
        createHash('sha256').update('差旅上限九百元。').digest('hex'),
    });
    const reread = JSON.parse(
      (
        await invoke(run, 'workspace.reference.read', {
          ...saved.pin,
          offset: 6000,
        })
      ).modelContent,
    );
    expect(reread.citation.id).toBe(first[0]!.receiptId);
    expect(await receipts(run)).toEqual(first);
    const next = JSON.parse(
      (
        await invoke(run, 'workspace.reference.read', {
          ...saved.pin,
          offset: 0,
          limit: 100,
        })
      ).modelContent,
    );
    expect(next.citation.referenceLabel).toBe('R2');
    expect(await receipts(run)).toHaveLength(2);
    expect((await receipts(run))[1]!.origin).toEqual({
      kind: 'tool',
      toolName: 'workspace.reference.read',
    });
    expect(JSON.stringify([found, reread, next])).not.toContain('file:');
    expect(reread.fileName).toBe('差旅规定.txt');
  }, 120000);

  it('distinguishes N-1, EOF and out-of-range without empty or invented read receipts', async () => {
    const saved = await x.publish('甲乙丙');
    const run = await x.run();
    const last = JSON.parse(
      (
        await invoke(run, 'workspace.reference.read', {
          ...saved.pin,
          offset: 2,
        })
      ).modelContent,
    );
    expect(last).toMatchObject({
      content: '丙',
      start: 2,
      end: 3,
      nextOffset: null,
      citation: { referenceLabel: 'R1' },
    });
    const first = await receipts(run);
    expect(first).toHaveLength(1);
    const eof = await invoke(run, 'workspace.reference.read', {
      ...saved.pin,
      offset: 3,
    });
    expect(eof.itemCount).toBe(0);
    expect(JSON.parse(eof.modelContent)).toMatchObject({
      content: '',
      start: 3,
      end: 3,
      nextOffset: null,
      totalCharacters: 3,
      locations: [],
    });
    expect(JSON.parse(eof.modelContent)).not.toHaveProperty('citation');
    expect(await receipts(run)).toEqual(first);
    await expect(
      invoke(run, 'workspace.reference.read', { ...saved.pin, offset: 4 }),
    ).rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
    expect(await receipts(run)).toEqual(first);
  }, 120000);

  it('never expands an old frozen allowlist on recovery', async () => {
    const original = contracts.freezeReferenceToolNames;
    const selection = vi
      .spyOn(contracts, 'freezeReferenceToolNames')
      .mockImplementation((names) => [...names]);
    let run: Run;
    try {
      run = await x.run();
    } finally {
      selection.mockRestore();
    }
    expect(contracts.freezeReferenceToolNames).toBe(original);
    await expect(
      invoke(run!, 'workspace.reference.search', { query: '差旅' }),
    ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
    expect(await receipts(run!)).toEqual([]);
  }, 120000);

  it('rejects forged owner, Run, generation, lease and source pins without appending evidence', async () => {
    const saved = await x.publish('私有范围测试政策');
    const run = await x.run();
    for (const scope of [
      { ...run.scope, ownerId: randomUUID() },
      { ...run.scope, runId: randomUUID() },
    ])
      await expect(
        executeEmployeeReferenceTool(
          scope,
          run.runtime.generationId,
          run.worker,
          'workspace.reference.read',
          saved.pin,
        ),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
    await expect(
      executeEmployeeReferenceTool(
        run.scope,
        randomUUID(),
        run.worker,
        'workspace.reference.read',
        saved.pin,
      ),
    ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
    await expect(
      executeEmployeeReferenceTool(
        run.scope,
        run.runtime.generationId,
        { ...run.worker, leaseToken: randomUUID() },
        'workspace.reference.read',
        saved.pin,
      ),
    ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
    await expect(
      invoke(run, 'workspace.reference.read', {
        ...saved.pin,
        digest: 'sha256:' + 'f'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
    expect(await receipts(run)).toEqual([]);
  }, 120000);

  it.each(['audience', 'delete', 'derivation', 'lease'] as const)(
    'keeps scans outside realtime locks and rejects %s changes before the receipt commit',
    async (loss) => {
      const saved = await x.publish('并发保护-' + loss);
      const run = await x.run();
      const prepared = referenceGate(),
        release = referenceGate();
      const prepare = search.prepareReferenceText;
      const barrier = vi
        .spyOn(search, 'prepareReferenceText')
        .mockImplementation(async (...args) => {
          const value = await prepare(...args);
          prepared.resolve();
          await release.promise;
          return value;
        });
      const pending = invoke(run, 'workspace.reference.read', saved.pin);
      const observed = pending.then(
        () => ({ accepted: true }),
        (error) => ({ error }),
      );
      try {
        await prepared.promise;
        // These writes must commit while text is prepared. Waiting for the tool
        // would deadlock this deterministic fixture if it held authority locks.
        if (loss === 'audience')
          await withdraw(saved.sourceId, {
            scope: 'personal',
            departmentIds: [],
          });
        else if (loss === 'delete') await withdraw(saved.sourceId);
        else if (loss === 'derivation')
          await f.db`update allrice_knowledge_documents set full_text=full_text||' changed' where knowledge_revision_id=${saved.revisionId}`;
        else
          await f.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${run.worker.jobId}`;
        release.resolve();
        const outcome = await observed;
        expect(outcome).toMatchObject({
          error: {
            code:
              loss === 'lease'
                ? 'EMPLOYEE_CONTENT_UNAVAILABLE'
                : 'REFERENCE_UNAVAILABLE',
          },
        });
        expect(await receipts(run)).toEqual([]);
      } finally {
        release.resolve();
        barrier.mockRestore();
        await observed;
      }
    },
    120000,
  );

  it('protects not-ready search metadata and coverage from concurrent loss of access', async () => {
    const saved = await x.publish('尚未处理', {
      ready: false,
      fileName: '覆盖范围保密.txt',
    });
    const run = await x.run();
    const prepared = referenceGate(),
      release = referenceGate();
    const prepare = search.prepareReferenceSearch;
    const barrier = vi
      .spyOn(search, 'prepareReferenceSearch')
      .mockImplementation(async (...args) => {
        const value = await prepare(...args);
        prepared.resolve();
        await release.promise;
        return value;
      });
    const observed = invoke(run, 'workspace.reference.search', {
      query: '覆盖范围保密',
    }).then(
      () => ({ accepted: true }),
      (error) => ({ error }),
    );
    try {
      await prepared.promise;
      await withdraw(saved.sourceId, { scope: 'personal', departmentIds: [] });
      release.resolve();
      expect(await observed).toMatchObject({ error: { code: 'not_found' } });
      expect(await receipts(run)).toEqual([]);
    } finally {
      release.resolve();
      barrier.mockRestore();
      await observed;
    }
  }, 120000);

  it('does not export oversized results or append a receipt for an over-budget response', async () => {
    const text = '页'.repeat(4000);
    const saved = await x.publish(text, {
      units: Array.from({ length: 4000 }, (_, i) => ({
        label: '天然位置 ' + i,
        start: i,
        end: i + 1,
      })),
    });
    const run = await x.run();
    await expect(
      invoke(run, 'workspace.reference.read', saved.pin),
    ).rejects.toMatchObject({ code: 'TOOL_RESULT_TOO_LARGE' });
    expect(await receipts(run)).toEqual([]);
    const [exports] =
      await f.db`select count(*)::int n from allrice_storage_objects where organization_id=${run.scope.organizationId} and category='exports'`;
    expect(exports!.n).toBe(0);
  }, 120000);

  it('retains the 64 receipt ceiling while allowing exact repeated reads', async () => {
    const saved = await x.publish('甲'.repeat(65));
    const run = await x.run();
    for (let offset = 0; offset < 64; offset++)
      await invoke(run, 'workspace.reference.read', {
        ...saved.pin,
        offset,
        limit: 1,
      });
    const before = await receipts(run);
    expect(before).toHaveLength(64);
    await expect(
      invoke(run, 'workspace.reference.read', {
        ...saved.pin,
        offset: 64,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
    expect(await receipts(run)).toEqual(before);
    expect(
      JSON.parse(
        (
          await invoke(run, 'workspace.reference.read', {
            ...saved.pin,
            offset: 0,
            limit: 1,
          })
        ).modelContent,
      ).citation.referenceLabel,
    ).toBe('R1');
  }, 120000);

  it('does not turn historical reference tolerance into a membership or Run authority bypass', async () => {
    const saved = await x.publish('当前成员资格仍为独立门卫');
    const run = await x.run();
    await invoke(run, 'workspace.reference.read', saved.pin);
    await f.db`update allrice_memberships set active=false where organization_id=${x.context.organizationId} and user_id=${x.context.actor.id}`;
    try {
      await expect(
        invoke(run, 'workspace.reference.read', saved.pin),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      expect(await receipts(run)).toHaveLength(1);
    } finally {
      await f.db`update allrice_memberships set active=true where organization_id=${x.context.organizationId} and user_id=${x.context.actor.id}`;
    }
  }, 120000);

  it('preserves actual-read context after withdrawal while refusing new reads and accepting continuation', async () => {
    const saved = await x.publish('后续会话使用的正式资料');
    const run = await x.run();
    await invoke(run, 'workspace.reference.read', saved.pin);
    expect(
      await hasRevokedReferencePublicationHistory(
        x.context,
        run.scope.sessionId,
      ),
    ).toBe(false);
    await withdraw(saved.sourceId);
    expect(
      await hasRevokedReferencePublicationHistory(
        x.context,
        run.scope.sessionId,
      ),
    ).toBe(true);
    await expect(
      assertEmployeeContentContext(run.scope, run.runtime.generationId),
    ).resolves.toBeUndefined();
    await expect(
      invoke(run, 'workspace.reference.read', saved.pin),
    ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
    await assertEmployeeContentContext(
      run.scope,
      run.runtime.generationId,
      run.worker,
    );
    await completeJob({
      ...run.worker,
      result: {
        answer: '资料现在不可再次读取，但可以继续讨论。',
        citations: [],
      },
    });
    await expect(
      sendChatMessage(x.context, run.scope.workspaceId, run.scope.sessionId, {
        text: '继续',
        clientMessageId: randomUUID(),
      }),
    ).resolves.toMatchObject({ created: true });
    expect(await receipts(run)).toHaveLength(1);
  }, 120000);
});
