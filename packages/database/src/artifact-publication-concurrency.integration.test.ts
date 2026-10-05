import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TransactionSql } from 'postgres';
import { ExecutionContextSchema, type StoragePort } from '@allrice/contracts';
import { resolveTaskRuntimePolicy } from './task-runtime-policy.ts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from './assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from './assistant-authority.fixture.ts';
import { assertAssistantAuthority } from './assistant-authority.ts';
import { refreshTaskClock } from './task-clock.ts';
import * as client from './core/client.ts';
import { cancelRun, completeJob } from './execution/queue.ts';
import {
  ArtifactPublicationRollbackError,
  publishWorkbenchArtifact,
  readArtifactBytes,
  listWorkbenchArtifacts,
} from './artifact-review.ts';
import { getChatSessionHistory } from './workspace/service.ts';
import { readTaskNextSteps } from './task-next-steps.ts';
import { listCompanyDeliverables } from './company-deliverables.ts';
import { readOrganizationDashboard } from './organization-dashboard.ts';
import {
  ensureBootstrapPortalPrincipal,
  createSession,
  authenticateSession,
} from './identity.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const storageWithPut = (
  storage: StoragePort,
  put: StoragePort['put'],
): StoragePort => ({
  put,
  get: storage.get.bind(storage),
  exists: storage.exists.bind(storage),
  delete: storage.delete.bind(storage),
});
suite(
  'artifact publication versus assistant clock and confirmed rollback — isolated PostgreSQL',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    let admin: NonNullable<Awaited<ReturnType<typeof authenticateSession>>>;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
      fixture = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      const principal = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug: 'allrice-platform',
          organizationName: 'Private platform',
          workspaceSlug: 'default',
          workspaceName: 'Private',
          email: 'publication-window-admin@example.test',
          displayName: 'Isolated admin',
          role: 'member',
        },
        fixture.db,
      );
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', principal.user.email);
      admin = (await authenticateSession(
        (await createSession(principal.user.id)).token,
      ))!;
    }, 120000);
    afterAll(async () => {
      await fixture?.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
    async function setup() {
      const f = await createAssistantAuthorityFixture(fixture.db, {
        allowedTools: ['assistant.delegate', 'workspace.export.create'],
        memberRole: 'member',
      });
      const [basis] =
        await fixture.db`select e.status employee_status,u.status user_status,a.active assignment_active,m.active membership_active,
        s.employee_assignment_id=${f.assignment} assignment_matches,a.employee_version_id=${f.version} version_matches
        from allrice_chat_sessions s join allrice_employee_assignments a on a.id=s.employee_assignment_id
        join allrice_employees e on e.id=a.employee_id join allrice_users u on u.id=s.owner_id
        join allrice_memberships m on m.user_id=s.owner_id and m.organization_id=s.organization_id and m.workspace_id=s.workspace_id where s.id=${f.session}`;
      expect(basis).toMatchObject({
        employee_status: 'active',
        user_status: 'active',
        assignment_active: true,
        membership_active: true,
        assignment_matches: true,
        version_matches: true,
      });
      const [policy] =
        await fixture.db`select payload,issued_at,expires_at from allrice_policy_snapshots where id=${f.policy}`;
      const context = ExecutionContextSchema.parse({
        executionId: randomUUID(),
        runId: f.rootRunId,
        jobId: f.worker.jobId,
        worker: { type: 'worker', id: f.worker.workerId },
        delegatedBy: { type: 'user', id: f.user },
        organizationId: f.org,
        workspaceId: f.workspace,
        policySnapshot: {
          id: f.policy,
          organizationId: f.org,
          subjectId: f.user,
          version: 1,
          issuedAt: policy!.issued_at.toISOString(),
          expiresAt: policy!.expires_at.toISOString(),
          ...policy!.payload,
        },
        startedAt: new Date().toISOString(),
      });
      await fixture.db`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy)
      values(${f.rootRunId},${f.org},${f.workspace},${fixture.db.json({ ...resolveTaskRuntimePolicy([]) })})`;
      const input = {
        context,
        sessionId: f.session,
        callId: randomUUID(),
        kind: 'document' as const,
        fileName: 'recovery.txt',
        format: 'text' as const,
        bytes: Buffer.from('Actual stored fixture'),
        mediaType: 'text/plain',
      };
      return {
        ...f,
        input,
        requestContext: {
          ...f.context,
          memberships: context.policySnapshot.memberships,
        },
        storage: assistantFixtureStorage(fixture.db),
      };
    }

    async function settleCanceled(f: Awaited<ReturnType<typeof setup>>) {
      // The actual terminal transaction must reject a late successful handler.
      await completeJob({
        ...f.worker,
        result: { text: 'synthetic late success, never an accepted outcome' },
      });
      const [run] =
        await fixture.db`select state from allrice_runs where id=${f.rootRunId}`;
      const [job] =
        await fixture.db`select status from allrice_jobs where id=${f.worker.jobId}`;
      expect(run!.state).toBe('canceled');
      expect(job!.status).toBe('canceled');
      const history = await getChatSessionHistory(
        f.requestContext,
        f.workspace,
        f.session,
      );
      expect(
        history.messages.find(
          (m) => m.runId === f.rootRunId && m.role === 'assistant',
        )?.status,
      ).toBe('failed');
      const { artifacts } = await listWorkbenchArtifacts(
        f.requestContext,
        f.session,
      );
      const company = await listCompanyDeliverables(admin, f.org);
      for (const artifact of artifacts)
        expect(
          company.deliverables.find((d) => d.id === artifact.version.id),
        ).toMatchObject({
          runId: f.rootRunId,
          runStatus: 'canceled',
          state: 'ready',
        });
      const next = await readTaskNextSteps(
        f.requestContext,
        {
          workspaceId: f.workspace,
          sessionId: f.session,
          employeeAssignmentId: f.assignment,
          employeeVersionId: f.version,
        },
        fixture.db,
      );
      expect(next.state).toBe('canceled');
      expect(next.notice).toContain('已取消');
      expect(next.scope.sourceRunId).toBe(f.rootRunId);
      const dashboard = await readOrganizationDashboard(admin, f.org);
      expect(dashboard.work).toMatchObject({ completed: 0, canceled: 1 });
      expect(dashboard.deliverables.availableSeries).toBe(artifacts.length);
    }

    it('publication waits before taking the session lock while an actual clock/authority check owns the job', async () => {
      const f = await setup(),
        held = gate(),
        resume = gate();
      let checkerPid = 0,
        publisherPid = 0;
      const check = fixture.db.begin(async (tx) => {
        await tx`set local statement_timeout='8s'`;
        checkerPid = (
          await tx<{ pid: number }[]>`select pg_backend_pid() as pid`
        )[0]!.pid;
        await refreshTaskClock(tx, f.rootRunId);
        held.resolve();
        await resume.promise;
        await assertAssistantAuthority({
          transaction: tx,
          task: f.task,
          tools: ['workspace.export.create'],
          phase: 'tool',
        });
      });
      void check.catch(() => {});
      await held.promise;
      const observed = new Proxy(fixture.db, {
        get(target, key) {
          if (key !== 'begin') return Reflect.get(target, key, target);
          return (body: (tx: TransactionSql) => Promise<unknown>) =>
            target.begin(async (tx) => {
              await tx`set local statement_timeout='8s'`;
              publisherPid = (
                await tx<{ pid: number }[]>`select pg_backend_pid() as pid`
              )[0]!.pid;
              return body(tx);
            });
        },
      });
      const publication = publishWorkbenchArtifact(
        f.input,
        f.storage,
        observed,
      );
      void publication.catch(() => {});
      try {
        await expect
          .poll(
            async () => {
              if (!publisherPid) return false;
              const [row] =
                await fixture.db`select ${checkerPid} = any(pg_blocking_pids(${publisherPid})) as blocked`;
              return row!.blocked;
            },
            { timeout: 4000, interval: 20 },
          )
          .toBe(true);
      } finally {
        resume.resolve();
      }
      await check;
      const artifact = await publication;
      expect(artifact.version.fileName).toBe('recovery.txt');
      expect(await f.storage.exists(artifact.object)).toBe(true);
    });

    it('delivery.publication-cancel.v1: confirmed cancellation before admission writes no artifact and late success remains canceled', async () => {
      const f = await setup();
      const put = vi.fn(f.storage.put.bind(f.storage));
      await cancelRun(f.requestContext, f.workspace, f.rootRunId, {
        reason: 'isolated cancellation before publication',
      });
      await expect(
        publishWorkbenchArtifact(
          f.input,
          storageWithPut(f.storage, put),
          fixture.db,
        ),
      ).rejects.toMatchObject({ code: 'run_unavailable' });
      expect(put).not.toHaveBeenCalled();
      expect(
        await fixture.db`select version_id from allrice_workbench_artifacts where run_id=${f.rootRunId}`,
      ).toHaveLength(0);
      await settleCanceled(f);
    });

    it('delivery.publication-cancel.v1: an admitted publication commits once before waiting cancellation, retaining its bytes without reviving the Run', async () => {
      const f = await setup(),
        resume = gate();
      let publisherPid = 0,
        written = false;
      const cancellationPids: number[] = [];
      function observe(
        bodyDb: typeof fixture.db,
        record: (pid: number) => void,
      ) {
        return new Proxy(bodyDb, {
          get(target, key) {
            if (key !== 'begin') return Reflect.get(target, key, target);
            return (body: (tx: TransactionSql) => Promise<unknown>) =>
              target.begin(async (tx) => {
                await tx`set local statement_timeout='8s'`;
                record(
                  (
                    await tx<{ pid: number }[]>`select pg_backend_pid() as pid`
                  )[0]!.pid,
                );
                return body(tx);
              });
          },
        });
      }
      const put = vi.fn(async (...args: Parameters<typeof f.storage.put>) => {
        await f.storage.put(...args);
        written = true;
        await resume.promise;
      });
      const publication = publishWorkbenchArtifact(
        f.input,
        storageWithPut(f.storage, put),
        observe(fixture.db, (pid) => {
          publisherPid = pid;
        }),
      );
      void publication.catch(() => {});
      let cancellation: ReturnType<typeof cancelRun> | undefined;
      try {
        await expect
          .poll(() => written, { timeout: 4000, interval: 20 })
          .toBe(true);
        vi.mocked(client.getDatabase).mockReturnValue(
          observe(fixture.db, (pid) => cancellationPids.push(pid)),
        );
        cancellation = cancelRun(f.requestContext, f.workspace, f.rootRunId, {
          reason: 'isolated cancellation while bytes are written',
        });
        void cancellation.catch(() => {});
        await expect
          .poll(
            async () => {
              if (!cancellationPids.length || !publisherPid) return false;
              const [row] =
                await fixture.db`select exists(select 1 from pg_stat_activity where pid=any(${cancellationPids}) and ${publisherPid}=any(pg_blocking_pids(pid))) as blocked`;
              return row!.blocked;
            },
            { timeout: 4000, interval: 20 },
          )
          .toBe(true);
      } finally {
        resume.resolve();
        await Promise.allSettled([
          publication,
          ...(cancellation ? [cancellation] : []),
        ]);
        vi.mocked(client.getDatabase).mockReturnValue(fixture.db);
      }
      const artifact = await publication;
      await cancellation;
      expect(put).toHaveBeenCalledTimes(1);
      expect(
        Buffer.from(await readArtifactBytes(f.storage, artifact.object)),
      ).toEqual(f.input.bytes);
      expect(
        await fixture.db`select version_id from allrice_workbench_artifacts where run_id=${f.rootRunId}`,
      ).toHaveLength(1);
      await settleCanceled(f);
      expect(await f.storage.exists(artifact.object)).toBe(true);
    });

    it('delivery.publication-recovery.v1: lost commit response preserves actual bytes and same callId recovers once, including after cancellation', async () => {
      const f = await setup();
      let loseReply = true;
      const observed = new Proxy(fixture.db, {
        get(target, key) {
          if (key !== 'begin') return Reflect.get(target, key, target);
          return async (body: (tx: TransactionSql) => Promise<unknown>) => {
            const committed = await target.begin(body);
            if (loseReply) {
              loseReply = false;
              throw Object.assign(
                Error('synthetic reply lost after actual commit'),
                { code: 'ECONNRESET' },
              );
            }
            return committed;
          };
        },
      });
      const storage = {
        put: vi.fn(f.storage.put.bind(f.storage)),
        get: f.storage.get.bind(f.storage),
        exists: f.storage.exists.bind(f.storage),
        delete: vi.fn(f.storage.delete.bind(f.storage)),
      };
      await expect(
        publishWorkbenchArtifact(f.input, storage, observed),
      ).rejects.toMatchObject({ code: 'ECONNRESET' });
      expect(storage.delete).not.toHaveBeenCalled();
      const artifact = await publishWorkbenchArtifact(
        f.input,
        storage,
        observed,
      );
      expect(storage.put).toHaveBeenCalledTimes(1);
      expect(
        Buffer.from(await readArtifactBytes(storage, artifact.object)),
      ).toEqual(f.input.bytes);
      expect(
        await fixture.db`select version_id from allrice_workbench_artifacts where run_id=${f.rootRunId}`,
      ).toHaveLength(1);
      await expect(
        publishWorkbenchArtifact(
          {
            ...f.input,
            bytes: Buffer.from('different bytes with the same identity'),
          },
          storage,
          observed,
        ),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
      await cancelRun(f.requestContext, f.workspace, f.rootRunId, {
        reason: 'isolated cancellation after confirmed commit',
      });
      await settleCanceled(f);
      const recovered = await publishWorkbenchArtifact(
        f.input,
        storage,
        observed,
      );
      expect(recovered.id).toBe(artifact.id);
      expect(recovered.object.checksum).toBe(artifact.object.checksum);
      expect(storage.put).toHaveBeenCalledTimes(1);
      expect(storage.delete).not.toHaveBeenCalled();
      expect(
        await fixture.db`select id from allrice_deliverable_versions where object_id=${artifact.object.id}`,
      ).toHaveLength(1);
    });

    it.each([false, true])(
      'marks a SQL-aborted publication only after cleanup is confirmed (cleanup fails=%s)',
      async (cleanupFails) => {
        const f = await setup();
        await fixture.db
          .unsafe(`create or replace function reject_fixture_publication() returns trigger language plpgsql as $$ begin raise exception 'synthetic transaction abort' using errcode='40P01'; end $$;
      create trigger reject_fixture_publication before insert on allrice_workbench_artifacts for each row execute function reject_fixture_publication()`);
        const objects: Parameters<typeof f.storage.put>[0][] = [];
        const storage = {
          put: async (...args: Parameters<typeof f.storage.put>) => {
            objects.push(args[0]);
            return f.storage.put(...args);
          },
          get: f.storage.get.bind(f.storage),
          exists: f.storage.exists.bind(f.storage),
          delete: async (...args: Parameters<typeof f.storage.delete>) => {
            if (cleanupFails) throw Error('synthetic cleanup unavailable');
            return f.storage.delete(...args);
          },
        };
        try {
          const error = await publishWorkbenchArtifact(
            f.input,
            storage,
            fixture.db,
          ).catch((e: unknown) => e);
          expect(error instanceof ArtifactPublicationRollbackError).toBe(
            !cleanupFails,
          );
          if (!cleanupFails)
            expect(error).toMatchObject({
              runId: f.rootRunId,
              callId: f.input.callId,
              sqlState: '40P01',
            });
          expect(objects).toHaveLength(1);
          expect(await f.storage.exists(objects[0]!)).toBe(cleanupFails);
          expect(
            await fixture.db`select 1 from allrice_storage_objects where id=${objects[0]!.id}`,
          ).toHaveLength(0);
        } finally {
          await fixture.db.unsafe(
            'drop trigger reject_fixture_publication on allrice_workbench_artifacts; drop function reject_fixture_publication()',
          );
          for (const object of objects)
            await f.storage.delete({ ...object, immutable: false });
        }
        const recovered = await publishWorkbenchArtifact(
          f.input,
          f.storage,
          fixture.db,
        );
        expect(recovered.version.version).toBe(1);
        expect(await f.storage.exists(recovered.object)).toBe(true);
      },
    );
  },
);
