/** Real production approval/ledger/heartbeat calls over an isolated schema.
 * Backdating the persisted checkpoint simulates elapsed wall time without a
 * 40-minute sleep; operation states are changed only by production entrypoints. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createAssistantLocalCommandFixture } from './local-command-assistant.fixture.ts';
import * as client from './core/client.ts';
import {
  heartbeatJob,
  maintainQueue,
  appendJobEvent,
  claimNextJob,
  startClaimedJob,
} from './execution/queue.ts';
import {
  refreshTaskClock,
  readTaskClock,
  taskDeadlineOpen,
} from './task-clock.ts';
import {
  resolveTaskRuntimePolicy,
  freezeTaskRuntimePolicy,
} from './task-runtime-policy.ts';
import { createLocalCommandOperation } from './local-command-service.ts';
import {
  getInteractionStatus,
  getSessionRunTimings,
} from './conversation/interaction-status.ts';
import { InteractionStatusSchema } from '@allrice/contracts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'MET-153 durable clock, real PostgreSQL/approval/Worker heartbeat',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      for (const flag of [
        'ALLRICE_ASSISTANTS_ENABLED',
        'ALLRICE_LOCAL_COMMAND_ENABLED',
        'ALLRICE_RUNTIME_POLICY_ENABLED',
        'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
      ])
        vi.stubEnv(flag, '1');
      fixture = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
    });
    async function setup() {
      const f = await createAssistantLocalCommandFixture(
        fixture.db,
        'ask',
        false,
        { skipChild: true },
      );
      await f.db`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy)
      values(${f.rootRunId},${f.org},${f.workspace},${f.db.json({ ...resolveTaskRuntimePolicy([]) })})`;
      await f.db.begin((tx) => refreshTaskClock(tx, f.rootRunId));
      return f;
    }
    it.each([getInteractionStatus, getSessionRunTimings])(
      'projects ordinary Run clocks through authorized %s without changing time or exposing another tenant',
      async (read) => {
        const f = await setup();
        const explicitPolicy = resolveTaskRuntimePolicy([
          { scope: 'user', scopeId: f.user, timeoutMs: 1800000 },
        ]);
        await f.db`update allrice_task_clocks set policy=${f.db.json({ ...explicitPolicy })} where run_id=${f.rootRunId}`;
        const other = await createAssistantLocalCommandFixture(
          fixture.db,
          'ask',
          false,
          { skipChild: true },
        );
        // No child assistant is created; use the same real approval wait as the Worker.
        await createLocalCommandOperation(
          { context: f.context, arguments: f.args, callId: randomUUID() },
          f.db,
        );
        await f.db`update allrice_task_clocks set active_ms=12460,changed_at=clock_timestamp()-interval '40 minutes' where run_id=${f.rootRunId}`;
        const before =
          await f.db`select * from allrice_task_clocks where run_id=${f.rootRunId}`;
        const status = InteractionStatusSchema.parse({
          runtime: null,
          inputs: [],
          ...(await read(f.requestContext, f.session, f.db)),
        });
        expect(status.runTimings).toHaveLength(1);
        expect(status.runTimings![0]).toMatchObject({
          runId: f.rootRunId,
          timing: {
            activeMs: 12460,
            phase: 'waiting',
            timeoutMs: 1800000,
            sources: [{ scope: 'user', timeoutMs: 1800000 }],
            calls: null,
          },
        });
        expect(status.runTimings![0]!.timing.waitingMs).toBeGreaterThanOrEqual(
          2400000,
        );
        expect(status.runTimings![0]!.timing).not.toHaveProperty('deadlineAt');
        expect(
          await f.db`select * from allrice_task_clocks where run_id=${f.rootRunId}`,
        ).toEqual(before);
        await expect(
          read(f.requestContext, other.session, f.db),
        ).rejects.toMatchObject({ code: 'artifact_not_found' });
        await expect(
          read(
            { ...f.requestContext, actor: other.requestContext.actor },
            f.session,
            f.db,
          ),
        ).rejects.toMatchObject({ code: 'artifact_not_found' });
        expect(
          (await read(other.requestContext, other.session, f.db)).runTimings,
        ).toEqual([]);
      },
    );
    it.each(['active', 'waiting'] as const)(
      'preserves %s time across a real expired lease, maintenance and a different Worker claim',
      async (phase) => {
        const f = await setup();
        // Durable action approvals survive a Worker owner change. Native Ask
        // User RPC IDs instead need re-emission by the new live process.
        const operation =
          phase === 'waiting'
            ? await createLocalCommandOperation(
                { context: f.context, arguments: f.args, callId: randomUUID() },
                f.db,
              )
            : null;
        await f.db`update allrice_task_clocks set active_ms=60000,waiting_ms=30000,changed_at=clock_timestamp()-interval '10 seconds' where run_id=${f.rootRunId}`;
        const before = await f.db.begin((tx) => readTaskClock(tx, f.rootRunId));
        await f.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
        await maintainQueue();
        const recovered = await f.db.begin((tx) =>
          readTaskClock(tx, f.rootRunId),
        );
        expect(recovered!.activeMs).toBeGreaterThanOrEqual(before!.activeMs);
        expect(recovered!.waitingMs).toBeGreaterThanOrEqual(before!.waitingMs);
        if (phase === 'waiting') expect(recovered!.activeMs).toBe(60000);
        await expect(
          heartbeatJob(
            f.worker.workerId,
            f.worker.jobId,
            f.worker.leaseToken,
            30000,
          ),
        ).rejects.toMatchObject({ code: 'lease_lost' });
        const replacement = randomUUID();
        const claimed = await claimNextJob(replacement, 30000);
        expect(claimed?.id).toBe(f.worker.jobId);
        await startClaimedJob(replacement, claimed!.id, claimed!.lease!.token);
        await heartbeatJob(
          replacement,
          claimed!.id,
          claimed!.lease!.token,
          30000,
        );
        const resumed = await f.db.begin((tx) =>
          readTaskClock(tx, f.rootRunId),
        );
        expect(resumed!.activeMs).toBeGreaterThanOrEqual(recovered!.activeMs);
        expect(resumed!.waitingMs).toBeGreaterThanOrEqual(recovered!.waitingMs);
        expect(resumed!.phase).toBe(phase);
        if (phase === 'waiting') {
          expect(resumed!.activeMs).toBe(60000);
          const operationId = operation!.snapshot.binding.attempt.operationId;
          await f.approve(await f.approvalFor(operationId));
          await f.freshLedger().dispatch({
            scope: f.task.scope,
            operationId,
            leaseOwner: randomUUID(),
            leaseMs: 15000,
          });
          const finishedWait = await f.db.begin((tx) =>
            readTaskClock(tx, f.rootRunId),
          );
          expect(finishedWait!.phase).toBe('active');
          expect(finishedWait!.waitingMs).toBeGreaterThanOrEqual(
            resumed!.waitingMs,
          );
        }
        // Re-running maintenance does not create another recovery or reset time.
        await maintainQueue();
        const events =
          await f.db`select 1 from allrice_run_events where run_id=${f.rootRunId} and payload->>'kind'='lease.recovered'`;
        expect(events).toHaveLength(1);
      },
    );
    it('does not kill a 40-minute approval wait; resume keeps the accumulated wait and bounded command lease', async () => {
      const f = await setup();
      const c = await createLocalCommandOperation(
        { context: f.context, arguments: f.args, callId: randomUUID() },
        f.db,
      );
      expect(c.snapshot.status).toBe('waiting_user');
      const read = () => f.db.begin((tx) => readTaskClock(tx, f.rootRunId));
      expect((await read())?.phase).toBe('waiting');
      await f.db`update allrice_task_clocks set changed_at=clock_timestamp()-interval '40 minutes',started_at=clock_timestamp()-interval '50 minutes',active_ms=600000 where run_id=${f.rootRunId}`;
      expect(
        await heartbeatJob(
          f.worker.workerId,
          f.worker.jobId,
          f.worker.leaseToken,
          30000,
        ),
      ).toEqual({ active: true, canceled: false });
      const waiting = await read();
      expect(waiting!.activeMs).toBe(600000);
      expect(waiting!.waitingMs).toBeGreaterThanOrEqual(2400000);
      expect(
        await taskDeadlineOpen(f.db, f.rootRunId, new Date(0).toISOString()),
      ).toBe(true);
      const op = c.snapshot.binding.attempt.operationId;
      const approval = await f.approvalFor(op);
      expect(Date.parse(approval.expiresAt) - Date.now()).toBeGreaterThan(
        3500000,
      );
      await f.approve(approval);
      const lease = await f.freshLedger().dispatch({
        scope: f.task.scope,
        operationId: op,
        leaseOwner: randomUUID(),
        leaseMs: 15000,
      });
      const resumed = await read();
      expect(resumed!.phase).toBe('active');
      expect(resumed!.waitingMs).toBeGreaterThanOrEqual(waiting!.waitingMs);
      expect(Date.parse(lease.leaseExpiresAt) - Date.now()).toBeLessThanOrEqual(
        15000,
      );
      // A fresh client/runtime read cannot erase historic waiting after dispatch.
      await f.db.begin((tx) => refreshTaskClock(tx, f.rootRunId));
      expect((await read())!.waitingMs).toBe(resumed!.waitingMs);
    });
    it('heartbeat and maintenance agree on exhausted active time without deadlock', async () => {
      const f = await setup();
      await f.db`update allrice_jobs set available_at=clock_timestamp()-interval '2 hours',created_at=clock_timestamp()-interval '2 hours' where id=${f.worker.jobId}`;
      await f.db`update allrice_task_clocks set changed_at=clock_timestamp()-interval '61 minutes' where run_id=${f.rootRunId}`;
      await f.db`update allrice_jobs set timeout_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
      const outcomes = await Promise.allSettled([
        heartbeatJob(
          f.worker.workerId,
          f.worker.jobId,
          f.worker.leaseToken,
          30000,
        ),
        maintainQueue(),
      ]);
      expect(outcomes.some((r) => r.status === 'fulfilled')).toBe(true);
      for (const result of outcomes)
        if (result.status === 'rejected')
          expect(result.reason).toMatchObject({ code: 'lease_lost' });
      const [run] =
        await f.db`select state,error_code from allrice_runs where id=${f.rootRunId}`;
      expect(run).toMatchObject({ state: 'failed', error_code: 'JOB_TIMEOUT' });
      expect(
        (await f.db.begin((tx) => readTaskClock(tx, f.rootRunId)))!.phase,
      ).toBe('terminal');
    });
    it('does not pause a concurrent read just because the same agent has a blocked proposal', async () => {
      const f = await setup();
      const amounts = {
        model_calls: 0,
        tool_calls: 1,
        input_tokens: 0,
        output_tokens: 0,
      };
      const proposalId = randomUUID(),
        readId = randomUUID();
      const nativeId = randomUUID();
      await f.runtime.reserveUsage({
        ...f.base,
        runId: f.rootRunId,
        callId: proposalId,
        kind: 'tool',
        tool: 'local.process.execute',
        proposal: true,
        amounts,
        nativeCall: {
          id: nativeId,
          argumentsDigest: `sha256:${'a'.repeat(64)}`,
        },
      });
      await createLocalCommandOperation(
        { context: f.context, arguments: f.args, callId: nativeId },
        f.db,
      );
      const read = () => f.db.begin((tx) => readTaskClock(tx, f.rootRunId));
      expect((await read())!.phase).toBe('waiting');
      await f.runtime.reserveUsage({
        ...f.base,
        runId: f.rootRunId,
        callId: readId,
        kind: 'tool',
        tool: 'web.fetch',
        amounts,
        nativeCall: {
          id: randomUUID(),
          argumentsDigest: `sha256:${'b'.repeat(64)}`,
        },
      });
      expect((await read())!.phase).toBe('active');
      await f.runtime.settleUsage({
        ...f.base,
        runId: f.rootRunId,
        callId: readId,
        amounts,
      });
      expect((await read())!.phase).toBe('waiting');
    });
    it('counts a working coordinator, pauses only after native idle, and resumes on model preparation', async () => {
      const f = await createAssistantLocalCommandFixture(fixture.db);
      await f.db`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy)
        values(${f.rootRunId},${f.org},${f.workspace},${f.db.json({ ...resolveTaskRuntimePolicy([]) })})`;
      await f.db.begin((tx) => refreshTaskClock(tx, f.rootRunId));
      const c = await f.create();
      expect(c.snapshot.status).toBe('waiting_user');
      const read = () => f.db.begin((tx) => readTaskClock(tx, f.rootRunId));
      expect((await read())!.phase).toBe('active');
      await f.runtime.markNativeIdle({ ...f.base, runId: f.rootRunId });
      expect((await read())!.phase).toBe('waiting');
      await f.db`update allrice_task_clocks set changed_at=clock_timestamp()-interval '40 minutes' where run_id=${f.rootRunId}`;
      await f.runtime.prepareModelUsage({
        ...f.base,
        runId: f.rootRunId,
        callId: randomUUID(),
        requestedOutputTokens: 100,
      });
      expect((await read())!.phase).toBe('active');
      expect((await read())!.waitingMs).toBeGreaterThanOrEqual(2400000);
      await f.runtime.markNativeIdle({ ...f.base, runId: f.rootRunId });
      expect((await read())!.phase).toBe('active');
    });
    it('still rejects a revoked local grant after an excluded approval wait', async () => {
      const f = await setup();
      const c = await createLocalCommandOperation(
        { context: f.context, arguments: f.args, callId: randomUUID() },
        f.db,
      );
      const op = c.snapshot.binding.attempt.operationId;
      await f.approve(await f.approvalFor(op));
      await f.db`update allrice_bridge_folder_grants set revoked_at=clock_timestamp() where device_id=${f.device.id}`;
      await expect(
        f.freshLedger().dispatch({
          scope: f.task.scope,
          operationId: op,
          leaseOwner: randomUUID(),
          leaseMs: 15000,
        }),
      ).rejects.toThrow();
      expect(
        await f.db`select 1 from allrice_runtime_operations where id=${op} and lease_owner is not null`,
      ).toHaveLength(0);
    });
    it('persists Ask User waits through the lease-checked event entry and never reopens a answered ID', async () => {
      const f = await setup();
      const send = (answered: boolean) =>
        appendJobEvent({
          ...f.worker,
          type: 'harness.native',
          payload: {
            source: 'dsh',
            sourceEventType: answered
              ? 'session/user-question-answered'
              : 'session/user-question',
            nativePayload: { questionId: 'q1' },
          },
        });
      await send(false);
      expect(
        (await f.db.begin((tx) => readTaskClock(tx, f.rootRunId)))!.phase,
      ).toBe('waiting');
      await f.db`update allrice_task_clocks set changed_at=clock_timestamp()-interval '40 minutes' where run_id=${f.rootRunId}`;
      await send(true);
      await send(false);
      const clock = await f.db.begin((tx) => readTaskClock(tx, f.rootRunId));
      expect(clock!.phase).toBe('active');
      expect(clock!.waitingMs).toBeGreaterThanOrEqual(2400000);
    });
    it('resolves explicit admin policies for new Runs without rewriting an existing clock', async () => {
      const f = await setup(),
        input = {
          organizationId: f.org,
          userId: f.user,
          employeeId: randomUUID(),
          connectionId: randomUUID(),
        };
      expect((await freezeTaskRuntimePolicy(input, f.db)).timeoutMs).toBe(
        3600000,
      );
      await f.db`insert into allrice_model_resource_limits(id,scope_type,scope_id,organization_id,monthly_run_limit,monthly_token_limit,concurrent_run_limit,max_runtime_ms)
        values(${randomUUID()},'user',${f.user},${f.org},2000,5000000,3,0)`;
      expect((await freezeTaskRuntimePolicy(input, f.db)).timeoutMs).toBe(0);
      expect(
        (await f.db.begin((tx) => readTaskClock(tx, f.rootRunId)))!.timeoutMs,
      ).toBe(3600000);
      await f.db`insert into allrice_model_resource_limits(id,scope_type,scope_id,organization_id,monthly_run_limit,monthly_token_limit,concurrent_run_limit,max_runtime_ms)
        values(${randomUUID()},'tenant',${f.org},${f.org},2000,5000000,3,1800000)`;
      expect((await freezeTaskRuntimePolicy(input, f.db)).timeoutMs).toBe(
        1800000,
      );
    });
  },
);
