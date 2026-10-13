import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CloudRunnerBackend } from '../../../apps/worker/src/cloud-runner/backend.js';
import { runCloudCommandOperation } from '../../../apps/worker/src/cloud-runner/executor.js';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import { cancelCloudRuntimeRun } from './cloud-operation-view.ts';
import { cloudStableId } from './cloud-execution.ts';
import type * as Client from './core/client.ts';

let db: ReturnType<typeof postgres>, admin: ReturnType<typeof postgres>;
let storageRoot: string;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => db,
}));
const schema = `cloud_interrupt_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const fixture = async () => {
  const f = await createCloudExecutionFixture(db, storageRoot, {
    memberRole: 'member',
  });
  await db`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy,phase,started_at)
    values(${f.run},${f.org},${f.workspace},${db.json({ version: 1, timeoutMs: 300000, sources: [] })},'active',clock_timestamp())`;
  const created = await f.create('interruption', {
    script: "console.log('isolated interruption fixture')",
    inputs: [],
    outputs: [],
  });
  await f.approve(created);
  return { ...f, created };
};

/** Only the backend is controlled. Dispatch, receipts, cancellation and usage
 * use the real database/ledger. No model, VM or container is started. */
class InterruptedBackend extends CloudRunnerBackend {
  executions = 0;
  cleanups = 0;
  private enteredResolve!: () => void;
  readonly entered = new Promise<void>((resolve) => {
    this.enteredResolve = resolve;
  });
  constructor(private phase: 'running' | 'waiting' = 'running') {
    super();
  }
  override async execute(...args: Parameters<CloudRunnerBackend['execute']>) {
    const [command, , options] = args;
    this.executions++;
    const containerId = createHash('sha256')
      .update(options.attemptId)
      .digest('hex');
    if (this.phase === 'running') await options.onCreated?.(containerId);
    this.enteredResolve();
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) resolve();
      else
        options.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
    });
    if (this.phase === 'waiting') throw Error('CLOUD_EXECUTION_REVOKED');
    return {
      containerId,
      exitCode: null,
      stopped: true,
      reason: 'canceled' as const,
      output: '',
      artifacts: [],
      elapsedMs: 10,
      imageDigest: command.imageDigest,
    };
  }
  override async inspect() {
    return null;
  }
  override async cleanup() {
    this.cleanups++;
  }
}

suite('finite cloud interruption reconciliation', () => {
  beforeAll(async () => {
    if (!process.env.ALLRICE_TEST_DATABASE_URL)
      throw Error('dedicated DB required');
    vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '1');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
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
    db = postgres(url.toString(), { max: 8, onnotice: () => {} });
    const migrations = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(migrations))
      .filter((f) => f.endsWith('.sql'))
      .sort())
      await db.unsafe(await readFile(new URL(file, migrations), 'utf8'));
    storageRoot = await mkdtemp(join(tmpdir(), 'allrice-cloud-interruption-'));
  }, 60000);
  afterAll(async () => {
    await db?.end();
    if (admin) {
      if (!/^cloud_interrupt_[a-f0-9]{32}$/.test(schema))
        throw Error('invalid test schema');
      await admin.unsafe(`drop schema ${schema} cascade`);
      await admin.end();
    }
    if (storageRoot?.includes('/allrice-cloud-interruption-'))
      await rm(storageRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  for (const formal of [false, true])
    it(`settles a confirmed stop once after ${formal ? 'formal cancellation' : 'signal-only interruption'}`, async () => {
      const f = await fixture(),
        c = f.created,
        backend = new InterruptedBackend(),
        controller = new AbortController();
      const task = runCloudCommandOperation(c, {
        database: db,
        storage: f.storage,
        backend,
        signal: controller.signal,
      });
      void task.catch(() => {});
      await backend.entered;
      if (formal) await cancelCloudRuntimeRun(f.context, f.run, db);
      const [before] =
        await db`select cancel_request_id from allrice_runtime_roots where root_run_id=${f.run}`;
      controller.abort(Error('worker interrupted'));
      const result = await task;
      expect(result.status).toBe('canceled');
      expect(result).toMatchObject({ cleanupConfirmed: true });
      expect(result.artifacts).toEqual([]);
      const scope = c.snapshot.binding.task.scope,
        id = c.snapshot.binding.attempt.operationId;
      const [root] =
        await db`select cancel_request_id from allrice_runtime_roots where root_run_id=${f.run}`;
      expect(root!.cancel_request_id).toBe(before!.cancel_request_id);
      const events = await c.ledger.readEvents(scope, id);
      expect(
        events.filter((e) => e.signal.type === 'operation.cancel_requested'),
      ).toHaveLength(1);
      expect(
        events.filter((e) => e.signal.type === 'operation.stopped'),
      ).toHaveLength(1);
      expect(
        (await c.ledger.readReceipts(scope, id)).every(
          (r) => r.disposition === 'applied',
        ),
      ).toBe(true);
      const [usage] =
        await db`select observation from allrice_runtime_reservations where operation_id=${id} and metric='tool_calls'`;
      expect(usage!.observation.amount).toBe(1);
      expect(
        (
          await runCloudCommandOperation(c, {
            database: db,
            storage: f.storage,
            backend,
          })
        ).status,
      ).toBe('canceled');
      expect(backend.executions).toBe(1);
      expect(
        (await c.ledger.readEvents(scope, id)).filter(
          (e) => e.signal.type === 'operation.stopped',
        ),
      ).toHaveLength(1);
      expect(
        (
          await db`select observation from allrice_runtime_reservations where operation_id=${id} and metric='tool_calls'`
        )[0]!.observation,
      ).toEqual(usage!.observation);
    });

  it('does not cancel a replacement job when the old attempt reports its actual stop', async () => {
    const f = await fixture(),
      c = f.created,
      backend = new InterruptedBackend(),
      controller = new AbortController();
    const task = runCloudCommandOperation(c, {
      database: db,
      storage: f.storage,
      backend,
      signal: controller.signal,
    });
    void task.catch(() => {});
    await backend.entered;
    const replacement = randomUUID();
    await db`update allrice_jobs set lease_token=${replacement},attempt=attempt+1 where id=${c.context.jobId}`;
    controller.abort(Error('old worker lease lost'));
    expect((await task).status).toBe('canceled');
    const [root] =
      await db`select cancel_request_id from allrice_runtime_roots where root_run_id=${f.run}`;
    const [job] =
      await db`select lease_token::text,cancel_requested_at,status from allrice_jobs where id=${c.context.jobId}`;
    expect(root!.cancel_request_id).toBeNull();
    expect(job).toMatchObject({
      lease_token: replacement,
      cancel_requested_at: null,
      status: 'running',
    });
  });

  it('accepts an actual stop after authority is revoked without renewing execution', async () => {
    const f = await fixture(),
      c = f.created,
      backend = new InterruptedBackend(),
      controller = new AbortController();
    const task = runCloudCommandOperation(c, {
      database: db,
      storage: f.storage,
      backend,
      signal: controller.signal,
    });
    void task.catch(() => {});
    await backend.entered;
    await db`update allrice_cloud_execution_grants set revoked_at=clock_timestamp() where id=${f.grant.id}`;
    controller.abort(Error('worker interrupted'));
    expect((await task).status).toBe('canceled');
    expect(
      (
        await db`select cancel_request_id from allrice_runtime_roots where root_run_id=${f.run}`
      )[0]!.cancel_request_id,
    ).toBeNull();
    expect(backend.executions).toBe(1);
  });

  for (const invalid of [
    'missing_journal',
    'missing_container',
    'wrong_container',
    'not_stopped',
    'string_stopped',
    'not_canceled',
    'wrong_journal_lease',
    'partial_effects',
    'wrong_operation_lease',
    'wrong_attempt',
  ])
    it(`refuses a stop without matching durable facts: ${invalid}`, async () => {
      const f = await fixture(),
        c = f.created,
        backend = new InterruptedBackend(),
        controller = new AbortController();
      const original = c.ledger.recordReceipt.bind(c.ledger),
        id = c.snapshot.binding.attempt.operationId;
      c.ledger.recordReceipt = async (input) => {
        if (input.signal.type === 'operation.stopped') {
          if (invalid === 'missing_journal')
            await db`delete from allrice_cloud_execution_attempts where operation_id=${id}`;
          else if (invalid === 'missing_container')
            await db`update allrice_cloud_execution_attempts set container_id=null where operation_id=${id}`;
          else if (invalid === 'wrong_container')
            await db`update allrice_cloud_execution_attempts set container_id=${'f'.repeat(64)} where operation_id=${id}`;
          else if (invalid === 'wrong_journal_lease')
            await db`update allrice_cloud_execution_attempts set lease_token=${randomUUID()} where operation_id=${id}`;
          else if (invalid === 'partial_effects')
            input = {
              ...input,
              signal: { ...input.signal, effects: 'partial' },
            };
          else if (invalid === 'wrong_operation_lease')
            input = { ...input, leaseToken: randomUUID() };
          else if (invalid === 'wrong_attempt')
            input = {
              ...input,
              attempt: {
                ...input.attempt,
                generation: input.attempt.generation + 1,
                fence: input.attempt.fence + 1,
              },
            };
          else {
            const [journal] =
              await db`select outcome from allrice_cloud_execution_attempts where operation_id=${id}`;
            const outcome = {
              ...journal!.outcome,
              ...(invalid === 'not_canceled'
                ? { reason: 'unknown' }
                : { stopped: invalid === 'string_stopped' ? 'true' : false }),
            };
            await db`update allrice_cloud_execution_attempts set outcome=${db.json(outcome)} where operation_id=${id}`;
          }
        }
        return original(input);
      };
      const task = runCloudCommandOperation(c, {
        database: db,
        storage: f.storage,
        backend,
        signal: controller.signal,
      });
      void task.catch(() => {});
      await backend.entered;
      controller.abort(Error('worker interrupted'));
      await expect(task).rejects.toThrow(
        invalid === 'wrong_operation_lease' ? 'lease_lost' : 'invalid_state',
      );
      expect(
        (await c.ledger.readOperation(c.snapshot.binding.task.scope, id))
          .status,
      ).toBe('running');
      expect(
        (await c.ledger.readEvents(c.snapshot.binding.task.scope, id)).some(
          (e) => e.signal.type === 'operation.cancel_requested',
        ),
      ).toBe(false);
      expect(
        (
          await db`select cancel_request_id from allrice_runtime_roots where root_run_id=${f.run}`
        )[0]!.cancel_request_id,
      ).toBeNull();
    });

  for (const formal of [false, true])
    it(`retains unknown create outcome after ${formal ? 'formal waiting cancel' : 'waiting interruption'}`, async () => {
      const f = await fixture(),
        c = f.created,
        backend = new InterruptedBackend('waiting'),
        controller = new AbortController();
      const task = runCloudCommandOperation(c, {
        database: db,
        storage: f.storage,
        backend,
        signal: controller.signal,
      });
      void task.catch(() => {});
      await backend.entered;
      if (formal) await cancelCloudRuntimeRun(f.context, f.run, db);
      controller.abort(Error('waiting interrupted'));
      expect((await task).status).toBe('unknown');
      expect(
        (
          await runCloudCommandOperation(c, {
            database: db,
            storage: f.storage,
            backend,
          })
        ).status,
      ).toBe('unknown');
      expect(backend.executions).toBe(1);
      const id = c.snapshot.binding.attempt.operationId;
      expect(
        (
          await db`select outcome,cleanup_confirmed_at from allrice_cloud_execution_attempts where operation_id=${id}`
        )[0],
      ).toEqual({ outcome: null, cleanup_confirmed_at: null });
      expect(
        (await c.ledger.readEvents(c.snapshot.binding.task.scope, id)).some(
          (e) => e.signal.type === 'operation.stopped',
        ),
      ).toBe(false);
    });

  it('accepts the same durable stopped journal after a crash before the receipt', async () => {
    const f = await fixture(),
      c = f.created,
      backend = new InterruptedBackend(),
      controller = new AbortController();
    const original = c.ledger.recordReceipt.bind(c.ledger);
    c.ledger.recordReceipt = async (input) => {
      if (input.signal.type === 'operation.stopped')
        throw Error('fixture receipt outage');
      return original(input);
    };
    const task = runCloudCommandOperation(c, {
      database: db,
      storage: f.storage,
      backend,
      signal: controller.signal,
    });
    void task.catch(() => {});
    await backend.entered;
    controller.abort(Error('worker interrupted'));
    await expect(task).rejects.toThrow('fixture receipt outage');
    const id = c.snapshot.binding.attempt.operationId;
    expect(
      (
        await db`select outcome from allrice_cloud_execution_attempts where operation_id=${id}`
      )[0]!.outcome.reason,
    ).toBe('canceled');
    c.ledger.recordReceipt = original;
    expect(
      (
        await runCloudCommandOperation(c, {
          database: db,
          storage: f.storage,
          backend,
        })
      ).status,
    ).toBe('canceled');
    expect(backend.executions).toBe(1);
    expect(
      (await c.ledger.readReceipts(c.snapshot.binding.task.scope, id)).filter(
        (r) => r.receipt_id === cloudStableId(`${id}:result`),
      ),
    ).toHaveLength(1);
  });
});
