import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import { CloudRunnerBackend } from '../../../apps/worker/src/cloud-runner/backend.js';
import {
  runCloudCommandOperation,
  recoverCloudCommandOperations,
} from '../../../apps/worker/src/cloud-runner/executor.js';
import { cloudStableId } from './cloud-execution.ts';
import { revokeRuntimeActionApproval } from './runtime-policy.ts';
import { listCloudRuntimeOperations } from './cloud-operation-view.ts';
import { executeRiceTool } from '../../../apps/worker/src/tool-broker.js';
import { resolveCloudToolArguments } from '../../../apps/worker/src/tool-broker/handlers/cloud-frozen-script.js';
import { getToolBrokerFile } from './execution/tool-broker.ts';
import type * as Client from './core/client.ts';
let db: ReturnType<typeof postgres>,
  admin: ReturnType<typeof postgres>,
  storageRoot: string;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => db,
}));
const schema = `p15_cloud_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const backend = new CloudRunnerBackend();
// DB-only admissions never create a physical container. This adapter only
// reports current absence, which cannot prove a delayed create will not appear;
// real execution cases below always use runsc.
class NoContainersBackend extends CloudRunnerBackend {
  override async inspect() {
    return null;
  }
  override async cleanup() {}
  override async execute(): Promise<never> {
    throw Error('unexpected execution');
  }
}
const attempts: string[] = [];
const fixture = (
  options: Parameters<typeof createCloudExecutionFixture>[2] = {},
) => createCloudExecutionFixture(db, storageRoot, options);
suite('P15 real PostgreSQL governance and SaaS gVisor delivery', () => {
  beforeAll(async () => {
    if (!process.env.ALLRICE_TEST_DATABASE_URL)
      throw Error('dedicated DB required');
    vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '1');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
    admin = postgres(process.env.ALLRICE_TEST_DATABASE_URL, {
      max: 2,
      onnotice: () => {},
    });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(20260907,1)`;
      await tx`create extension if not exists vector with schema public`;
      await tx`create extension if not exists pg_trgm with schema public`;
    });
    await admin.unsafe(`create schema ${schema}`);
    const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL);
    url.searchParams.set('options', `-csearch_path=${schema},public`);
    db = postgres(url.toString(), { max: 12, onnotice: () => {} });
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(directory))
      .filter((f) => f.endsWith('.sql'))
      .sort())
      await db.unsafe(await readFile(new URL(file, directory), 'utf8'));
    storageRoot = await mkdtemp(join(tmpdir(), 'allrice-p15-storage-'));
  }, 60000);
  afterAll(async () => {
    for (const id of attempts) {
      await backend.stop(id);
      await backend.cleanup(id);
    }
    await db?.end();
    if (admin) {
      if (!/^p15_cloud_[a-f0-9]{32}$/.test(schema))
        throw Error('bad test schema');
      await admin.unsafe(`drop schema ${schema} cascade`);
      await admin.end();
    }
    if (storageRoot && storageRoot.includes('/allrice-p15-storage-'))
      await rm(storageRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  it('has no Bridge dependency; exact cloud proposal is immutable and always asks', async () => {
    const f = await fixture(),
      c = await f.create();
    expect(c.snapshot.status).toBe('waiting_user');
    expect(c.snapshot.binding.execution.deviceId).toBeNull();
    expect(c.snapshot.binding.dataScope[0]?.destination).toBe(
      'cloud_execution',
    );
    const views = await listCloudRuntimeOperations(f.context, f.run, db);
    expect(views[0]?.proposal).toEqual({
      kind: 'cloud',
      script: c.payload.arguments.script,
      inputs: c.payload.arguments.inputs,
      outputs: c.payload.arguments.outputs,
      limits: c.payload.arguments.limits,
    });
    vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '0');
    try {
      expect(
        (await listCloudRuntimeOperations(f.context, f.run, db))[0]?.enabled,
      ).toBe(false);
    } finally {
      vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '1');
    }
    expect((await f.create()).snapshot.binding).toEqual(c.snapshot.binding);
    await expect(
      f.create('p15-task', { ...f.args, script: 'console.log(1)' }),
    ).rejects.toThrow('idempotency_conflict');
    await expect(
      db`update allrice_cloud_execution_inputs set payload='{}' where operation_id=${c.snapshot.binding.attempt.operationId}`,
    ).rejects.toThrow('cloud execution inputs are immutable');
    await expect(
      c.ledger.dispatch({
        scope: c.snapshot.binding.task.scope,
        operationId: c.snapshot.binding.attempt.operationId,
        leaseOwner: f.worker,
        leaseMs: 15000,
      }),
    ).rejects.toThrow('approval_invalid_or_stale');
  });
  it('admits an authorized ordinary input above the removed 2 MB boundary', async () => {
    const f = await fixture(),
      object = await f.upload(Buffer.alloc(2_000_001, 120), 'text/plain');
    const created = await f.create('ordinary-large', {
      ...f.args,
      inputs: [
        { path: 'large.txt', objectId: object.id, checksum: object.checksum },
      ],
    });
    expect(created.snapshot.binding.attempt.operationId).toBeTruthy();
  });
  it('freezes deployment limits through the real Broker for CSV summary, approval and Worker receipt', async () => {
    const f = await fixture();
    const csv = await f.upload(Buffer.from('金额\n12\n8\n5\n'), 'text/csv');
    const args = {
      script: '/* model fixture: summarize selected CSV */',
      inputs: [{ path: 'data.csv', objectId: csv.id, checksum: csv.checksum }],
      outputs: [{ path: 'summary.csv', fileName: '汇总.csv', format: 'csv' }],
    };
    const raw = structuredClone(args);
    const timeout = process.env.ALLRICE_CLOUD_COMMAND_TIMEOUT_MS;
    const output = process.env.ALLRICE_CLOUD_COMMAND_OUTPUT_BYTES;
    vi.stubEnv('ALLRICE_CLOUD_COMMAND_TIMEOUT_MS', '1500');
    vi.stubEnv('ALLRICE_CLOUD_COMMAND_OUTPUT_BYTES', '2048');
    const execute = vi
      .spyOn(CloudRunnerBackend.prototype, 'execute')
      .mockResolvedValue({
        containerId: '1'.repeat(64),
        exitCode: 0,
        stopped: true,
        reason: 'completed',
        output: '共3条，合计25',
        elapsedMs: 1,
        artifacts: [
          {
            path: 'summary.csv',
            contentBase64: Buffer.from('合计\n25\n').toString('base64'),
          },
        ],
      });
    const inspect = vi
      .spyOn(CloudRunnerBackend.prototype, 'inspect')
      .mockResolvedValue(null);
    const cleanup = vi
      .spyOn(CloudRunnerBackend.prototype, 'cleanup')
      .mockResolvedValue(undefined);
    const controller = new AbortController();
    const pending = executeRiceTool({
      context: f.execution,
      capabilities: ['storage:read', 'storage:write'],
      storageRoot,
      sessionId: f.session,
      signal: controller.signal,
      userRequest: '把这份CSV汇总，打印几条中文结果并保存汇总文件',
      call: { id: 'summary', name: 'cloud.process.execute', arguments: args },
    });
    // Attach rejection immediately; the real executor waits for exact approval.
    const settled = pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await vi.waitFor(
        async () => {
          const rows =
            await db`select operation_id from allrice_cloud_execution_inputs
          where operation_id=${cloudStableId(`cloud-command:${f.run}:summary`)}`;
          expect(rows).toHaveLength(1);
        },
        { timeout: 5000 },
      );
      const created = await f.create('summary', args);
      expect(created.payload.arguments.limits).toMatchObject({
        timeoutMs: 1500,
        outputBytes: 2048,
      });
      const binding = structuredClone(created.snapshot.binding);
      vi.stubEnv('ALLRICE_CLOUD_COMMAND_TIMEOUT_MS', '2000');
      vi.stubEnv('ALLRICE_CLOUD_COMMAND_OUTPUT_BYTES', '4096');
      const resolved = await resolveCloudToolArguments(
        { context: f.execution, arguments: args },
        db,
      );
      expect((await f.create('summary', resolved)).snapshot.binding).toEqual(
        binding,
      );
      await expect(
        f.create('summary', { ...args, limits: { timeoutMs: 2000 } }),
      ).rejects.toThrow('idempotency_conflict');
      const next = await f.create(
        'next',
        await resolveCloudToolArguments(
          {
            context: f.execution,
            arguments: { ...args, limits: { outputBytes: 1024 } },
          },
          db,
        ),
      );
      expect(next.payload.arguments.limits).toMatchObject({
        timeoutMs: 2000,
        outputBytes: 1024,
      });
      await f.approve(created);
      const result = await settled;
      if ('error' in result) throw result.error;
      const value = JSON.parse(result.value.modelContent);
      expect(value.status).toBe('succeeded');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]![0].arguments.limits).toMatchObject({
        timeoutMs: 1500,
        outputBytes: 2048,
      });
      expect(args).toEqual(raw);
      const [stored] =
        await db`select binding,payload from allrice_cloud_execution_inputs where operation_id=${binding.attempt.operationId}`;
      expect(stored!.binding).toEqual(binding);
      const [receipt] =
        await db`select payload->'evidence' as evidence from allrice_runtime_operation_receipts
        where receipt_id=${cloudStableId(`${binding.attempt.operationId}:result`)}`;
      expect(receipt!.evidence).toMatchObject({
        reason: 'completed',
        stopped: true,
      });
      const { object } = await getToolBrokerFile(
        f.execution,
        value.artifacts[0].objectId,
      );
      expect(await new Response(await f.storage.get(object)).text()).toBe(
        '合计\n25\n',
      );
    } finally {
      controller.abort();
      await settled;
      execute.mockRestore();
      inspect.mockRestore();
      cleanup.mockRestore();
      vi.stubEnv('ALLRICE_CLOUD_COMMAND_TIMEOUT_MS', timeout);
      vi.stubEnv('ALLRICE_CLOUD_COMMAND_OUTPUT_BYTES', output);
    }
  });
  it('preserves both exact runtime endpoints through Broker normalization and rejects outside them before freezing', async () => {
    const f = await fixture();
    for (const [index, limits] of [
      { timeoutMs: 500, outputBytes: 1024 },
      { timeoutMs: 60000, outputBytes: 65536 },
    ].entries()) {
      const args = await resolveCloudToolArguments(
        {
          context: f.execution,
          arguments: { ...f.args, limits },
        },
        db,
      );
      const created = await f.create(`endpoint-${index}`, args);
      const [stored] =
        await db`select payload from allrice_cloud_execution_inputs
        where operation_id=${created.snapshot.binding.attempt.operationId}`;
      expect(stored!.payload.arguments.limits).toMatchObject(limits);
    }
    for (const limits of [
      { timeoutMs: 499 },
      { timeoutMs: 60001 },
      { outputBytes: 1023 },
      { outputBytes: 65537 },
    ])
      await expect(
        resolveCloudToolArguments(
          {
            context: f.execution,
            arguments: { ...f.args, limits },
          },
          db,
        ),
      ).rejects.toThrow();
    const [count] =
      await db`select count(*)::int as n from allrice_cloud_execution_inputs where run_id=${f.run}`;
    expect(count!.n).toBe(2);
  });
  it('refuses cross-tenant file IDs, changed input checksums and revoked grants', async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(
      f.create('bad', {
        ...f.args,
        inputs: [{ ...f.args.inputs[0], objectId: other.object.id }],
      }),
    ).rejects.toThrow();
    const c = await f.create();
    await f.approve(c);
    await db`update allrice_storage_objects set checksum=${`sha256:${'c'.repeat(64)}`} where id=${f.object.id}`;
    await expect(
      c.ledger.dispatch({
        scope: c.snapshot.binding.task.scope,
        operationId: c.snapshot.binding.attempt.operationId,
        leaseOwner: f.worker,
        leaseMs: 15000,
      }),
    ).rejects.toThrow('cloud_input_not_authorized');
    await db`update allrice_storage_objects set checksum=${f.object.checksum} where id=${f.object.id}`;
    await db`update allrice_cloud_execution_grants set revoked_at=clock_timestamp() where id=${f.grant.id}`;
    await expect(
      c.ledger.dispatch({
        scope: c.snapshot.binding.task.scope,
        operationId: c.snapshot.binding.attempt.operationId,
        leaseOwner: f.worker,
        leaseMs: 15000,
      }),
    ).rejects.toThrow('cloud_grant_unavailable');
  });
  it('denies plan-only, removed frozen tool and revoked exact approval', async () => {
    const f = await fixture(),
      c = await f.create(),
      req = await f.approve(c);
    await revokeRuntimeActionApproval(f.context, req.approvalId, db);
    await expect(
      c.ledger.dispatch({
        scope: c.snapshot.binding.task.scope,
        operationId: c.snapshot.binding.attempt.operationId,
        leaseOwner: f.worker,
        leaseMs: 15000,
      }),
    ).rejects.toThrow();
    const missing = await fixture({ frozenTool: false });
    await expect(missing.create()).rejects.toThrow(
      'cloud_frozen_tool_not_allowed',
    );
    const plan = await fixture({ planOnly: true });
    await expect(plan.create()).rejects.toThrow();
  });
  it('shares root budget across all operations rather than resetting per invocation', async () => {
    const f = await fixture();
    await f.create('first');
    await db`update allrice_runtime_budgets set capacity=1 where root_run_id=${f.run}`;
    await expect(f.create('second')).resolves.toBeDefined();
  });
  it('fences stale execution when the same Worker acquires a new job lease', async () => {
    const f = await fixture(),
      c = await f.create();
    await f.approve(c);
    await db`update allrice_jobs set lease_token=${randomUUID()} where run_id=${f.run}`;
    await expect(
      c.ledger.dispatch({
        scope: c.snapshot.binding.task.scope,
        operationId: c.snapshot.binding.attempt.operationId,
        leaseOwner: f.worker,
        leaseMs: 15000,
      }),
    ).rejects.toThrow('cloud_worker_lease_changed');
    await expect(f.create()).rejects.toThrow('idempotency_conflict');
  });
  it('cold recovery fences the originating job lease without canceling the replacement job or replaying', async () => {
    const f = await fixture(),
      c = await f.create();
    await f.approve(c);
    const lease = await c.ledger.dispatch({
      scope: c.snapshot.binding.task.scope,
      operationId: c.snapshot.binding.attempt.operationId,
      leaseOwner: f.worker,
      leaseMs: 15000,
    });
    await c.ledger.startOperation({
      scope: c.snapshot.binding.task.scope,
      operationId: c.snapshot.binding.attempt.operationId,
      leaseToken: lease.leaseToken,
      attempt: c.snapshot.binding.attempt,
      receiptId: cloudStableId(
        `${c.snapshot.binding.attempt.operationId}:start`,
      ),
    });
    const replacement = randomUUID();
    await db`update allrice_jobs set lease_token=${replacement} where run_id=${f.run}`;
    expect(
      await recoverCloudCommandOperations({
        backend: new NoContainersBackend(),
        database: db,
      }),
    ).toEqual({ recovered: 0, failed: 0 });
    expect(
      (
        await c.ledger.readOperation(
          c.snapshot.binding.task.scope,
          c.snapshot.binding.attempt.operationId,
        )
      ).status,
    ).toBe('unknown');
    const [attempt] =
      await db`select cleanup_confirmed_at,outcome from allrice_cloud_execution_attempts where operation_id=${c.snapshot.binding.attempt.operationId}`;
    expect(attempt).toMatchObject({
      cleanup_confirmed_at: null,
      outcome: null,
    });
    const [receipt] =
      await db`select payload->'evidence' as evidence from allrice_runtime_operation_receipts where operation_id=${c.snapshot.binding.attempt.operationId} order by received_at desc limit 1`;
    expect(receipt!.evidence).toMatchObject({ physicallyStopped: false });
    const [job] =
      await db`select lease_token::text,cancel_requested_at from allrice_jobs where run_id=${f.run}`;
    expect(job).toMatchObject({
      lease_token: replacement,
      cancel_requested_at: null,
    });
    const [root] =
      await db`select cancel_request_id from allrice_runtime_roots where root_run_id=${f.run}`;
    expect(root!.cancel_request_id).toBeNull();
    expect(
      (await c.ledger.readBudget(c.snapshot.binding.task.scope, f.run))
        .budgets[0]!.reserved,
    ).toBe(1);
  });
  it('admits concurrent identities and leaves shared physical capacity to the executor', async () => {
    const f = await fixture();
    await f.create('seed');
    await db`update allrice_runtime_budgets set capacity=2 where root_run_id=${f.run}`;
    const raced = await Promise.allSettled([
      f.create('racer-a'),
      f.create('racer-b'),
    ]);
    expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(raced.filter((r) => r.status === 'rejected')).toHaveLength(0);
    const g = await fixture();
    const operations = await Promise.all([
      g.create('one'),
      g.create('two'),
      g.create('three'),
    ]);
    for (const c of operations) await g.approve(c);
    const dispatched = await Promise.allSettled(
      operations.map((c) =>
        c.ledger.dispatch({
          scope: c.snapshot.binding.task.scope,
          operationId: c.snapshot.binding.attempt.operationId,
          leaseOwner: g.worker,
          leaseMs: 15000,
        }),
      ),
    );
    expect(dispatched.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(dispatched.filter((r) => r.status === 'rejected')).toHaveLength(0);
    // No script started; cancel the synthetic admissions for later suite cases.
    await operations[0]!.ledger.cancelRoot(
      operations[0]!.snapshot.binding.task.scope,
      g.run,
      randomUUID(),
    );
    // This DB-only case dispatched admissions but never created a container.
    // Do not require a live VM when ALLRICE_RUN_CLOUD_INTEGRATION is off.
    await recoverCloudCommandOperations({
      backend: new NoContainersBackend(),
      database: db,
    });
  });
  it.skipIf(process.env.ALLRICE_RUN_CLOUD_INTEGRATION !== '1')(
    'actually computes, persists immutable tool-result artifact, destroys sandbox, reopens bytes; replay never computes twice',
    { tags: ['manual:ALLRICE_RUN_CLOUD_INTEGRATION'], timeout: 30000 },
    async () => {
      const f = await fixture(),
        c = await f.create();
      attempts.push(c.snapshot.binding.attempt.attemptId);
      await f.approve(c);
      const result = await runCloudCommandOperation(c, {
        storage: f.storage,
        backend,
        database: db,
      });
      expect(result.status).toBe('succeeded');
      expect(result.artifacts).toHaveLength(1);
      expect(
        await backend.inspect(c.snapshot.binding.attempt.attemptId),
      ).toBeNull();
      const [a] = await db<
        {
          provenance: { kind: string; operationId: string };
          object_id: string;
        }[]
      >`select w.provenance,v.object_id from allrice_workbench_artifacts w join allrice_deliverable_versions v on v.id=w.version_id where w.run_id=${f.run}`;
      expect(a?.provenance).toEqual({
        kind: 'tool_result',
        runId: f.run,
        operationId: c.snapshot.binding.attempt.operationId,
        stepId: null,
      });
      const [journal] = await db<
        { artifacts: { object: typeof f.object }[] }[]
      >`select artifacts from allrice_cloud_execution_attempts where operation_id=${c.snapshot.binding.attempt.operationId}`;
      expect(
        await new Response(
          await f.storage.get(journal!.artifacts[0]!.object),
        ).json(),
      ).toEqual({ sum: 25 });
      const retry = await runCloudCommandOperation(c, {
        storage: f.storage,
        backend,
        database: db,
      });
      expect(retry.status).toBe('succeeded');
      expect(retry.artifacts).toEqual(result.artifacts);
      expect(
        (
          await db`select id from allrice_deliverable_versions where session_id=${c.snapshot.binding.task.chatSessionId}`
        ).length,
      ).toBe(1);
      const [usage] =
        await db`select reserved,spent from allrice_runtime_budgets where root_run_id=${f.run} and metric='tool_calls'`;
      expect(Number(usage!.reserved)).toBe(0);
      expect(Number(usage!.spent)).toBe(1);
    },
  );
  it.skipIf(process.env.ALLRICE_RUN_CLOUD_INTEGRATION !== '1')(
    'does not publish after authority revoked; cold recovery preserves journal and destroys stopped sandbox',
    { tags: ['manual:ALLRICE_RUN_CLOUD_INTEGRATION'], timeout: 30000 },
    async () => {
      const f = await fixture(),
        c = await f.create();
      await f.approve(c);
      attempts.push(c.snapshot.binding.attempt.attemptId);
      class RevokedAfterCompute extends CloudRunnerBackend {
        override async execute(
          ...args: Parameters<CloudRunnerBackend['execute']>
        ) {
          const result = await super.execute(...args);
          await db`update allrice_cloud_execution_grants set revoked_at=clock_timestamp() where id=${f.grant.id}`;
          return result;
        }
      }
      await expect(
        runCloudCommandOperation(c, {
          storage: f.storage,
          backend: new RevokedAfterCompute(),
          database: db,
        }),
      ).rejects.toThrow('cloud_grant_unavailable');
      expect(
        (
          await db`select version_id from allrice_workbench_artifacts where run_id=${f.run}`
        ).length,
      ).toBe(0);
      await db`update allrice_jobs set cancel_requested_at=clock_timestamp() where run_id=${f.run}`;
      expect(
        (await recoverCloudCommandOperations({ backend, database: db }))
          .recovered,
      ).toBeGreaterThanOrEqual(1);
      expect(
        await backend.inspect(c.snapshot.binding.attempt.attemptId),
      ).toBeNull();
      expect(
        (
          await c.ledger.readOperation(
            c.snapshot.binding.task.scope,
            c.snapshot.binding.attempt.operationId,
          )
        ).status,
      ).toBe('unknown');
      const [journal] =
        await db`select outcome,cleanup_confirmed_at from allrice_cloud_execution_attempts where operation_id=${c.snapshot.binding.attempt.operationId}`;
      expect(journal!.outcome.artifacts).toHaveLength(1);
      expect(journal!.cleanup_confirmed_at).not.toBeNull();
    },
  );
  it.skipIf(process.env.ALLRICE_RUN_CLOUD_INTEGRATION !== '1')(
    'retains stopped result through storage failure; recovery publishes without rerunning',
    { tags: ['manual:ALLRICE_RUN_CLOUD_INTEGRATION'], timeout: 30000 },
    async () => {
      const f = await fixture(),
        c = await f.create();
      attempts.push(c.snapshot.binding.attempt.attemptId);
      await f.approve(c);
      const failStorage = {
        get: f.storage.get.bind(f.storage),
        exists: f.storage.exists.bind(f.storage),
        delete: f.storage.delete.bind(f.storage),
        put: async () => {
          throw Error('synthetic storage outage');
        },
      };
      await expect(
        runCloudCommandOperation(c, {
          storage: failStorage,
          backend,
          database: db,
        }),
      ).rejects.toThrow('synthetic storage outage');
      expect(
        (await backend.inspect(c.snapshot.binding.attempt.attemptId))?.State
          .Running,
      ).toBe(false);
      const recovered = await runCloudCommandOperation(c, {
        storage: f.storage,
        backend,
        database: db,
      });
      expect(recovered.status).toBe('succeeded');
      expect(
        await backend.inspect(c.snapshot.binding.attempt.attemptId),
      ).toBeNull();
    },
  );
  it.skipIf(process.env.ALLRICE_RUN_CLOUD_INTEGRATION !== '1')(
    'never reexecutes after started admission without container evidence',
    { tags: ['manual:ALLRICE_RUN_CLOUD_INTEGRATION'], timeout: 30000 },
    async () => {
      const f = await fixture(),
        c = await f.create();
      await f.approve(c);
      const b = c.snapshot.binding,
        scope = b.task.scope,
        id = b.attempt.operationId;
      const lease = await c.ledger.dispatch({
        scope,
        operationId: id,
        leaseOwner: f.worker,
        leaseMs: 15000,
      });
      expect(
        (
          await db`select operation_id from allrice_cloud_execution_attempts where operation_id=${id}`
        ).length,
      ).toBe(1);
      await c.ledger.startOperation({
        scope,
        operationId: id,
        leaseToken: lease.leaseToken,
        attempt: b.attempt,
        receiptId: cloudStableId(`${id}:start`),
      });
      const recovered = await runCloudCommandOperation(c, {
        storage: f.storage,
        backend,
        database: db,
      });
      expect(recovered.status).toBe('unknown');
      expect(await backend.inspect(b.attempt.attemptId)).toBeNull();
    },
  );
});
