import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { cloudProjectServiceFixture } from './cloud-project-service.fixture.ts';
import {
  readProjectService,
  projectServiceUserAction,
  projectServicePreviewTarget,
} from './project-services.ts';
import { listCloudRuntimeOperations } from './cloud-operation-view.ts';
import { completeJob, failJob } from './execution/queue.ts';
import type * as CoreClient from './core/client.ts';
let fixtureDatabase: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof CoreClient>()),
  getDatabase: () => fixtureDatabase.db,
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'shared cloud ProjectService authority and durable physical facts',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      for (const key of [
        'ASSISTANTS',
        'WORKBENCH',
        'RUNTIME_POLICY',
        'CLOUD_RUNNER',
        'LOCAL_COMMAND',
        'LOCAL_SERVICE',
        'BRIDGE_OPERATION_LEDGER',
      ])
        vi.stubEnv('ALLRICE_' + key + '_ENABLED', '1');
      database = await createAssistantFixtureDatabase();
      fixtureDatabase = database;
    });
    afterAll(async () => {
      await database?.close();
      vi.unstubAllEnvs();
    });
    const readyFixture = async (markReady = true) => {
      const f = await cloudProjectServiceFixture(database.db),
        ledger = f.created.ledger,
        binding = f.created.snapshot.binding;
      const lease = await ledger.dispatch({
          scope: binding.task.scope,
          operationId: f.id,
          leaseOwner: f.context.worker.id,
          leaseMs: 15000,
        }),
        identity = {
          scope: binding.task.scope,
          operationId: f.id,
          attempt: binding.attempt,
          leaseToken: lease.leaseToken,
        };
      await ledger.startOperation({ ...identity, receiptId: randomUUID() });
      await f.db`update allrice_cloud_execution_attempts set container_id=${'a'.repeat(64)} where operation_id=${f.id}`;
      const exchange = (
        events: Parameters<
          typeof ledger.exchangeCloudProjectService
        >[0]['events'] = [],
      ) => ledger.exchangeCloudProjectService({ ...identity, events });
      const first = await exchange();
      await exchange([
        {
          type: 'starting',
          processId: f.id,
          attemptId: binding.attempt.attemptId,
          sequence: 0,
          containerId: 'a'.repeat(64),
          hardDeadlineAt: first.hardDeadlineAt,
        },
      ]);
      if (markReady)
        await exchange([
          {
            type: 'ready',
            processId: f.id,
            attemptId: binding.attempt.attemptId,
            sequence: 1,
            port: 4173,
            visibility: 'container_only',
          },
        ]);
      return { ...f, ledger, identity, exchange, first };
    };
    it('the same ready service survives successful Run completion and has no device or new agent budget', async () => {
      const f = await readyFixture();
      expect(
        (
          await f.runtime.finalizeRoot({
            scope: f.task.scope,
            rootRunId: f.context.runId,
            worker: f.assistantWorker,
          })
        ).status,
      ).toBe('completed');
      await completeJob({
        workerId: f.context.worker.id,
        jobId: f.context.jobId,
        leaseToken: f.worker.leaseToken,
        result: { answer: 'Preview ready' },
      });
      const [conversation] =
        await f.db`select state,active_run_id from allrice_conversation_runtimes where session_id=${f.task.chatSessionId!}`;
      expect(conversation!.state).toBe('idle');
      expect(conversation!.active_run_id).toBeNull();
      expect((await f.exchange()).stopRequested).toBe(false);
      const target = await projectServicePreviewTarget(
        f.requestContext,
        f.id,
        f.db,
      );
      expect(target.backend).toBe('cloud');
      expect(target.deviceId).toBeNull();
      const view = (
        await listCloudRuntimeOperations(
          f.requestContext,
          f.context.runId,
          f.db,
        )
      )[0]!;
      expect(view.projectService?.state).toBe('ready');
      expect(JSON.stringify(view)).not.toContain(f.identity.leaseToken);
      const stopped = await projectServiceUserAction(
        f.requestContext,
        f.id,
        { action: 'stop' },
        f.db,
      );
      expect(stopped.stopped).toBe(false);
      expect((await f.exchange()).stopRequested).toBe(true);
      expect(
        (await readProjectService(f.requestContext, f.id, f.db)).stopReason,
      ).toBe('user_requested');
      const [audit] =
        await f.db`select count(*)::int as n from allrice_audit_events where resource_id=${f.id} and action='runtime.project_service.stop_requested'`;
      expect(audit!.n).toBe(1);
    });
    it('serializes a service heartbeat with the successful Run and conversation handoff', async () => {
      const f = await readyFixture();
      let unblock!: () => void, locked!: () => void;
      const acquired = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const release = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      const blocker = f.db.begin(async (tx) => {
        await tx`select session_id from allrice_conversation_runtimes where session_id=${f.task.chatSessionId!} for update`;
        locked();
        await release;
      });
      await acquired;
      let completed = false,
        exchanged = false;
      const completion = completeJob({
        workerId: f.context.worker.id,
        jobId: f.context.jobId,
        leaseToken: f.worker.leaseToken,
        result: { answer: 'Preview ready' },
      }).then(() => {
        completed = true;
      });
      await delay(250);
      const heartbeat = f.exchange().then((value) => {
        exchanged = true;
        return value;
      });
      try {
        await delay(250);
        expect(completed).toBe(false);
        expect(exchanged).toBe(false);
      } finally {
        unblock();
      }
      await blocker;
      await completion;
      expect((await heartbeat).stopRequested).toBe(false);
      expect(
        (await readProjectService(f.requestContext, f.id, f.db)).state,
      ).toBe('ready');
    });
    it('a failed real Job cannot retain a continuing service', async () => {
      const f = await readyFixture();
      await failJob({
        workerId: f.context.worker.id,
        jobId: f.context.jobId,
        leaseToken: f.worker.leaseToken,
        code: 'FIXTURE_FAILURE',
        message: 'Fixture failed',
        retryable: false,
      });
      expect((await f.exchange()).stopRequested).toBe(true);
      const [conversation] =
        await f.db`select state,active_run_id from allrice_conversation_runtimes where session_id=${f.task.chatSessionId!}`;
      expect(conversation!.state).toBe('error');
      expect(conversation!.active_run_id).toBeNull();
    });
    it('internal shutdown and historical records never claim a user stop', async () => {
      const f = await readyFixture();
      await projectServiceUserAction(
        f.requestContext,
        f.id,
        { action: 'stop' },
        f.db,
        undefined,
        'worker_shutdown',
      );
      expect(
        (await readProjectService(f.requestContext, f.id, f.db)).stopReason,
      ).toBe('worker_shutdown');
      const historical = await readyFixture();
      // A legacy persisted stop intent has neither audit cause nor outcome.
      await historical.db`update allrice_project_services set stop_requested=true where id=${historical.id}`;
      const view = await readProjectService(
        historical.requestContext,
        historical.id,
        historical.db,
      );
      expect(view.stopped).toBe(false);
      expect(view.stopReason).toBe('unknown');
      await historical.db`update allrice_cloud_execution_attempts set outcome=${historical.db.json({ serviceStopReason: 'token=private-secret' })} where operation_id=${historical.id}`;
      expect(
        (
          await readProjectService(
            historical.requestContext,
            historical.id,
            historical.db,
          )
        ).stopReason,
      ).toBe('unknown');
    });
    it('stop, current grant revocation and expired visible lease close authority without fabricating stop', async () => {
      const f = await readyFixture();
      await f.db`update allrice_cloud_execution_grants set revoked_at=clock_timestamp() where id=${f.grant}`;
      expect((await f.exchange()).stopRequested).toBe(true);
      expect(
        (await readProjectService(f.requestContext, f.id, f.db)).stopped,
      ).toBe(false);
      await expect(
        projectServicePreviewTarget(f.requestContext, f.id, f.db),
      ).rejects.toThrow('project_service_unavailable');
      const expired = await readyFixture();
      await expired.db`update allrice_project_services set expires_at=clock_timestamp()-interval '1 second' where id=${expired.id}`;
      expect((await expired.exchange()).stopRequested).toBe(true);
      expect(
        (
          await readProjectService(
            expired.requestContext,
            expired.id,
            expired.db,
          )
        ).stopReason,
      ).toBe('lease_expired');
      const [audit] =
        await f.db`select reason,metadata from allrice_audit_events where resource_id=${f.id} and action='runtime.project_service.stop_requested'`;
      expect(audit!.reason).toBe('cloud_authority_unavailable');
      expect(audit!.metadata).toMatchObject({
        backend: 'cloud',
        stage: 'service_heartbeat',
      });
    });
    it('ordered readiness cannot change its container, port, attempt or one-time hard ceiling', async () => {
      const f = await readyFixture();
      await expect(
        f.exchange([
          {
            type: 'starting',
            processId: f.id,
            attemptId: f.identity.attempt.attemptId,
            sequence: 0,
            containerId: 'b'.repeat(64),
            hardDeadlineAt: f.first.hardDeadlineAt,
          },
        ]),
      ).rejects.toThrow('receipt_conflict');
      await expect(
        projectServiceUserAction(
          { ...f.requestContext, actor: { type: 'user', id: randomUUID() } },
          f.id,
          { action: 'status' },
          f.db,
        ),
      ).rejects.toThrow('project_service_unavailable');
    });
    it('does not renew or commit readiness when the old lease expires while waiting for current authority', async () => {
      const f = await readyFixture(false);
      await f.db`update allrice_runtime_operations set lease_expires_at=clock_timestamp()+interval '400 milliseconds' where id=${f.id}`;
      const [before] =
        await f.db`select lease_expires_at from allrice_runtime_operations where id=${f.id}`;
      let unblock!: () => void, locked!: () => void;
      const acquired = new Promise<void>((resolve) => {
          locked = resolve;
        }),
        release = new Promise<void>((resolve) => {
          unblock = resolve;
        });
      const blocker = f.db.begin(async (tx) => {
        await tx`select id from allrice_cloud_execution_grants where id=${f.grant} for update`;
        locked();
        await release;
      });
      await acquired;
      const renewing = f.exchange([
        {
          type: 'ready',
          processId: f.id,
          attemptId: f.identity.attempt.attemptId,
          sequence: 1,
          port: 4173,
          visibility: 'container_only',
        },
      ]);
      await delay(700);
      unblock();
      await blocker;
      await expect(renewing).rejects.toThrow('lease_lost');
      const [after] =
        await f.db`select o.lease_expires_at,a.service_ready,a.service_events from allrice_runtime_operations o join allrice_cloud_execution_attempts a on a.operation_id=o.id where o.id=${f.id}`;
      expect(after!.lease_expires_at).toEqual(before!.lease_expires_at);
      expect(after!.service_ready).toBe(false);
      expect(after!.service_events).toHaveLength(1);
    });
    it('rolls back renewal if the original lease expires between its update and the final authority fence', async () => {
      const f = await readyFixture();
      await f.db`update allrice_runtime_operations set lease_expires_at=clock_timestamp()+interval '500 milliseconds' where id=${f.id}`;
      const [before] =
        await f.db`select lease_expires_at from allrice_runtime_operations where id=${f.id}`;
      await f.db.unsafe(
        'create function fixture_slow_renewal() returns trigger language plpgsql as $$ begin perform pg_sleep(0.7);return NEW;end $$',
      );
      await f.db.unsafe(
        `create trigger fixture_slow_renewal after update of lease_expires_at on allrice_runtime_operations for each row when (OLD.id='${f.id}'::uuid) execute function fixture_slow_renewal()`,
      );
      try {
        await expect(f.exchange()).rejects.toThrow('lease_lost');
        const [after] =
          await f.db`select lease_expires_at from allrice_runtime_operations where id=${f.id}`;
        expect(after!.lease_expires_at).toEqual(before!.lease_expires_at);
      } finally {
        await f.db.unsafe(
          'drop trigger fixture_slow_renewal on allrice_runtime_operations',
        );
        await f.db.unsafe('drop function fixture_slow_renewal()');
      }
    });
  },
);
