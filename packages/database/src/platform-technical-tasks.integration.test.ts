import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import { ensureBootstrapPortalPrincipal } from './identity.ts';
import {
  createPlatformTechnicalTask,
  getPlatformTechnicalTask,
  getPlatformTechnicalExecution,
  cancelPlatformTechnicalTask,
  technicalDigest,
  recordPlatformTechnicalUsage,
} from './platform-technical-tasks.ts';
import {
  appendPlatformTechnicalReceipt,
  claimNextJob,
  startClaimedJob,
  completeJob,
  heartbeatJob,
  enqueueRun,
  maintainQueue,
  failJob,
} from './execution/queue.ts';
import { readPlatformTechnicalDiagnostics } from './platform-technical.ts';
import { nativeBrokerRoundtrip } from '../../../apps/worker/src/harness/dsh-native-broker.fixture.ts';
import { runClaimedJob } from '../../../apps/worker/src/job-runner.ts';
import { executePlatformTechnicalTask } from '../../../apps/worker/src/jobs/platform-technical.ts';
import { DshHarnessAdapter } from '../../../apps/worker/src/harness/dsh-adapter.ts';
import { HandlerError } from '../../../apps/worker/src/errors.ts';
import { attachAssistantFailureUsage } from '../../../apps/worker/src/harness/dsh/assistant-outcome.ts';
import { executeRiceTool } from '../../../apps/worker/src/tool-broker.ts';
import { TechnicalTaskDetailSchema } from './platform-technical-contracts.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'private platform technical task: real PG queue, receipts and pinned native tools / no paid model',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    let customer: Awaited<ReturnType<typeof createExperienceFixture>>;
    let admin: RequestContext;
    let adminEmail: string;
    beforeAll(async () => {
      fixture = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      vi.spyOn(client, 'getDiagnosticsDatabase').mockReturnValue(fixture.db);
      customer = await createExperienceFixture(fixture.db);
      const account = await ensureBootstrapPortalPrincipal({
        organizationSlug: 'allrice-platform',
        organizationName: 'Internal',
        workspaceSlug: 'control-plane',
        workspaceName: 'Internal',
        email: 'technical-admin@example.test',
        displayName: 'Admin',
        role: 'member',
      });
      adminEmail = account.user.email;
      await fixture.db`delete from allrice_memberships where user_id=${account.user.id}`;
      admin = {
        ...customer.owner,
        actor: { type: 'user', id: account.user.id },
        workspaceId: null,
        memberships: [],
      };
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', adminEmail);
      vi.stubEnv('ALLRICE_ENV', 'test');
      await fixture.db`update allrice_model_connections set status='ready' where id='52000000-0000-4000-8000-000000000001'`;
      await fixture.db`update allrice_model_providers set enabled=true where provider_key='codex'`;
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
    });
    const submit = (
      question = 'Explain synthetic platform state',
      requestId = randomUUID(),
    ) => createPlatformTechnicalTask(admin, { question, requestId });
    async function start(detail: Awaited<ReturnType<typeof submit>>) {
      const workerId = randomUUID();
      const job = await claimNextJob(workerId, 30000);
      expect(job?.id).toBe(detail.task.jobId);
      const lease = {
        workerId,
        jobId: job!.id,
        leaseToken: job!.lease!.token,
        attempt: job!.attempt,
      };
      const execution = await startClaimedJob(
        workerId,
        job!.id,
        lease.leaseToken,
      );
      expect(execution).not.toBeNull();
      return { lease, execution: execution! };
    }
    async function finish(lease: Awaited<ReturnType<typeof start>>['lease']) {
      await completeJob({
        ...lease,
        result: {
          answer: 'Synthetic diagnosis',
          usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2 },
          usageComplete: true,
        },
      });
    }

    it('creates one atomic task/Run/Job with no company membership; simultaneous retries and configuration change keep the frozen version', async () => {
      const requestId = randomUUID();
      const before =
        await fixture.db`select * from allrice_memberships where organization_id=${customer.org}`;
      const [a, b] = await Promise.all([
        submit('Stable request', requestId),
        submit('Stable request', requestId),
      ]);
      expect(a.task.id).toBe(b.task.id);
      const rows =
        await fixture.db`select t.id,j.max_attempts,o.slug from allrice_platform_technical_tasks t
      join allrice_jobs j on j.id=t.job_id join allrice_organizations o on o.id=t.organization_id where t.request_id=${requestId}`;
      expect(rows).toEqual([
        { id: a.task.id, max_attempts: 1, slug: 'allrice-platform' },
      ]);
      expect(
        await fixture.db`select * from allrice_memberships where organization_id=${customer.org}`,
      ).toEqual(before);
      expect(
        await fixture.db`select run_id from allrice_employee_runs where run_id=${a.task.runId}`,
      ).toEqual([]);
      await fixture.db`update allrice_platform_model_settings set revision=revision+1 where singleton`;
      expect(
        (await submit('Stable request', requestId)).task.modelRevision,
      ).toBe(a.task.modelRevision);
      await expect(
        submit('Different request', requestId),
      ).rejects.toMatchObject({ code: 'conflict' });
      await cancelPlatformTechnicalTask(admin, a.task.id);
      await maintainQueue();
      expect(
        (await getPlatformTechnicalTask(admin, a.task.id)).task.status,
      ).toBe('canceled');
    });
    it('rejects ordinary submissions, private tool names, cross-account details and untrusted queue binding without orphan Jobs', async () => {
      await expect(
        createPlatformTechnicalTask(customer.owner, {
          requestId: randomUUID(),
          question: 'forged',
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        enqueueRun(customer.owner, {
          workspaceId: customer.workspace,
          idempotencyKey: randomUUID(),
          type: 'allrice.platform.technical',
          input: {},
        }),
      ).rejects.toMatchObject({ code: 'policy_denied' });
      const d = await submit();
      const { lease, execution } = await start(d);
      await expect(
        executeRiceTool({
          context: execution.context,
          capabilities: ['model:invoke'],
          storageRoot: 'unused',
          call: {
            id: 'forged',
            name: 'platform.technical.diagnostics',
            arguments: { scope: 'current' },
          },
        }),
      ).rejects.toMatchObject({ code: 'PLATFORM_TECHNICAL_DENIED' });
      vi.stubEnv(
        'ALLRICE_PLATFORM_ADMIN_EMAILS',
        `${adminEmail},${customer.owner.actor.id}@example.test`,
      );
      await expect(
        getPlatformTechnicalTask(customer.owner, d.task.id),
      ).rejects.toMatchObject({ code: 'not_found' });
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', adminEmail);
      await finish(lease);
    });
    it('atomic native receipts return the first actual sample, reject late writes and persist strict detail schemas', async () => {
      const d = await submit();
      const { lease } = await start(d);
      const first = await readPlatformTechnicalDiagnostics(admin, {
        database: fixture.db,
        diagnostics: fixture.db,
      });
      const args = {
        ...lease,
        taskId: d.task.id,
        callId: 'same-call',
        arguments: { scope: 'current' },
        diagnostics: first,
        issue: null,
      };
      const later = {
        ...first,
        capturedAt: new Date(Date.now() + 1000).toISOString(),
      };
      const [a, b] = await Promise.all([
        appendPlatformTechnicalReceipt(args),
        appendPlatformTechnicalReceipt({ ...args, diagnostics: later }),
      ]);
      expect(a.receiptId).toBe(b.receiptId);
      expect(a.outputDigest).toBe(b.outputDigest);
      const detail = TechnicalTaskDetailSchema.parse(
        await getPlatformTechnicalTask(admin, d.task.id),
      );
      expect(detail.receipts).toHaveLength(1);
      expect(a.outputDigest).toBe(
        technicalDigest({ diagnostics: a.diagnostics, issue: null }),
      );
      expect(a.diagnostics.web.value).toBeNull();
      await expect(
        appendPlatformTechnicalReceipt({
          ...args,
          arguments: { scope: 'current', sql: 'select secrets' },
        }),
      ).rejects.toThrow();
      await finish(lease);
      await expect(appendPlatformTechnicalReceipt(args)).rejects.toMatchObject({
        code: 'lease_lost',
      });
      expect(
        (await getPlatformTechnicalTask(admin, d.task.id)).receipts,
      ).toHaveLength(1);
    });
    it('native DSH accepts exact private parameters through real Broker and exposes only its single diagnostic tool', async () => {
      const d = await submit();
      const { lease, execution } = await start(d);
      const progress: Record<string, unknown>[] = [];
      await nativeBrokerRoundtrip({
        canonicalName: 'platform.technical.diagnostics',
        wireName: 'platform_technical_diagnostics',
        args: { scope: 'current' },
        invalidArgs: { scope: 'current', host: 'http://private.invalid' },
        cordisConfig: resolve(
          import.meta.dirname,
          '../../../apps/worker/dsh/allrice-technical.cordis.yml',
        ),
        progress: async (request) => {
          progress.push(request);
          await getPlatformTechnicalExecution(lease);
          return { paused: false };
        },
        expectedToolNames: ['platform_technical_diagnostics'],
        inspectSchema: (s) => expect(s.required).toContain('scope'),
        onToolCall: (call) =>
          executeRiceTool({
            context: execution.context,
            capabilities: ['model:invoke'],
            storageRoot: 'unused',
            technicalTaskLease: lease,
            technicalTaskId: d.task.id,
            call,
          }),
      });
      expect(
        (await getPlatformTechnicalTask(admin, d.task.id)).receipts,
      ).toHaveLength(1);
      expect(
        progress.filter((r) => r.kind === 'model' && r.action === 'start'),
      ).toHaveLength(4);
      expect(progress.some((r) => r.action === 'check')).toBe(true);
      await finish(lease);
    }, 60000);
    it.each([
      'success',
      'failure',
      'deadline_wait',
      'deadline_after_return',
      'cancel',
    ] as const)(
      'Worker lifecycle %s preserves evidence, usage and canonical terminal without a paid model',
      async (mode) => {
        const d = await submit();
        const workerId = randomUUID();
        const job = await claimNextJob(workerId, 30000);
        expect(job?.id).toBe(d.task.jobId);
        const root = await mkdtemp(join(tmpdir(), 'allrice-technical-worker-'));
        const spy = vi
          .spyOn(DshHarnessAdapter.prototype, 'execute')
          .mockImplementation(async (input) => {
            expect(input.executionEnvironment.ALLRICE_RUN_ID).toBe(
              d.task.runId,
            );
            expect(input.tools.map((t) => t.name)).toEqual([
              'platform.technical.diagnostics',
            ]);
            await input.progress!({ action: 'check' });
            await input.onToolCall!({
              id: 'worker-receipt',
              name: 'platform.technical.diagnostics',
              arguments: { scope: 'current' },
            });
            const usage = {
              inputTokens: 88,
              cachedInputTokens: 8,
              outputTokens: 4,
            };
            if (mode === 'deadline_wait' || mode === 'deadline_after_return')
              await fixture.db`update allrice_jobs set created_at=clock_timestamp()-interval '10 seconds',timeout_at=clock_timestamp()-interval '1 second' where id=${job!.id}`;
            if (mode === 'cancel')
              await cancelPlatformTechnicalTask(admin, d.task.id);
            if (
              mode === 'failure' ||
              mode === 'deadline_wait' ||
              mode === 'cancel'
            ) {
              const error = new HandlerError(
                mode === 'deadline_wait'
                  ? 'EXECUTION_ABORTED'
                  : 'SYNTHETIC_MODEL_ERROR',
                'Synthetic model receipt then failure',
                false,
              );
              attachAssistantFailureUsage(error, d.task.runId, job!.attempt, {
                usage,
                usageComplete: false,
                cacheUsageKnown: true,
              });
              throw error;
            }
            return {
              answer: 'Synthetic grounded diagnosis',
              provider: 'dsh',
              model: 'synthetic',
              usage,
              usageComplete: true,
              cacheUsageKnown: true,
            };
          });
        try {
          await runClaimedJob(
            {
              workerId,
              jobId: job!.id,
              leaseToken: job!.lease!.token,
              leaseMs: 30000,
              heartbeatMs: 10000,
              executionRoot: root,
              stopping: () => false,
              onAbortReady: () => {},
            },
            executePlatformTechnicalTask,
          );
          const detail = await getPlatformTechnicalTask(admin, d.task.id);
          const expected =
            mode === 'success'
              ? 'succeeded'
              : mode === 'cancel'
                ? 'canceled'
                : 'failed';
          expect(detail.task.status).toBe(expected);
          expect(detail.receipts).toHaveLength(1);
          expect(detail.task.usage).toEqual({
            inputTokens: 88,
            cachedInputTokens: 8,
            outputTokens: 4,
          });
          expect(detail.task.usageComplete).toBe(mode === 'success');
          if (mode.startsWith('deadline'))
            expect(detail.task.errorCode).toBe('JOB_TIMEOUT');
          expect(detail.task.actualCost).toBeNull();
          const terminals =
            await fixture.db`select id from allrice_run_events where run_id=${d.task.runId}
          and event_type in ('run.succeeded','run.failed','run.canceled')`;
          expect(terminals).toHaveLength(1);
        } finally {
          spy.mockRestore();
          await rm(root, { recursive: true, force: true });
        }
      },
      60000,
    );
    it('private native admission checks current authority before the first model request', async () => {
      const d = await submit();
      const { lease } = await start(d);
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', 'revoked@example.test');
      let checks = 0;
      await nativeBrokerRoundtrip({
        canonicalName: 'platform.technical.diagnostics',
        wireName: 'platform_technical_diagnostics',
        args: { scope: 'current' },
        invalidArgs: { scope: 'current' },
        denyBeforeModel: true,
        cordisConfig: resolve(
          import.meta.dirname,
          '../../../apps/worker/dsh/allrice-technical.cordis.yml',
        ),
        progress: async () => {
          checks++;
          await getPlatformTechnicalExecution(lease);
          return { paused: false };
        },
      });
      expect(checks).toBeGreaterThan(0);
      await heartbeatJob(lease.workerId, lease.jobId, lease.leaseToken, 30000);
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', adminEmail);
      expect(
        (await getPlatformTechnicalTask(admin, d.task.id)).task.status,
      ).toBe('failed');
    }, 60000);
    it('no diagnostic receipt cannot succeed; known failure or canceled usage survives without double counting or new authority', async () => {
      const d = await submit();
      const { lease } = await start(d);
      await recordPlatformTechnicalUsage(
        lease,
        { inputTokens: 120, cachedInputTokens: 20, outputTokens: 10 },
        { usageComplete: false, cacheUsageKnown: true },
      );
      await finish(lease);
      expect(
        (await getPlatformTechnicalTask(admin, d.task.id)).task,
      ).toMatchObject({
        status: 'failed',
        errorCode: 'TECHNICAL_DIAGNOSTIC_RECEIPT_REQUIRED',
        usage: { inputTokens: 120, cachedInputTokens: 20, outputTokens: 10 },
        usageComplete: false,
        actualCost: null,
      });
      await Promise.all(
        [1, 2].map(() =>
          recordPlatformTechnicalUsage(
            lease,
            { inputTokens: 120, cachedInputTokens: 20, outputTokens: 10 },
            { usageComplete: false, cacheUsageKnown: true },
          ),
        ),
      );
      expect(
        (await getPlatformTechnicalTask(admin, d.task.id)).task.usage
          ?.inputTokens,
      ).toBe(120);
      await expect(
        recordPlatformTechnicalUsage(
          { ...lease, leaseToken: randomUUID() },
          { inputTokens: 999, cachedInputTokens: 0, outputTokens: 0 },
          { usageComplete: false, cacheUsageKnown: false },
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const canceled = await submit();
      const next = await start(canceled);
      await cancelPlatformTechnicalTask(admin, canceled.task.id);
      await finish(next.lease);
      await recordPlatformTechnicalUsage(
        next.lease,
        { inputTokens: 40, cachedInputTokens: 0, outputTokens: 2 },
        { usageComplete: false, cacheUsageKnown: false },
      );
      expect(
        (await getPlatformTechnicalTask(admin, canceled.task.id)).task,
      ).toMatchObject({
        status: 'canceled',
        usage: { inputTokens: 40 },
        usageComplete: false,
      });
    });
    it('failure before heartbeat normalizes the persisted deadline to JOB_TIMEOUT', async () => {
      const d = await submit();
      const { lease } = await start(d);
      await fixture.db`update allrice_jobs set created_at=clock_timestamp()-interval '10 seconds',timeout_at=clock_timestamp()-interval '1 second' where id=${lease.jobId}`;
      await failJob({
        ...lease,
        code: 'EXECUTION_ABORTED',
        message: 'Synthetic deadline signal',
        retryable: false,
      });
      expect(
        (await getPlatformTechnicalTask(admin, d.task.id)).task.errorCode,
      ).toBe('JOB_TIMEOUT');
    });
    it('revocation denies even tool-less models and heartbeat gives one failed terminal', async () => {
      const d = await submit();
      const { lease } = await start(d);
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', 'revoked@example.test');
      await expect(getPlatformTechnicalExecution(lease)).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      expect(
        await heartbeatJob(
          lease.workerId,
          lease.jobId,
          lease.leaseToken,
          30000,
        ),
      ).toEqual({ active: false, canceled: false });
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', adminEmail);
      const detail = await getPlatformTechnicalTask(admin, d.task.id);
      expect(detail.task).toMatchObject({
        status: 'failed',
        errorCode: 'PLATFORM_TECHNICAL_AUTH_REVOKED',
        usage: null,
        usageComplete: false,
        actualCostKnown: false,
        actualCost: null,
      });
      const terminal =
        await fixture.db`select event_type from allrice_run_events where run_id=${d.task.runId} and event_type in ('run.failed','run.succeeded','run.canceled')`;
      expect(terminal).toEqual([{ event_type: 'run.failed' }]);
      await expect(finish(lease)).rejects.toMatchObject({ code: 'lease_lost' });
    });
    it('final completion rechecks revocation and absolute deadline without waiting for heartbeat', async () => {
      const d = await submit();
      const { lease } = await start(d);
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', 'revoked@example.test');
      await finish(lease);
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', adminEmail);
      expect(
        (await getPlatformTechnicalTask(admin, d.task.id)).task.status,
      ).toBe('failed');
      const expired = await submit();
      const next = await start(expired);
      await fixture.db`update allrice_jobs set created_at=clock_timestamp()-interval '10 seconds',available_at=clock_timestamp()-interval '2 seconds',timeout_at=clock_timestamp()-interval '1 second' where id=${next.lease.jobId}`;
      await finish(next.lease);
      expect(
        (await getPlatformTechnicalTask(admin, expired.task.id)).task,
      ).toMatchObject({ status: 'failed', errorCode: 'JOB_TIMEOUT' });
    });
    it('cancel versus complete has one terminal; stopped and stale leases cannot collect again', async () => {
      const d = await submit();
      const { lease } = await start(d);
      await cancelPlatformTechnicalTask(admin, d.task.id);
      await expect(getPlatformTechnicalExecution(lease)).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      await finish(lease);
      expect(
        (await getPlatformTechnicalTask(admin, d.task.id)).task.status,
      ).toBe('canceled');
      const stale = await submit();
      const next = await start(stale);
      await fixture.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${next.lease.jobId}`;
      await expect(
        getPlatformTechnicalExecution(next.lease),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await maintainQueue();
      expect(
        (await getPlatformTechnicalTask(admin, stale.task.id)).task.status,
      ).toBe('failed');
      expect(await claimNextJob(randomUUID(), 30000)).toBeNull();
    });
  },
);
