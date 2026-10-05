/** Real isolated PostgreSQL authority/queue checks; no physical or paid-model claims. */
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorageAdapter } from '@allrice/storage';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PlatformEmployeeDefinitionSchema,
  PlatformEmployeeRuntimeProfileSchema,
  type RequestContext,
} from '@allrice/contracts';
import * as client from './core/client.ts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from './assistant-runtime.fixture.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import { ensureBootstrapPortalPrincipal } from './identity.ts';
import { executionRequestConstraints } from './browser-execution-choice.ts';
import { buildEmployeeRuntimePackage } from './platform-employees/runtime-package.ts';
import {
  createPlatformQualityCheck,
  getPlatformQualityCheck,
  cancelPlatformQualityCheck,
  getPlatformQualityExecution,
  recordPlatformQualityReport,
  admitQualityEnqueue,
  isPlatformQualityJobAuthorized,
  isPlatformQualityServiceAuthorized,
  platformQualityCompletionAllowed,
} from './platform-quality.ts';
import type { JobRow } from './queue/row-mappers.ts';
import * as queue from './execution/queue.ts';
import {
  updatePlatformQualitySchedule,
  getPlatformQualitySchedule,
  deletePlatformQualitySchedule,
  claimPlatformQualityOccurrence,
  dispatchPlatformQualityOccurrence,
  recoverPlatformQualityOccurrences,
  qualityOccurrenceRequestId,
} from './platform-quality-automation.ts';
import {
  claimDueAutomations,
  createAutomation,
  listAutomations,
  runAutomationNow,
  nextScheduleAt,
} from './execution/automation.ts';
import {
  claimNextJob,
  startClaimedJob,
  completeJob,
  heartbeatJob,
  enqueueRun,
} from './execution/queue.ts';
import { prepareEmployeeRunBinding } from './employees/employeehub.ts';
import {
  qualityDigest,
  qualityFixture,
  qualityAssertion,
  qualityCaseSpec,
} from './platform-quality-case.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'MET167 fixed project checks: private real employee Run and current authority',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
      company: Awaited<ReturnType<typeof createExperienceFixture>>,
      admin: RequestContext,
      adminEmail: string;
    beforeAll(async () => {
      fixture = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      company = await createExperienceFixture(fixture.db);
      const account = await ensureBootstrapPortalPrincipal({
        organizationSlug: 'allrice-platform',
        organizationName: 'Internal',
        workspaceSlug: 'control-plane',
        workspaceName: 'Internal',
        email: 'quality-admin@example.test',
        displayName: 'Quality admin',
        role: 'member',
      });
      await fixture.db`delete from allrice_memberships where user_id=${account.user.id}`;
      admin = {
        ...company.owner,
        actor: { type: 'user', id: account.user.id },
        workspaceId: null,
        memberships: [],
      };
      adminEmail = account.user.email;
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', adminEmail);
      vi.stubEnv('ALLRICE_ENV', 'development');
      vi.stubEnv('ALLRICE_RELEASE_SHA', 'a'.repeat(40));
      for (const f of [
        'RUNTIME_POLICY',
        'BRIDGE_OPERATION_LEDGER',
        'LOCAL_COMMAND',
        'CLOUD_RUNNER',
        'BROWSER_CONTROL',
        'WORKBENCH',
      ])
        vi.stubEnv(`ALLRICE_${f}_ENABLED`, '1');
      await fixture.db`update allrice_model_connections set status='ready' where id='52000000-0000-4000-8000-000000000001'`;
      await fixture.db`update allrice_model_providers set enabled=true where provider_key='codex'`;
      // The dedicated schema owns this synthetic published package; production
      // admission always uses its unmodified current published employee.
      const [r] =
        await fixture.db`select r.* from allrice_platform_employee_revisions r join allrice_platform_employees e on e.current_published_revision_id=r.id where e.employee_key='rice'`;
      const definition = PlatformEmployeeDefinitionSchema.parse({
        ...r!.definition,
        capabilities: {
          ...r!.definition.capabilities,
          nativeSkillIds: [],
          toolNames: [
            'workspace.project',
            'browser.workspace',
            'cloud.process.execute',
          ],
        },
      });
      const runtimePackage = buildEmployeeRuntimePackage({
        revision: r!.revision,
        definition,
        skills: [],
      });
      const profile = PlatformEmployeeRuntimeProfileSchema.parse({
        ...r!.runtime_profile,
        toolNames: definition.capabilities.toolNames,
        nativeSkillIds: [],
        nativeSkillChecksums: [],
        runtimePackage,
      });
      await fixture.db`update allrice_platform_employee_revisions set definition=${fixture.db.json(definition)},runtime_profile=${fixture.db.json(profile)},checksum=${runtimePackage.checksum},status='published',published_at=now() where id=${r!.id}`;
      await fixture.db`update allrice_platform_employees set status='published' where id=${r!.employee_id}`;
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
    });
    const submit = (
      variant: 'defect' | 'correct' = 'defect',
      requestId = randomUUID(),
    ) =>
      createPlatformQualityCheck(admin, {
        requestId,
        caseId: 'project.static.v1',
        variant,
      });
    async function start(q: Awaited<ReturnType<typeof submit>>) {
      const workerId = randomUUID(),
        job = await claimNextJob(workerId, 30000);
      expect(job?.id).toBe(q.jobId);
      const lease = {
        workerId,
        jobId: job!.id,
        leaseToken: job!.lease!.token,
        attempt: job!.attempt,
      };
      await startClaimedJob(workerId, job!.id, lease.leaseToken);
      return lease;
    }
    it('concurrent identical requests produce one real private employee Run, preserving company rows and frozen pins', async () => {
      const before =
        await fixture.db`select * from allrice_memberships where organization_id=${company.org}`;
      const requestId = randomUUID(),
        [a, b] = await Promise.all([
          submit('defect', requestId),
          submit('defect', requestId),
        ]);
      expect(a.runId).toBe(b.runId);
      expect(a.fixtureDigest).toBe(
        qualityDigest(qualityFixture('defect').files),
      );
      expect(a.assertionDigest).toBe(qualityDigest(qualityAssertion));
      const [e] =
        await fixture.db`select e.*,o.slug organization_slug,j.max_attempts from allrice_employee_runs e join allrice_organizations o on o.id=e.organization_id join allrice_jobs j on j.run_id=e.run_id where e.run_id=${a.runId}`;
      expect(e!.organization_slug).toBe('allrice-platform');
      expect(e!.owner_id).toBe(admin.actor.id);
      expect(e!.max_attempts).toBe(1);
      expect(e!.execution_snapshot.taskRuntimePolicy.timeoutMs).toBe(300000);
      expect(
        await fixture.db`select * from allrice_memberships where organization_id=${company.org}`,
      ).toEqual(before);
      vi.stubEnv('ALLRICE_RELEASE_SHA', 'b'.repeat(40));
      expect((await submit('defect', requestId)).releaseSha).toBe(
        'a'.repeat(40),
      );
      vi.stubEnv('ALLRICE_RELEASE_SHA', 'a'.repeat(40));
      await expect(submit('correct', requestId)).rejects.toThrow('conflict');
      await cancelPlatformQualityCheck(admin, a.id);
    });
    it('ordinary employees and another platform administrator cannot read, cancel, or submit someone else’s private check', async () => {
      const q = await submit();
      await expect(
        getPlatformQualityCheck(company.owner, q.id),
      ).rejects.toThrow('authorization_denied');
      await expect(
        createPlatformQualityCheck(company.owner, {
          requestId: randomUUID(),
          caseId: 'project.static.v1',
          variant: 'correct',
        }),
      ).rejects.toThrow('authorization_denied');
      const [other] =
        await fixture.db`select email from allrice_users where id=${company.neighbor.actor.id}`;
      vi.stubEnv(
        'ALLRICE_PLATFORM_ADMIN_EMAILS',
        adminEmail + ',' + other!.email,
      );
      await expect(
        getPlatformQualityCheck(company.neighbor, q.id),
      ).rejects.toThrow('not_found');
      await expect(
        cancelPlatformQualityCheck(company.neighbor, q.id),
      ).rejects.toThrow('not_found');
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', adminEmail);
      await cancelPlatformQualityCheck(admin, q.id);
    });
    it('concurrent different samples sharing a request ID conflict rather than silently using the other sample', async () => {
      const requestId = randomUUID();
      const results = await Promise.allSettled([
        submit('defect', requestId),
        submit('correct', requestId),
      ]);
      const success = results.filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof submit>>> =>
          r.status === 'fulfilled',
      );
      expect(success).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({
        reason: { message: 'conflict' },
      });
      const q = success[0]!.value;
      const rows =
        await fixture.db`select q.frozen,q.input_digest,j.payload from allrice_platform_quality_checks q join allrice_jobs j on j.id=q.job_id where q.request_id=${requestId}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.frozen.variant).toBe(q.variant);
      expect(rows[0]!.payload.input.qualityInputDigest).toBe(
        rows[0]!.input_digest,
      );
      expect(rows[0]!.input_digest).toBe(
        qualityDigest({ requestId, caseId: q.caseId, variant: q.variant }),
      );
      await cancelPlatformQualityCheck(admin, q.id);
    });
    it.skipIf(process.env.ALLRICE_RUN_QUALITY_NATIVE !== '1')(
      'real fixed cloud project: build, source ZIP, browser assertion, stored bytes and canonical completion',
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'allrice-quality-native-'));
        const previousStorage = process.env.ALLRICE_STORAGE_ROOT;
        vi.stubEnv('ALLRICE_STORAGE_ROOT', join(root, 'storage'));
        try {
          const { refreshManagedCloudEnvironments } =
            await import('../../../apps/worker/src/managed-cloud-environments.js');
          const { runClaimedJob } =
            await import('../../../apps/worker/src/job-runner.js');
          const { executeEmployeeRun } =
            await import('../../../apps/worker/src/jobs/employee-run.js');
          expect(await refreshManagedCloudEnvironments(randomUUID())).toEqual({
            compute: true,
            browser: true,
          });
          for (const [variant, cancelAfterReport] of [
            ['defect', false],
            ['correct', true],
            ['correct', false],
          ] as const) {
            const q = await submit(variant),
              workerId = randomUUID(),
              job = await claimNextJob(workerId, 30000);
            expect(job?.id).toBe(q.jobId);
            await runClaimedJob(
              {
                workerId,
                jobId: q.jobId,
                leaseToken: job!.lease!.token,
                leaseMs: 30000,
                heartbeatMs: 1000,
                executionRoot: join(root, 'execution'),
                stopping: () => false,
                onAbortReady: () => {},
              },
              async (handler) => {
                const result = await executeEmployeeRun(handler);
                const pending = await getPlatformQualityCheck(admin, q.id);
                expect(pending).toMatchObject({
                  status: 'running',
                  accepted: false,
                });
                if (cancelAfterReport) {
                  const report = pending.report!,
                    storage = new LocalStorageAdapter(join(root, 'storage'));
                  const lease = {
                    workerId,
                    jobId: q.jobId,
                    leaseToken: job!.lease!.token,
                    attempt: job!.attempt,
                  };
                  const write = (value: unknown) =>
                    recordPlatformQualityReport(lease, value, storage);
                  await expect(
                    write({
                      ...report,
                      build: { ...report.build!, location: 'local' },
                    }),
                  ).rejects.toThrow('authorization_denied');
                  await expect(
                    write({
                      ...report,
                      build: { ...report.build!, operationId: randomUUID() },
                    }),
                  ).rejects.toThrow('authorization_denied');
                  await expect(
                    write({
                      ...report,
                      project: {
                        ...report.project!,
                        snapshot: {
                          ...report.project!.snapshot,
                          id: randomUUID(),
                        },
                      },
                    }),
                  ).rejects.toThrow();
                  const page = report.artifacts.find((a) => a.kind === 'page')!;
                  // Existing immutable provenance is itself an enforced boundary;
                  // do not disable its trigger to fabricate physical evidence.
                  await expect(
                    fixture.db`update allrice_workbench_artifacts set provenance=jsonb_set(provenance,'{operationId}',${fixture.db.json(randomUUID())}) where version_id=${page.versionId}`,
                  ).rejects.toThrow('immutable');
                  await expect(
                    write({
                      ...report,
                      browser: {
                        ...report.browser!,
                        report: {
                          ...report.browser!.report,
                          target: {
                            ...report.browser!.report.target,
                            sourceOperationId: randomUUID(),
                          },
                        },
                      },
                    }),
                  ).rejects.toThrow('authorization_denied');
                  await expect(
                    write({
                      ...report,
                      build: { ...report.build!, exitCode: 1 },
                    }),
                  ).rejects.toThrow();
                  await expect(
                    write({
                      ...report,
                      build: { ...report.build!, command: 'node other.mjs' },
                    }),
                  ).rejects.toThrow();
                  await expect(
                    write({ ...report, cleanup: 'unknown' }),
                  ).rejects.toThrow();
                  await write(report);
                  await cancelPlatformQualityCheck(admin, q.id);
                }
                return result;
              },
            );
            const actual = await getPlatformQualityCheck(admin, q.id);
            expect(
              actual,
              JSON.stringify({ runId: q.runId, report: actual.report }),
            ).toMatchObject({
              status: cancelAfterReport ? 'canceled' : 'succeeded',
              accepted: variant === 'correct' && !cancelAfterReport,
              modelUsed: false,
              report: {
                verdict: variant === 'correct' ? 'passed' : 'assertion_failed',
                cleanup: 'confirmed',
                build: { location: 'cloud', exitCode: 0 },
              },
            });
            expect(actual.report!.artifacts.map((a) => a.kind)).toEqual(
              expect.arrayContaining([
                'source',
                'page',
                'screenshot',
                'report',
              ]),
            );
            const [count] =
              await fixture.db`select count(*)::int n from allrice_run_events where run_id=${q.runId} and event_type='harness.llm.call.started'`;
            expect(count!.n).toBe(0);
          }
        } finally {
          if (previousStorage === undefined)
            delete process.env.ALLRICE_STORAGE_ROOT;
          else process.env.ALLRICE_STORAGE_ROOT = previousStorage;
          await rm(root, { recursive: true, force: true });
        }
      },
      180000,
    );
    it('generic chat submission cannot use the reserved quality assignment without a server binding', async () => {
      const q = await submit();
      const [row] =
        await fixture.db`select q.organization_id,q.workspace_id,e.* from allrice_platform_quality_checks q join allrice_employee_runs e on e.run_id=q.run_id where q.id=${q.id}`;
      const ctx = {
        ...admin,
        organizationId: row!.organization_id,
        workspaceId: row!.workspace_id,
      };
      const binding = await prepareEmployeeRunBinding({
        context: ctx,
        workspaceId: ctx.workspaceId,
        assignmentId: row!.employee_assignment_id,
        employeeVersionId: row!.employee_version_id,
        sessionId: q.sessionId,
        userMessageId: row!.user_message_id,
        assistantMessageId: row!.assistant_message_id,
        promptSnapshot: row!.prompt_snapshot,
      });
      await expect(
        enqueueRun(
          ctx,
          {
            type: 'allrice.employee.run',
            workspaceId: ctx.workspaceId,
            idempotencyKey: randomUUID(),
            input: {},
            timeoutMs: 300000,
          },
          { employeeBinding: binding },
        ),
      ).rejects.toThrow('authorization_denied');
      await cancelPlatformQualityCheck(admin, q.id);
    });
    it('reserved assignments remain reserved when workspace identity changes; broken QA migrations fail closed', async () => {
      const q = await submit();
      await fixture.db.begin(async (tx) => {
        const [job] = await tx<
          JobRow[]
        >`select * from allrice_jobs where id=${q.jobId}`;
        const [d] =
          await tx`select * from allrice_platform_quality_deployments where owner_id=${admin.actor.id}`;
        const [workspace] =
          await tx`select slug from allrice_workspaces where id=${d!.workspace_id}`;
        const ordinary = {
          ...job!,
          payload: { type: 'allrice.employee.run', input: {} },
        };
        const context = {
          ...admin,
          organizationId: d!.organization_id,
          workspaceId: d!.workspace_id,
        };
        for (const slug of [
          'reclassified-qa',
          `employee-tests-${randomUUID()}`,
        ]) {
          await tx`update allrice_workspaces set slug=${slug} where id=${d!.workspace_id}`;
          await expect(
            admitQualityEnqueue(tx, context, d!.assignment_id),
          ).rejects.toThrow('authorization_denied');
          expect(await isPlatformQualityJobAuthorized(tx, ordinary)).toBe(
            false,
          );
          expect(await platformQualityCompletionAllowed(tx, ordinary)).toBe(
            false,
          );
          expect(await isPlatformQualityJobAuthorized(tx, job!)).toBe(false);
        }
        await tx`update allrice_workspaces set slug=${workspace!.slug} where id=${d!.workspace_id}`;
        await tx`alter table allrice_platform_quality_checks rename to qa_checks_absent_fixture`;
        await expect(
          isPlatformQualityJobAuthorized(tx, ordinary),
        ).rejects.toThrow('policy_denied');
        await tx`alter table allrice_platform_quality_deployments rename to qa_deployments_absent_fixture`;
        await tx`create table allrice_schema_migrations (name text primary key)`;
        await tx`insert into allrice_schema_migrations (name) values ('0141_platform_quality_checks.sql')`;
        await expect(
          isPlatformQualityJobAuthorized(tx, ordinary),
        ).rejects.toThrow('policy_denied');
        await tx`drop table allrice_schema_migrations`;
        await tx`alter table qa_deployments_absent_fixture rename to allrice_platform_quality_deployments`;
        await tx`alter table qa_checks_absent_fixture rename to allrice_platform_quality_checks`;
      });
      await cancelPlatformQualityCheck(admin, q.id);
    });
    it('a reserved preview retains current platform authority after the Job ends', async () => {
      const q = await submit();
      const [row] =
        await fixture.db`select * from allrice_platform_quality_checks where id=${q.id}`;
      const service = {
        run_id: q.runId,
        owner_id: admin.actor.id,
        organization_id: row!.organization_id as string,
        workspace_id: row!.workspace_id as string,
      };
      await fixture.db.begin(async (tx) => {
        // Synthetic terminal state checks authority only, not physical readiness.
        await tx`update allrice_runs set state='succeeded' where id=${q.runId}`;
        expect(await isPlatformQualityServiceAuthorized(tx, service)).toBe(
          true,
        );
        vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', 'nobody@example.test');
        expect(await isPlatformQualityServiceAuthorized(tx, service)).toBe(
          false,
        );
        vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', adminEmail);
        expect(
          await isPlatformQualityServiceAuthorized(tx, {
            ...service,
            owner_id: company.owner.actor.id,
          }),
        ).toBe(false);
        await tx`update allrice_employee_assignments set selection_mode='exclude' where id=${row!.frozen.assignmentId}`;
        expect(await isPlatformQualityServiceAuthorized(tx, service)).toBe(
          false,
        );
        await tx`update allrice_employee_assignments set selection_mode='include' where id=${row!.frozen.assignmentId}`;
        const [workspace] =
          await tx`select slug from allrice_workspaces where id=${service.workspace_id}`;
        await tx`update allrice_workspaces set slug='renamed-quality-service' where id=${service.workspace_id}`;
        expect(await isPlatformQualityServiceAuthorized(tx, service)).toBe(
          false,
        );
        await tx`update allrice_workspaces set slug=${workspace!.slug} where id=${service.workspace_id}`;
        await tx`update allrice_runs set state='queued' where id=${q.runId}`;
      });
      await cancelPlatformQualityCheck(admin, q.id);
    });
    it('live admission freezes its actual login session, case and dependency versions; logout ends authority', async () => {
      const request = {
        requestId: randomUUID(),
        caseId: 'project.live.v1',
        variant: 'correct',
      };
      await expect(
        createPlatformQualityCheck(
          { ...admin, sessionId: randomUUID() },
          request,
        ),
      ).rejects.toThrow('authorization_denied');
      const loginId = randomUUID();
      await fixture.db`insert into allrice_sessions(id,user_id,token_hash,expires_at)
        values(${loginId},${admin.actor.id},${createHash('sha256').update(loginId).digest('hex')},clock_timestamp()+interval '1 hour')`;
      const liveAdmin = { ...admin, sessionId: loginId };
      const q = await createPlatformQualityCheck(liveAdmin, request);
      expect(q.caseId).toBe('project.live.v1');
      expect(q.fixtureDigest).toBe(
        qualityDigest(qualityCaseSpec('project.live.v1', 'correct').files),
      );
      expect(q.assertionDigest).toBe(
        qualityDigest(qualityCaseSpec('project.live.v1', 'correct').assertion),
      );
      const lease = await start(q);
      const execution = await getPlatformQualityExecution(lease);
      expect(execution.frozen.loginSessionId).toBe(loginId);
      expect(execution.frozen.loginAuthenticatedAt).toBe(admin.authenticatedAt);
      const [message] =
        await fixture.db`select content from allrice_messages where id=${execution.frozen.userMessageId}`;
      expect(executionRequestConstraints(message!.content.text)).toEqual({
        location: 'cloud',
        localOnly: false,
      });
      await fixture.db`update allrice_sessions set revoked_at=clock_timestamp() where id=${loginId}`;
      await expect(getPlatformQualityExecution(lease)).rejects.toThrow(
        'authorization_denied',
      );
      expect(
        (
          await heartbeatJob(
            lease.workerId,
            lease.jobId,
            lease.leaseToken,
            30000,
          )
        ).active,
      ).toBe(false);
      expect((await getPlatformQualityCheck(admin, q.id)).status).toBe(
        'failed',
      );
    });
    it('no report or caller-supplied “passed” result can complete a quality Run', async () => {
      const q = await submit(),
        lease = await start(q);
      await getPlatformQualityExecution(lease);
      await completeJob({
        ...lease,
        result: { verdict: 'passed', answer: 'Everything passed' },
      });
      expect((await getPlatformQualityCheck(admin, q.id)).status).toBe(
        'failed',
      );
      expect((await getPlatformQualityCheck(admin, q.id)).report).toBeNull();
      await expect(
        recordPlatformQualityReport(
          lease,
          {
            version: 1,
            verdict: 'passed',
            completedAt: new Date().toISOString(),
            project: null,
            build: null,
            artifacts: [],
            browser: null,
            errorCode: null,
            cleanup: 'confirmed',
          },
          assistantFixtureStorage(fixture.db),
        ),
      ).rejects.toThrow();
    });
    it('revocation during execution fails the original Run and rejects a late report', async () => {
      const q = await submit(),
        lease = await start(q);
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', 'nobody@example.test');
      expect(
        (
          await heartbeatJob(
            lease.workerId,
            lease.jobId,
            lease.leaseToken,
            30000,
          )
        ).active,
      ).toBe(false);
      await expect(getPlatformQualityExecution(lease)).rejects.toThrow(
        'authorization_denied',
      );
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', adminEmail);
      expect((await getPlatformQualityCheck(admin, q.id)).status).toBe(
        'failed',
      );
    });
    it('cancel and hard wall deadline cannot be converted into success', async () => {
      const canceled = await submit(),
        a = await start(canceled);
      await cancelPlatformQualityCheck(admin, canceled.id);
      await completeJob({ ...a, result: { answer: 'done' } });
      expect((await getPlatformQualityCheck(admin, canceled.id)).status).toBe(
        'canceled',
      );
      const expired = await submit(),
        b = await start(expired);
      await fixture.db`update allrice_platform_quality_checks set created_at=now()-interval '6 minutes' where id=${expired.id}`;
      await completeJob({ ...b, result: { answer: 'done' } });
      expect((await getPlatformQualityCheck(admin, expired.id)).status).toBe(
        'failed',
      );
    });
    async function freshSchedule() {
      const loginId = randomUUID();
      await fixture.db`insert into allrice_sessions(id,user_id,token_hash,expires_at)
        values(${loginId},${admin.actor.id},${createHash('sha256').update(loginId).digest('hex')},clock_timestamp()+interval '1 hour')`;
      const context = { ...admin, sessionId: loginId };
      const previous = await getPlatformQualitySchedule(context);
      if (previous.schedule)
        await deletePlatformQualitySchedule(context, {
          expectedRevision: previous.schedule.revision,
        });
      const view = await updatePlatformQualitySchedule(context, {
        expectedRevision: 0,
        enabled: true,
        time: '09:00',
      });
      return { context, rule: view.schedule! };
    }
    async function due(id: string, age = '1 second') {
      await fixture.db`update allrice_automations set next_run_at=clock_timestamp()-${age}::interval where id=${id}`;
    }
    async function claimOnly(id: string) {
      return fixture.db.begin(async (tx) => {
        const [rule] =
          await tx`select * from allrice_automations where id=${id} for update`;
        // SQL rows here deliberately exercise the persisted scheduler contract.
        return claimPlatformQualityOccurrence(
          tx,
          rule as Parameters<typeof claimPlatformQualityOccurrence>[1],
          nextScheduleAt(rule!.schedule),
        );
      });
    }
    async function occurrence(id: string) {
      const [row] =
        await fixture.db`select r.*,q.id check_id,q.run_id quality_run_id,q.session_id quality_session_id,q.frozen,j.id job_id
        from allrice_automation_runs r left join allrice_platform_quality_checks q on q.automation_run_id=r.id
        left join allrice_jobs j on j.id=q.job_id where r.id=${id}`;
      return row!;
    }
    async function stopOccurrence(id: string) {
      const row = await occurrence(id);
      if (row.check_id) await cancelPlatformQualityCheck(admin, row.check_id);
    }
    it('two scheduler ticks admit one private occurrence/Run/Job and keep ordinary automation APIs separate', async () => {
      const { context, rule } = await freshSchedule();
      await due(rule.id);
      await Promise.all([claimDueAutomations(), claimDueAutomations()]);
      const rows =
        await fixture.db`select id from allrice_automation_runs where automation_id=${rule.id}`;
      expect(rows).toHaveLength(1);
      const row = await occurrence(rows[0]!.id);
      expect(row.run_id).toBeTruthy();
      expect(row.quality_run_id).toBe(row.run_id);
      expect(row.quality_session_id).toBe(row.session_id);
      expect(row.frozen.scheduleOrigin.occurrenceId).toBe(row.id);
      expect(row.frozen.requestId).toBe(qualityOccurrenceRequestId(row.id));
      const [e] =
        await fixture.db`select * from allrice_employee_runs where run_id=${row.run_id}`;
      expect(e).toBeTruthy();
      const scoped = {
        ...context,
        organizationId: row.organization_id,
        workspaceId: row.workspace_id,
        memberships: (
          await fixture.db`select * from allrice_memberships where user_id=${admin.actor.id} and organization_id=${row.organization_id} and active`
        ).map((m) => ({
          id: m.id,
          userId: m.user_id,
          organizationId: m.organization_id,
          workspaceId: m.workspace_id,
          role: m.role,
          active: m.active,
        })) as RequestContext['memberships'],
      };
      expect(
        (await listAutomations(scoped, row.workspace_id)).automations.some(
          (a) => a.id === rule.id,
        ),
      ).toBe(false);
      await expect(
        runAutomationNow(scoped, row.workspace_id, rule.id),
      ).rejects.toThrow('not_found');
      await expect(
        createPlatformQualityCheck(admin, {
          requestId: row.frozen.requestId,
          caseId: 'project.static.v1',
          variant: 'correct',
        }),
      ).rejects.toThrow('conflict');
      await stopOccurrence(row.id);
    });
    it('recovers an occurrence committed before enqueue; a rolled-back enqueue and a lost ACK never create duplicate Runs', async () => {
      const { rule } = await freshSchedule();
      await due(rule.id);
      const id = (await claimOnly(rule.id))!;
      const original = queue.enqueueRun;
      await fixture.db
        .unsafe(`create function quality_rollback_fixture() returns trigger language plpgsql as $$ begin
        if new.id='${id}'::uuid and new.run_id is not null then raise exception 'transient binding rollback'; end if; return new; end $$;
        create trigger quality_rollback_fixture before update on allrice_automation_runs for each row execute function quality_rollback_fixture()`);
      try {
        expect(await dispatchPlatformQualityOccurrence(id)).toBe(false);
        expect((await occurrence(id)).run_id).toBeNull();
        expect(
          await fixture.db`select id from allrice_platform_quality_checks where request_id=${qualityOccurrenceRequestId(id)}`,
        ).toHaveLength(0);
        expect(
          await fixture.db`select id from allrice_jobs where idempotency_key=${`platform-quality:${admin.actor.id}:${qualityOccurrenceRequestId(id)}`}`,
        ).toHaveLength(0);
      } finally {
        await fixture.db.unsafe(
          'drop trigger quality_rollback_fixture on allrice_automation_runs; drop function quality_rollback_fixture()',
        );
      }
      const lostAck = vi
        .spyOn(queue, 'enqueueRun')
        .mockImplementationOnce(async (...args) => {
          await original(...args);
          throw Error('lost acknowledgement after commit');
        });
      expect(await recoverPlatformQualityOccurrences()).toBe(1);
      lostAck.mockRestore();
      const committed = await occurrence(id);
      expect(committed.run_id).toBeTruthy();
      expect(await recoverPlatformQualityOccurrences()).toBe(0);
      expect(await dispatchPlatformQualityOccurrence(id)).toBe(false);
      expect(
        await fixture.db`select id from allrice_jobs where run_id=${committed.run_id}`,
      ).toHaveLength(1);
      const canonical = await getPlatformQualityCheck(
        admin,
        committed.check_id,
      );
      vi.stubEnv('ALLRICE_RELEASE_SHA', 'c'.repeat(40));
      expect(
        (await getPlatformQualityCheck(admin, committed.check_id)).fingerprint,
      ).toBe(canonical.fingerprint);
      vi.stubEnv('ALLRICE_RELEASE_SHA', 'a'.repeat(40));
      await stopOccurrence(id);
    });
    it('pause and edits reject unbound old occurrences but do not cancel a bound Run', async () => {
      const { context, rule } = await freshSchedule();
      await due(rule.id);
      const staleId = (await claimOnly(rule.id))!;
      const edited = await updatePlatformQualitySchedule(context, {
        expectedRevision: rule.revision,
        enabled: true,
        time: '10:00',
      });
      expect(await dispatchPlatformQualityOccurrence(staleId)).toBe(false);
      expect((await occurrence(staleId)).error_code).toBe(
        'QUALITY_SCHEDULE_CHANGED',
      );
      await expect(
        updatePlatformQualitySchedule(context, {
          expectedRevision: rule.revision,
          enabled: false,
          time: '09:00',
        }),
      ).rejects.toThrow('conflict');
      await due(rule.id);
      const boundId = (await claimOnly(rule.id))!;
      expect(await dispatchPlatformQualityOccurrence(boundId)).toBe(true);
      const row = await occurrence(boundId),
        lease = await start(await getPlatformQualityCheck(admin, row.check_id));
      const paused = await updatePlatformQualitySchedule(context, {
        expectedRevision: edited.schedule!.revision,
        enabled: false,
        time: '10:00',
      });
      expect(paused.schedule!.nextRunAt).toBeNull();
      expect(
        (await getPlatformQualityExecution(lease)).frozen.scheduleOrigin
          ?.occurrenceId,
      ).toBe(boundId);
      await stopOccurrence(boundId);
    });
    it('concurrent configuration CAS yields one winner; deletion preserves history and prevents recovery', async () => {
      const { context, rule } = await freshSchedule();
      await due(rule.id);
      const id = (await claimOnly(rule.id))!;
      const writes = await Promise.allSettled([
        updatePlatformQualitySchedule(context, {
          expectedRevision: rule.revision,
          enabled: false,
          time: '09:00',
        }),
        deletePlatformQualitySchedule(context, {
          expectedRevision: rule.revision,
        }),
      ]);
      expect(writes.filter((w) => w.status === 'fulfilled')).toHaveLength(1);
      expect(writes.filter((w) => w.status === 'rejected')).toHaveLength(1);
      expect(await dispatchPlatformQualityOccurrence(id)).toBe(false);
      expect((await occurrence(id)).run_id).toBeNull();
      const current = await getPlatformQualitySchedule(context);
      if (current.schedule)
        await deletePlatformQualitySchedule(context, {
          expectedRevision: current.schedule.revision,
        });
      expect(
        (await getPlatformQualitySchedule(context)).occurrences.some(
          (o) => o.id === id && !o.accepted,
        ),
      ).toBe(true);
      expect(
        await fixture.db`select id from allrice_audit_events where resource_id=${rule.id}`,
      ).not.toHaveLength(0);
    });
    it('expired and busy days are explicitly not executed; restart advances to the future without catch-up', async () => {
      const { context, rule } = await freshSchedule();
      await due(rule.id, '2 days');
      expect(await claimOnly(rule.id)).toBeNull();
      const missed = (
        await getPlatformQualitySchedule(context)
      ).occurrences.find(
        (o) => o.notExecutedReason === 'QUALITY_DISPATCH_EXPIRED',
      )!;
      expect(missed.accepted).toBe(false);
      expect(missed.checkId).toBeNull();
      const [future] =
        await fixture.db`select next_run_at from allrice_automations where id=${rule.id}`;
      expect(future!.next_run_at.getTime()).toBeGreaterThan(Date.now());
      await due(rule.id);
      const activeId = (await claimOnly(rule.id))!;
      expect(await dispatchPlatformQualityOccurrence(activeId)).toBe(true);
      await due(rule.id);
      expect(await claimOnly(rule.id)).toBeNull();
      const busy = (await getPlatformQualitySchedule(context)).occurrences.find(
        (o) => o.notExecutedReason === 'QUALITY_BUSY',
      )!;
      expect(busy).toMatchObject({ checkId: null, accepted: false });
      await stopOccurrence(activeId);
    });
    it('requires a real administrator login for configuration but scheduled static dispatch never borrows a login', async () => {
      const { context, rule } = await freshSchedule();
      await expect(
        updatePlatformQualitySchedule(company.owner, {
          expectedRevision: 0,
          enabled: true,
          time: '09:00',
        }),
      ).rejects.toThrow('authorization_denied');
      await expect(
        updatePlatformQualitySchedule(
          { ...context, sessionId: randomUUID() },
          { expectedRevision: rule.revision, enabled: false, time: '09:00' },
        ),
      ).rejects.toThrow('authorization_denied');
      await due(rule.id);
      const id = (await claimOnly(rule.id))!;
      const pending = await occurrence(id);
      await expect(
        createPlatformQualityCheck(
          context,
          {
            requestId: qualityOccurrenceRequestId(id),
            caseId: 'project.live.v1',
            variant: 'correct',
          },
          { scheduleOrigin: pending.quality_occurrence },
        ),
      ).rejects.toThrow('authorization_denied');
      await fixture.db`update allrice_sessions set revoked_at=clock_timestamp() where id=${context.sessionId}`;
      expect(await dispatchPlatformQualityOccurrence(id)).toBe(true);
      const row = await occurrence(id);
      expect(row.frozen.loginSessionId).toBeUndefined();
      expect(row.frozen.scheduleOrigin).toEqual(pending.quality_occurrence);
      await expect(
        fixture.db`update allrice_automation_runs set quality_occurrence=null where id=${id}`,
      ).rejects.toThrow('immutable');
      await expect(
        fixture.db`update allrice_platform_quality_checks set automation_run_id=null where id=${row.check_id}`,
      ).rejects.toThrow('immutable');
      await stopOccurrence(id);
    });
    it('current account revocation and excluded assignments block unbound recovery instead of restoring authority', async () => {
      const { context, rule } = await freshSchedule();
      await due(rule.id);
      const id = (await claimOnly(rule.id))!;
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', 'nobody@example.test');
      expect(await dispatchPlatformQualityOccurrence(id)).toBe(false);
      expect((await occurrence(id)).error_code).toBe(
        'QUALITY_PREPARATION_BLOCKED',
      );
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', adminEmail);
      await due(rule.id);
      const excludedId = (await claimOnly(rule.id))!;
      const [d] =
        await fixture.db`select * from allrice_platform_quality_deployments where owner_id=${admin.actor.id}`;
      await fixture.db`update allrice_employee_assignments set active=false,selection_mode='exclude' where id=${d!.assignment_id}`;
      expect(await dispatchPlatformQualityOccurrence(excludedId)).toBe(false);
      expect((await occurrence(excludedId)).run_id).toBeNull();
      await updatePlatformQualitySchedule(context, {
        expectedRevision: rule.revision,
        enabled: false,
        time: '09:00',
      });
      const [choice] =
        await fixture.db`select active,selection_mode from allrice_employee_assignments where id=${d!.assignment_id}`;
      expect(choice).toEqual({ active: false, selection_mode: 'exclude' });
      // This isolated schema restores its own synthetic assignment for the
      // pre-existing final authority regression below, never a real tenant.
      await fixture.db`update allrice_employee_assignments set active=true,selection_mode='include' where id=${d!.assignment_id}`;
    });
    it('ordinary daily schedule still admits one original employee Run with the folder-era partial index', async () => {
      const [assignment] =
        await fixture.db`select id from allrice_employee_assignments where user_id=${company.owner.actor.id} and workspace_id=${company.workspace} and active limit 1`;
      const rule = await createAutomation(company.owner, {
        workspaceId: company.workspace,
        name: 'ordinary schedule regression',
        prompt: 'ordinary fixed task',
        triggerType: 'schedule',
        schedule: {
          frequency: 'daily',
          time: '09:00',
          timezone: 'Asia/Shanghai',
        },
        employeeAssignmentId: assignment!.id,
        enabled: true,
      });
      await due(rule.id);
      await Promise.all([claimDueAutomations(), claimDueAutomations()]);
      const rows =
        await fixture.db`select * from allrice_automation_runs where automation_id=${rule.id}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.quality_occurrence).toBeNull();
      expect(rows[0]!.run_id).toBeTruthy();
      expect(
        await fixture.db`select id from allrice_platform_quality_checks where run_id=${rows[0]!.run_id}`,
      ).toHaveLength(0);
      await queue.cancelRun(
        company.owner,
        company.workspace,
        rows[0]!.run_id,
        {},
      );
    });
    it('a paused or excluded QA assignment is never restored on submission', async () => {
      const [d] =
        await fixture.db`select * from allrice_platform_quality_deployments where owner_id=${admin.actor.id}`;
      await fixture.db`update allrice_employee_assignments set active=false,selection_mode='exclude' where id=${d!.assignment_id}`;
      await expect(submit()).rejects.toThrow('authorization_denied');
      const [a] =
        await fixture.db`select active,selection_mode from allrice_employee_assignments where id=${d!.assignment_id}`;
      expect(a).toEqual({ active: false, selection_mode: 'exclude' });
    });
  },
);
