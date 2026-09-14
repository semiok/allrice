import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from './assistant-authority.fixture.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

integration(
  'P25 owned-host authority polling — isolated real PostgreSQL',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      database = await createAssistantFixtureDatabase();
    }, 120000);
    afterAll(async () => {
      await database?.close();
      vi.unstubAllEnvs();
    });

    it('rechecks current grants without mutation, but needs no new grant to drain a committed root cancellation', async () => {
      const f = await createAssistantAuthorityFixture(database.db);
      const before = await f.runtime.getTree(f.context, { runId: f.rootRunId });
      await expect(f.runtime.assertCurrentAuthority(f.base)).resolves.toEqual({
        cancelRequested: false,
      });
      expect(
        await f.runtime.getTree(f.context, { runId: f.rootRunId }),
      ).toEqual(before);
      await f.setControls({
        version: 1,
        enabled: true,
        mode: 'execute',
        rules: [{ action: 'assistant.delegate', effect: 'deny' }],
      });
      await expect(f.runtime.assertCurrentAuthority(f.base)).rejects.toThrow(
        'assistant_authority_denied',
      );
      await f.runtime.cancelRoot(f.context, {
        runId: f.rootRunId,
        requestId: randomUUID(),
      });
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      try {
        await expect(f.runtime.assertCurrentAuthority(f.base)).resolves.toEqual(
          {
            cancelRequested: true,
          },
        );
      } finally {
        vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      }
      const canceled = await f.runtime.getTree(f.context, {
        runId: f.rootRunId,
      });
      expect(canceled.instances[0]).toMatchObject({
        status: 'cancel_requested',
        stoppedAt: null,
      });
      expect(canceled.budgets).toEqual(before.budgets);
    });

    it('never treats another scope, root, generation, fence, or replacement token as the owned host', async () => {
      const f = await createAssistantAuthorityFixture(database.db);
      for (const worker of [
        { ...f.worker, jobId: randomUUID() },
        { ...f.worker, workerId: randomUUID() },
        { ...f.worker, leaseToken: randomUUID() },
        { ...f.worker, generation: f.worker.generation + 1 },
        { ...f.worker, fence: 2 },
      ])
        await expect(
          f.runtime.assertCurrentAuthority({ ...f.base, worker }),
        ).rejects.toThrow('lease_lost');
      await expect(
        f.runtime.assertCurrentAuthority({
          ...f.base,
          scope: { ...f.base.scope, workspaceId: randomUUID() },
        }),
      ).rejects.toThrow('not_found');
      await expect(
        f.runtime.assertCurrentAuthority({
          ...f.base,
          rootRunId: randomUUID(),
        }),
      ).rejects.toThrow('not_found');
      const replacement = { ...f.worker, leaseToken: randomUUID() };
      await database.db`update allrice_jobs set lease_token=${replacement.leaseToken} where id=${f.worker.jobId}`;
      for (const worker of [f.worker, replacement])
        await expect(
          f.runtime.assertCurrentAuthority({ ...f.base, worker }),
        ).rejects.toThrow('lease_lost');
    });

    it('rechecks the lease clock after a canceled-root job-row lock wait', async () => {
      const f = await createAssistantAuthorityFixture(database.db);
      await f.runtime.cancelRoot(f.context, {
        runId: f.rootRunId,
        requestId: randomUUID(),
      });
      await database.db`update allrice_jobs set lease_expires_at=clock_timestamp()+interval '500 milliseconds' where id=${f.worker.jobId}`;
      let release!: () => void, locked!: () => void;
      const releaseGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const lockedGate = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const blocker = database.db.begin(async (tx) => {
        await tx`select id from allrice_jobs where id=${f.worker.jobId} for update`;
        locked();
        await releaseGate;
      });
      await lockedGate;
      const checking = f.runtime.assertCurrentAuthority(f.base);
      checking.catch(() => {});
      try {
        await expect
          .poll(async () => {
            const [row] =
              await database.db`select count(distinct a.pid) as waiting from pg_stat_activity a join pg_locks l on l.pid=a.pid where a.wait_event_type='Lock' and l.relation='allrice_jobs'::regclass`;
            return Number(row!.waiting);
          })
          .toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 600));
      } finally {
        release();
        await blocker;
      }
      await expect(checking).rejects.toThrow('lease_lost');
    });
  },
);
