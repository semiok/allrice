import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RouteDecisionSchema,
  resolveSubscriptionSnapshot,
} from '@allrice/contracts';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import { prepareEmployeeInstanceSnapshot } from './employees/employee-instances.ts';
import {
  seedHistoricalExperienceSource,
  seedHistoricalExperienceRule,
  seedHistoricalExperienceOccurrence,
  seedHistoricalExperienceReceipt,
  seedHistoricalExperienceValidation,
} from './experience-history.fixture.ts';
import {
  syncExperienceAdoptions,
  reassessReportStyleAdoption,
} from './experience-adoption.ts';
import {
  syncExperienceValidations,
  experienceValidationStillCurrent,
} from './experience-validation.ts';
import {
  dispatchExperienceOccurrence,
  recoverExperienceOccurrences,
  getExperienceExecution,
  prepareExperienceExecution,
} from './experience-consolidation.ts';
import {
  enqueueExperienceConsolidationRun,
  completeJob,
  failJob,
} from './execution/queue.ts';
import {
  claimNextPlatformEmployeeTestRun,
  completePlatformEmployeeTestRun,
} from './employees/platform-employees.ts';
import { loadPlatformContentCatalog } from './platform-content/catalog.ts';
import { synchronizePlatformContent } from './platform-content/sync.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import {
  recordRouteDecision,
  completeRouteDecision,
} from './execution/route-decision.ts';
import { freezeRouteSubscriptionSnapshot } from './execution/route-subscription.ts';
import { providerSnapshotForModelTarget } from '../../../apps/worker/src/routing/provider-snapshot.ts';
import { attendanceAnswer } from './experience-validation.fixture.ts';
import * as client from './core/client.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'M5-A old jobs, receipts and validation fees — isolated SQL, no model',
  () => {
    let host: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
    beforeEach(async () => {
      vi.stubEnv('ALLRICE_EXPERIENCE_REVIEW_ENABLED', '1');
      vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '1');
      vi.stubEnv('ALLRICE_NATIVE_CALENDAR_ENABLED', '1');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', 'sha256:' + 'a'.repeat(64));
      host = await createP27CodexWorkerFixture({
        allowCiDatabase: true,
        personalProfile: 'writable',
      });
      vi.spyOn(client, 'getDatabase').mockReturnValue(host.db);
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        Error('No provider/network in retirement SQL tests'),
      );
      await synchronizePlatformContent(await loadPlatformContentCatalog());
    }, 120000);
    afterEach(async () => {
      try {
        await host?.close();
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    }, 30000);
    async function historical() {
      const db = host.db,
        f = await createExperienceFixture(db, { published: true });
      const [er] =
        await db`select * from allrice_employee_runs where run_id=${f.run}`;
      const instance = await prepareEmployeeInstanceSnapshot(
        f.owner,
        f.session.id,
        er!.employee_assignment_id,
        er!.employee_version_id,
      );
      await db`update allrice_employee_runs set execution_snapshot=${db.json({ instance, personalSkills: { skills: [] } })} where run_id=${f.run}`;
      const sourceId = await seedHistoricalExperienceSource(db, f.run);
      const rule = await seedHistoricalExperienceRule(db, f.run);
      const h = await seedHistoricalExperienceOccurrence(db, f.run, rule.id);
      const output = {
        schemaVersion: 1 as const,
        drafts: [
          {
            sourceIds: [sourceId],
            rule: '统计到场情况时，依据原始名单分别核对到场和未到人数，并在结果中分项列出。',
            reason: 'Synthetic historical evidence',
            applicability:
              '适用于有原始名单且到场状态明确的人员统计任务，不适用于缺少名单或状态不明时推算人数。',
            confidence: 'tentative' as const,
            validation: {
              kind: 'calculation' as const,
              check: 'Synthetic independent case',
            },
          },
        ],
        discarded: [],
      };
      return { ...f, ...h, output, sourceId, rule };
    }
    async function route(
      f: Awaited<ReturnType<typeof historical>>,
      runId: string,
      model: typeof f.frozen.execution.model,
    ) {
      const decision = await recordRouteDecision(
        RouteDecisionSchema.parse({
          schemaVersion: 1,
          id: randomUUID(),
          runId,
          organizationId: f.org,
          workspaceId: f.workspace,
          actorId: f.user,
          employeeId: f.frozen.occurrence.employeeId,
          inputChecksum: runtimePolicyDigest(model),
          candidates: [],
          selectedKind: 'direct',
          selectedCandidateId: null,
          harness: model.harness,
          provider: model.provider,
          model: model.model,
          modelConnectionId: model.connectionId,
          modelCatalogEntryId: model.modelCatalogEntryId,
          modelPolicyRevision: model.policyRevision,
          generation: 0,
          attempt: 1,
          reasonCodes: ['minimum_necessary_capability'],
          createdAt: new Date().toISOString(),
        }),
      );
      const subscription = resolveSubscriptionSnapshot({
        occurrenceId: model.occurrenceId,
        modelSnapshot: model,
        decision,
        providerSnapshot: providerSnapshotForModelTarget(model),
      })!;
      await freezeRouteSubscriptionSnapshot({
        organizationId: f.org,
        workspaceId: f.workspace,
        decisionId: decision.id,
        snapshot: subscription,
      });
      return decision;
    }
    it('cannot replay a retained occurrence, enqueue it directly, validate or adopt its retained receipt', async () => {
      const f = await historical(),
        db = host.db;
      await seedHistoricalExperienceReceipt(db, f.row.id, f.output);
      const snapshot = async () => ({
        occurrence: (
          await db`select to_jsonb(r) data from allrice_automation_runs r where id=${f.row.id}`
        )[0]!.data,
        reviews:
          await db`select to_jsonb(e) data from allrice_experience_reviews e where owner_id=${f.user} order by memory_id`,
        audits:
          await db`select to_jsonb(a) data from allrice_audit_events a where organization_id=${f.org} order by id`,
      });
      const before = await snapshot();
      expect(await recoverExperienceOccurrences()).toEqual([]);
      await dispatchExperienceOccurrence(f.row.id);
      for (const call of [
        () => prepareExperienceExecution(f.row.id),
        () => getExperienceExecution(f.row.run_id),
        () => enqueueExperienceConsolidationRun(f.row.id),
      ])
        await expect(call()).rejects.toMatchObject({ code: 'disabled' });
      await syncExperienceValidations();
      await syncExperienceAdoptions();
      await expect(
        reassessReportStyleAdoption(f.owner, {
          occurrenceId: f.row.id,
          draftIndex: 0,
          expectedOutputDigest: runtimePolicyDigest(f.output),
          expectedPlanDigest: runtimePolicyDigest([]),
        }),
      ).rejects.toMatchObject({ code: 'disabled' });
      expect(await snapshot()).toEqual(before);
      expect(
        await db`select id from allrice_platform_employee_test_runs where experience_binding->>'occurrenceId'=${f.row.id}`,
      ).toHaveLength(0);
      expect(
        await db`select id from allrice_jobs where owner_id=${f.user}`,
      ).toHaveLength(0);
    });
    it('rejects an old queued validation through the existing failure finalizer without creating a model Run', async () => {
      const f = await historical(),
        db = host.db;
      await seedHistoricalExperienceReceipt(db, f.row.id, f.output);
      const test = await seedHistoricalExperienceValidation(
        db,
        f.row.id,
        'queued',
      );
      const before =
        await db`select id from allrice_runs where organization_id=${f.org} order by id`;
      expect(await claimNextPlatformEmployeeTestRun(randomUUID())).toBeNull();
      const [saved] =
        await db`select status,experience_assertion,experience_run_id,output from allrice_platform_employee_test_runs where id=${test.testId}`;
      expect(saved).toMatchObject({
        status: 'failed',
        experience_run_id: null,
        experience_assertion: { passed: false },
        output: { error: { code: 'TEST_ENVIRONMENT_UNAVAILABLE' } },
      });
      expect(
        await db`select id from allrice_runs where organization_id=${f.org} order by id`,
      ).toEqual(before);
    });
    it.each([true, false])(
      'keeps settled usage (known=%s) when an old consolidation completion is rejected, then uses existing failure',
      async (known) => {
        const f = await historical(),
          db = host.db,
          runId = f.row.run_id as string;
        const lease = {
          jobId: randomUUID(),
          workerId: randomUUID(),
          leaseToken: randomUUID(),
        };
        await db`update allrice_runs set state='running' where id=${runId}`;
        await db`update allrice_automation_runs set status='running',completed_at=null where id=${f.row.id}`;
        await db`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at,attempt,max_attempts)
   values(${lease.jobId},${f.org},${f.workspace},${f.user},${runId},'running',${randomUUID()},clock_timestamp()+interval '5 minutes',
    ${db.json({ schemaVersion: 1, type: 'allrice.experience.consolidate', input: { occurrenceId: f.row.id } })},${lease.workerId},${lease.leaseToken},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '5 minutes',1,1)`;
        const decision = await route(f, runId, f.frozen.execution.model);
        await completeRouteDecision({
          organizationId: f.org,
          workspaceId: f.workspace,
          outcome: {
            decisionId: decision.id,
            status: 'succeeded',
            inputTokens: known ? 30 : 0,
            cachedInputTokens: 0,
            outputTokens: known ? 10 : 0,
            costCents: null,
            usageComplete: known,
            cacheUsageKnown: known,
            errorCode: null,
            completedAt: new Date().toISOString(),
          },
        });
        const ledger =
          await db`select to_jsonb(l) data from allrice_model_usage_ledger l where route_decision_id=${decision.id}`;
        expect(ledger).toHaveLength(1);
        await expect(
          completeJob({ ...lease, result: f.output }),
        ).rejects.toMatchObject({ code: 'disabled' });
        await expect(
          failJob({
            ...lease,
            code: 'EXPERIENCE_CONSOLIDATION_FAILED',
            message: 'Synthetic retired consumer',
            retryable: false,
          }),
        ).resolves.toMatchObject({ retrying: false });
        expect(
          (
            await db`select status from allrice_jobs where id=${lease.jobId}`
          )[0]!.status,
        ).toBe('failed');
        expect(
          (await db`select state from allrice_runs where id=${runId}`)[0]!
            .state,
        ).toBe('failed');
        expect(
          (
            await db`select experience_receipt from allrice_automation_runs where id=${f.row.id}`
          )[0]!.experience_receipt,
        ).toBeNull();
        expect(
          await db`select to_jsonb(l) data from allrice_model_usage_ledger l where route_decision_id=${decision.id}`,
        ).toEqual(ledger);
      },
    );
    it.each(['succeeded', 'failed', 'canceled'] as const)(
      'settles a late validation %s without a passing proof or adoption',
      async (status) => {
        const f = await historical(),
          db = host.db;
        await seedHistoricalExperienceReceipt(db, f.row.id, f.output);
        const test = await seedHistoricalExperienceValidation(
          db,
          f.row.id,
          'running',
        );
        const decision = await route(f, test.validationRun, test.binding.model);
        await db`update allrice_platform_employee_test_runs set experience_route_id=${decision.id} where id=${test.testId}`;
        expect(
          await experienceValidationStillCurrent(test.testId, {
            runId: test.validationRun,
            jobId: randomUUID(),
            workerId: randomUUID(),
            leaseToken: randomUUID(),
          }),
        ).toBe(false);
        const error =
          status === 'succeeded'
            ? null
            : {
                code:
                  status === 'canceled' ? 'TEST_CANCELED' : 'SYNTHETIC_FAILURE',
                message: 'Synthetic late result',
              };
        // The public finalizer determines actual outcome from error/cancellation. A
        // canceled synthetic execution has the same existing stop evidence as before.
        await db`update allrice_runs set execution_spec=${db.json({ platformEmployeeTestRunId: test.testId })} where id=${test.validationRun}`;
        await db`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,cancel_requested_at)
          values(${randomUUID()},${f.org},${f.workspace},${f.user},${test.validationRun},'running',${randomUUID()},clock_timestamp()+interval '5 minutes',
            ${db.json({ schemaVersion: 1, type: 'allrice.platform_employee.test', input: { testRunId: test.testId } })},${status === 'canceled' ? new Date() : null})`;
        await completePlatformEmployeeTestRun(test.testId, {
          answer: JSON.stringify(attendanceAnswer),
          provider: test.binding.model.provider,
          model: test.binding.model.model,
          threadId: null,
          usage: { inputTokens: 100, outputTokens: 120, cachedInputTokens: 0 },
          events: [],
          error,
          modelExecution: {
            dispatched: true,
            subscriptionSnapshotCreated: true,
            usageComplete: true,
            cacheUsageKnown: true,
            costCents: null,
          },
        });
        const [saved] =
          await db`select status,experience_assertion from allrice_platform_employee_test_runs where id=${test.testId}`;
        expect(saved!.status).toBe(status);
        expect(saved!.experience_assertion).toMatchObject({
          passed: false,
          reason: 'authority_changed',
        });
        const [ledger] =
          await db`select * from allrice_model_usage_ledger where route_decision_id=${decision.id}`;
        expect(Number(ledger!.input_tokens)).toBe(100);
        expect(Number(ledger!.output_tokens)).toBe(120);
        expect(ledger!.cost_cents).toBeNull();
        await syncExperienceAdoptions();
        expect(
          await db`select memory_id from allrice_experience_reviews where owner_id=${f.user} and origin_kind='derived'`,
        ).toHaveLength(0);
      },
    );
  },
);
