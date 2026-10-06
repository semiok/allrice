/** Isolated PostgreSQL protocol proof; no host effects or paid model. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import { devReleaseJobType } from './dev-release-control.ts';
import {
  enqueueRun,
  claimNextJob,
  startClaimedJob,
  heartbeatJob,
  appendJobEvent,
  completeJob,
  failJob,
} from './execution/queue.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'Dev supervisor bootstrap: ordinary consumers cannot obtain host authority',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    let company: Awaited<ReturnType<typeof createExperienceFixture>>;
    beforeAll(async () => {
      fixture = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      company = await createExperienceFixture(fixture.db);
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
    });
    const submit = async () =>
      (
        await enqueueRun(company.owner, {
          workspaceId: company.workspace,
          idempotencyKey: randomUUID(),
          type: 'allrice.bootstrap.proof',
          input: {},
          maxAttempts: 1,
          timeoutMs: 300000,
        })
      ).run;

    it('denies generic control admission for an ordinary employee and a real platform admin without creating a Run', async () => {
      const before = await fixture.db`select count(*)::int n from allrice_runs`;
      for (const context of [company.owner, company.reviewer])
        for (const type of [
          devReleaseJobType,
          'allrice.platform.dev.reconcile',
        ]) {
          await expect(
            enqueueRun(context, {
              workspaceId: company.workspace,
              idempotencyKey: randomUUID(),
              type,
              input: { role: 'dev_release_supervisor' },
            }),
          ).rejects.toMatchObject({ code: 'policy_denied' });
        }
      expect(
        await fixture.db`select count(*)::int n from allrice_runs`,
      ).toEqual(before);
    });
    it('ignores a high-priority control job, and executes the next ordinary canonical Run normally', async () => {
      const control = await submit(),
        business = await submit();
      await fixture.db`update allrice_jobs set payload=jsonb_set(payload,'{type}',to_jsonb(${devReleaseJobType}::text)),priority=100 where id=${control.job.id}`;
      const workerId = randomUUID(),
        claimed = await claimNextJob(workerId, 30000);
      expect(claimed?.id).toBe(business.job.id);
      const leaseToken = claimed!.lease!.token;
      await startClaimedJob(workerId, claimed!.id, leaseToken);
      await completeJob({
        workerId,
        jobId: claimed!.id,
        leaseToken,
        result: { actualBusinessProof: true },
      });
      const [row] =
        await fixture.db`select status,attempt,worker_id from allrice_jobs where id=${control.job.id}`;
      expect(row).toMatchObject({
        status: 'queued',
        attempt: 0,
        worker_id: null,
      });
      const [done] =
        await fixture.db`select state from allrice_runs where id=${business.id}`;
      expect(done?.state).toBe('succeeded');
    });
    it('rejects start, heartbeat, event, success and failure even with a known valid control lease; rows and events stay unchanged', async () => {
      const run = await submit(),
        workerId = randomUUID(),
        leaseToken = randomUUID();
      await fixture.db`update allrice_jobs set status='claimed',attempt=1,worker_id=${workerId},lease_token=${leaseToken},claimed_at=clock_timestamp(),heartbeat_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '5 minutes',payload=jsonb_set(payload,'{type}',to_jsonb(${devReleaseJobType}::text)) where id=${run.job.id}`;
      const before =
        await fixture.db`select * from allrice_jobs where id=${run.job.id}`;
      await expect(
        startClaimedJob(workerId, run.job.id, leaseToken),
      ).rejects.toMatchObject({ code: 'policy_denied' });
      expect(
        await fixture.db`select * from allrice_jobs where id=${run.job.id}`,
      ).toEqual(before);
      await fixture.db`update allrice_jobs set status='running' where id=${run.job.id}`;
      const running =
        await fixture.db`select * from allrice_jobs where id=${run.job.id}`;
      const events =
        await fixture.db`select * from allrice_run_events where run_id=${run.id} order by sequence`;
      const lease = { workerId, jobId: run.job.id, leaseToken };
      for (const action of [
        () => heartbeatJob(workerId, run.job.id, leaseToken, 30000),
        () =>
          appendJobEvent({
            ...lease,
            type: 'tool.completed',
            payload: { deployed: true },
          }),
        () => completeJob({ ...lease, result: { deployed: true } }),
        () =>
          failJob({
            ...lease,
            code: 'FAILED',
            message: 'synthetic',
            retryable: true,
          }),
      ])
        await expect(action()).rejects.toMatchObject({ code: 'policy_denied' });
      expect(
        await fixture.db`select * from allrice_jobs where id=${run.job.id}`,
      ).toEqual(running);
      expect(
        await fixture.db`select * from allrice_run_events where run_id=${run.id} order by sequence`,
      ).toEqual(events);
    });
  },
);
