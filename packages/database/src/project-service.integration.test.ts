import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { projectServiceFixture } from './project-service.fixture.ts';
import {
  projectServiceUserAction,
  readProjectService,
  projectServicePreviewTarget,
  projectServiceWorkerControl,
} from './project-services.ts';
import { cancelRuntimeAgentOperationsTransaction } from './runtime-ledger/ledger.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET166 finite project service — real PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    for (const key of [
      'ASSISTANTS',
      'WORKBENCH',
      'RUNTIME_POLICY',
      'BRIDGE_OPERATION_LEDGER',
      'LOCAL_COMMAND',
      'LOCAL_SERVICE',
    ])
      vi.stubEnv(`ALLRICE_${key}_ENABLED`, '1');
    database = await createAssistantFixtureDatabase();
  }, 120000);
  afterAll(async () => {
    await database?.close();
    vi.unstubAllEnvs();
  });
  it('native canonical args reach existing operation/readiness/detail without claiming physical stop', async () => {
    const f = await projectServiceFixture(database.db),
      service = await readProjectService(f.requestContext, f.id, f.db);
    expect(service.state).toBe('ready');
    expect(service.stopped).toBe(false);
    expect(service.project).toEqual(f.project);
    expect(
      Date.parse(service.hardDeadlineAt) - Date.parse(service.expiresAt),
    ).toBeGreaterThan(2_900_000);
    expect(
      (await projectServicePreviewTarget(f.requestContext, f.id, f.db))
        .containerId,
    ).toBe('a'.repeat(64));
  });
  it('captured ordinary employee automation survives service heartbeat without fabricating approval', async () => {
    const f = await projectServiceFixture(database.db, true);
    const rows =
      await f.db`select id from allrice_approval_requests where resource_type='runtime_operation' and resource_id=${f.id}`;
    expect(rows).toHaveLength(0);
    expect((await f.exchange()).stopRequested).toBe(false);
  });
  it('membership downgrade revokes continuing execution and preview', async () => {
    const f = await projectServiceFixture(database.db);
    await f.db`update allrice_memberships set role='viewer' where id=${f.membership}`;
    expect((await f.exchange()).stopRequested).toBe(true);
    await expect(
      projectServicePreviewTarget(f.requestContext, f.id, f.db),
    ).rejects.toThrow();
  });
  it('successful Run keeps only its finite service, without reviving ended Job/root', async () => {
    const f = await projectServiceFixture(database.db);
    const completed = await f.runtime.finalizeRoot({
      scope: f.task.scope,
      rootRunId: f.context.runId,
      worker: f.assistantWorker,
    });
    expect(completed.status).toBe('completed');
    expect(completed.usageComplete).toBe(false);
    await f.db`update allrice_runs set state='succeeded' where id=${f.context.runId}`;
    await f.db`update allrice_jobs set status='succeeded' where id=${f.context.jobId}`;
    const continued = await f.exchange();
    expect(continued.stopRequested).toBe(false);
    const [job] =
      await f.db`select status from allrice_jobs where id=${f.context.jobId}`;
    expect(job!.status).toBe('succeeded');
  });
  it('explicit cancellation stops a successfully detached service without claiming physical cleanup', async () => {
    const f = await projectServiceFixture(database.db);
    await f.db`update allrice_runs set state='succeeded' where id=${f.context.runId}`;
    await f.db`update allrice_jobs set status='succeeded' where id=${f.context.jobId}`;
    await f.db.begin((tx) =>
      cancelRuntimeAgentOperationsTransaction(
        tx,
        f.context.runId,
        randomUUID(),
      ),
    );
    expect((await f.exchange()).stopRequested).toBe(true);
    const view = await readProjectService(f.requestContext, f.id, f.db);
    expect(view.stopRequested).toBe(true);
    expect(view.stopped).toBe(false);
  });
  it('an unready, expired or revoked service remains an unresolved physical action at Run completion', async () => {
    const f = await projectServiceFixture(database.db);
    await f.db`update allrice_bridge_managed_runtime_grants set revoked_at=clock_timestamp() where device_id=${f.device.id}`;
    expect(
      (
        await f.runtime.finalizeRoot({
          scope: f.task.scope,
          rootRunId: f.context.runId,
          worker: f.assistantWorker,
        })
      ).status,
    ).toBe('unknown');
  });
  it('stop races duplicate renewal without clearing confirmed physical evidence', async () => {
    const f = await projectServiceFixture(database.db),
      renew = {
        action: 'renew' as const,
        requestId: randomUUID(),
        leaseMs: 1800000,
      };
    const first = await projectServiceUserAction(
        f.requestContext,
        f.id,
        renew,
        f.db,
      ),
      same = await projectServiceUserAction(
        f.requestContext,
        f.id,
        renew,
        f.db,
      );
    expect(first.expiresAt).toBe(same.expiresAt);
    const stopped = await projectServiceUserAction(
      f.requestContext,
      f.id,
      { action: 'stop' },
      f.db,
    );
    expect(stopped.stopRequested).toBe(true);
    expect(stopped.stopped).toBe(false);
    expect((await f.exchange()).stopRequested).toBe(true);
    await expect(
      projectServiceUserAction(
        f.requestContext,
        f.id,
        { ...renew, requestId: randomUUID() },
        f.db,
      ),
    ).rejects.toThrow('project_service_unavailable');
  });
  it('a replaced Worker lease cannot renew or stop a service owned by the same account', async () => {
    const f = await projectServiceFixture(database.db),
      before = await readProjectService(f.requestContext, f.id, f.db);
    await f.db`update allrice_jobs set attempt=attempt+1,lease_token=${randomUUID()} where id=${f.context.jobId}`;
    for (const action of [
      { action: 'service_stop', serviceId: f.id },
      {
        action: 'service_renew',
        serviceId: f.id,
        requestId: randomUUID(),
        leaseMs: 1800000,
      },
    ])
      await expect(
        projectServiceWorkerControl(
          f.context,
          f.task.chatSessionId!,
          action,
          f.worker,
          f.storage,
          f.db,
        ),
      ).rejects.toThrow();
    const after = await readProjectService(f.requestContext, f.id, f.db);
    expect(after.stopRequested).toBe(false);
    expect(after.expiresAt).toBe(before.expiresAt);
  });
  it('rechecks the controlling Run after waiting for the service root lock', async () => {
    const f = await projectServiceFixture(database.db),
      before = await readProjectService(f.requestContext, f.id, f.db);
    let locked!: () => void, release!: () => void;
    const acquired = new Promise<void>((r) => (locked = r)),
      unlock = new Promise<void>((r) => (release = r));
    const holder = f.db.begin(async (tx) => {
      await tx`select root_run_id from allrice_runtime_roots where root_run_id=${f.context.runId} for update`;
      locked();
      await unlock;
    });
    await acquired;
    const action = projectServiceWorkerControl(
      f.context,
      f.task.chatSessionId!,
      {
        action: 'service_renew',
        serviceId: f.id,
        requestId: randomUUID(),
        leaseMs: 1800000,
      },
      f.worker,
      f.storage,
      f.db,
    );
    const result = expect(action).rejects.toThrow();
    try {
      await f.db`update allrice_runs set state='canceled' where id=${f.context.runId}`;
    } finally {
      release();
      await holder;
    }
    await result;
    expect(
      (await readProjectService(f.requestContext, f.id, f.db)).expiresAt,
    ).toBe(before.expiresAt);
  });
  it.each(['failed', 'canceled'])(
    '%s Run cannot detach or expose preview',
    async (state) => {
      const f = await projectServiceFixture(database.db);
      await f.db`update allrice_runs set state=${state} where id=${f.context.runId}`;
      expect((await f.exchange()).stopRequested).toBe(true);
      await expect(
        projectServicePreviewTarget(f.requestContext, f.id, f.db),
      ).rejects.toThrow();
    },
  );
  it('owner mismatch, revoked grant and expired lease reject actual preview authority', async () => {
    const f = await projectServiceFixture(database.db);
    await expect(
      readProjectService(
        { ...f.requestContext, actor: { type: 'user', id: randomUUID() } },
        f.id,
        f.db,
      ),
    ).rejects.toThrow();
    await f.db`update allrice_bridge_managed_runtime_grants set revoked_at=clock_timestamp() where device_id=${f.device.id}`;
    await expect(
      projectServicePreviewTarget(f.requestContext, f.id, f.db),
    ).rejects.toThrow();
    expect((await f.exchange()).stopRequested).toBe(true);
  });
});
