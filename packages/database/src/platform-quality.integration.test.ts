/** Real isolated PostgreSQL authority/queue checks; no physical or paid-model claims. */
import { randomUUID } from 'node:crypto';
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
import { buildEmployeeRuntimePackage } from './platform-employees/runtime-package.ts';
import {
  createPlatformQualityCheck,
  getPlatformQualityCheck,
  cancelPlatformQualityCheck,
  getPlatformQualityExecution,
  recordPlatformQualityReport,
} from './platform-quality.ts';
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
