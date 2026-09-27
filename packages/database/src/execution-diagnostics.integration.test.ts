import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi } from 'vitest';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { executionResourceObserver } from './execution-diagnostics.ts';
import { createTaskProgressRuntime } from './task-progress.ts';
import { readTaskClock } from './task-clock.ts';
import * as client from './core/client.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
suite('MET162 durable resource waiting', () => {
  it('advances twenty independent tenants and skips canceled/expired queue heads', async () => {
    const f = await createAssistantFixtureDatabase();
    const storage = await mkdtemp(join(tmpdir(), 'allrice-met162-'));
    const spy = vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
    vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '1');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    try {
      const tenants = [];
      for (let n = 0; n < 20; n++)
        tenants.push(await createCloudExecutionFixture(f.db, storage));
      expect(new Set(tenants.map((t) => t.org)).size).toBe(20);
      const observers = [];
      for (const t of tenants) {
        const [j] =
          await f.db`select lease_token from allrice_jobs where run_id=${t.run}`;
        const o = executionResourceObserver(
          {
            context: t.execution,
            leaseToken: j!.lease_token,
            attemptId: randomUUID(),
            callId: randomUUID(),
          },
          f.db,
        );
        observers.push(o);
        await o.observe({ stage: 'queued', reason: 'sandbox_capacity' });
      }
      await f.db`update allrice_jobs set cancel_requested_at=clock_timestamp() where run_id=${tenants[0]!.run}`;
      await f.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where run_id=${tenants[1]!.run}`;
      expect(await observers[0]!.isTurn()).toBe(false);
      expect(await observers[1]!.isTurn()).toBe(false);
      await f.db`update allrice_jobs set status='canceled',lease_token=null,worker_id=null,claimed_at=null,heartbeat_at=null,lease_expires_at=null,completed_at=clock_timestamp() where run_id=${tenants[0]!.run}`;
      await observers[0]!.observe({ stage: 'canceled' });
      expect(
        await f.db`select state from allrice_task_resource_waits where run_id=${tenants[0]!.run}`,
      ).toEqual([{ state: 'canceled' }]);
      await expect(
        observers[0]!.observe({ stage: 'acquired' }),
      ).rejects.toThrow('execution_observer_lease_lost');
      for (const o of observers.slice(2)) {
        expect(await o.isTurn()).toBe(true);
        await o.observe({
          stage: 'acquired',
          capacity: 2,
          backendId: 'synthetic-node',
        });
        await o.observe({ stage: 'completed', elapsedMs: 20 });
      }
      expect(
        await f.db`select id from allrice_task_resource_waits where state='completed'`,
      ).toHaveLength(18);
      expect(
        await f.db`select id from allrice_audit_events where action='execution.diagnostic' and reason='completed'`,
      ).toHaveLength(18);
      const [j] =
        await f.db`select lease_token from allrice_jobs where run_id=${tenants[2]!.run}`;
      const stolen = executionResourceObserver(
        {
          context: {
            ...tenants[2]!.execution,
            organizationId: tenants[3]!.org,
          },
          leaseToken: j!.lease_token,
          attemptId: randomUUID(),
          callId: randomUUID(),
        },
        f.db,
      );
      await expect(stolen.observe({ stage: 'queued' })).rejects.toThrow(
        'execution_observer_lease_lost',
      );
    } finally {
      spy.mockRestore();
      vi.unstubAllEnvs();
      await f.close();
      await rm(storage, { recursive: true, force: true });
    }
  }, 120000);
  it('pauses the authoritative hour only when all work is resource-blocked and resumes on admission', async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
    vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
    const f = await createP27CodexWorkerFixture({ allowCiDatabase: true });
    try {
      const task = await f.prepareOrdinaryTask(
        'Synthetic resource queue clock; no model call.',
      );
      const context = task.execution.context,
        worker = task.workflowLease;
      const port = createTaskProgressRuntime({ context, worker }, f.db);
      const nativeSessionId = randomUUID(),
        callId = randomUUID();
      await port({
        action: 'start',
        kind: 'tool',
        name: 'workspace.export.create',
        nativeSessionId,
        callId,
        argumentsDigest: `sha256:${'a'.repeat(64)}`,
      });
      const observer = executionResourceObserver(
        {
          context,
          leaseToken: worker.leaseToken,
          attemptId: randomUUID(),
          callId,
        },
        f.db,
      );
      await observer.observe({ stage: 'queued', reason: 'sandbox_capacity' });
      const read = () => f.db.begin((tx) => readTaskClock(tx, task.runId));
      expect(await read()).toMatchObject({
        phase: 'waiting',
        timeoutMs: 3600000,
      });
      const model = randomUUID();
      await port({
        action: 'start',
        kind: 'model',
        nativeSessionId,
        callId: model,
      });
      expect(await read()).toMatchObject({ phase: 'active' });
      await port({
        action: 'finish',
        kind: 'model',
        nativeSessionId,
        callId: model,
        resultDigest: `sha256:${'b'.repeat(64)}`,
        outcome: 'success',
      });
      expect(await read()).toMatchObject({ phase: 'waiting' });
      await observer.observe({ stage: 'acquired', capacity: 2 });
      expect(await read()).toMatchObject({ phase: 'active' });
      await observer.observe({ stage: 'completed' });
      expect(
        await f.db`select state,started_at,finished_at from allrice_task_resource_waits where run_id=${task.runId}`,
      ).toEqual([
        expect.objectContaining({
          state: 'completed',
          started_at: expect.any(Date),
          finished_at: expect.any(Date),
        }),
      ]);
    } finally {
      await f.close();
      vi.unstubAllEnvs();
    }
  }, 120000);
});
