import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TransactionSql } from 'postgres';
import { ExecutionContextSchema } from '@allrice/contracts';
import { resolveTaskRuntimePolicy } from './task-runtime-policy.ts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from './assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from './assistant-authority.fixture.ts';
import { assertAssistantAuthority } from './assistant-authority.ts';
import { refreshTaskClock } from './task-clock.ts';
import {
  ArtifactPublicationRollbackError,
  publishWorkbenchArtifact,
} from './artifact-review.ts';

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
suite(
  'artifact publication versus assistant clock and confirmed rollback — isolated PostgreSQL',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
      fixture = await createAssistantFixtureDatabase();
    }, 120000);
    afterAll(async () => {
      await fixture?.close();
      vi.unstubAllEnvs();
    });
    async function setup() {
      const f = await createAssistantAuthorityFixture(fixture.db, {
        allowedTools: ['assistant.delegate', 'workspace.export.create'],
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
      return { ...f, input, storage: assistantFixtureStorage(fixture.db) };
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
