/**
 * Exercises the published-template, instance, saved-method and test-queue flow.
 * Uses isolated PostgreSQL and synthetic historical test-tool grants/completion;
 * does not call a provider or start a Native Host.
 */
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import * as toolSelection from '@allrice/contracts';
import * as client from '../core/client.ts';
import { createRuntimeFixtureDatabase } from '../runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from '../identity.ts';
import {
  changeAdminTenantEmployee,
  listAdminTenantEmployees,
} from '../tenant-employees.ts';
import {
  createChatSession,
  getEmployeeWorkspace,
} from '../workspace/service.ts';
import { createEmployeeInstance } from '../employees/employee-instances.ts';
import { prepareEmployeeRunBinding } from '../employees/employeehub.ts';
import { seedHistoricalEmployeeContent } from '../employees/employee-method-history.fixture.ts';
import { getEmployeeContentSet } from '../employees/employee-content.ts';
import { prepareEmployeeContentContext } from '../employees/employee-runtime-content.ts';
import {
  getEmployeeMethodTest,
  startEmployeeMethodTestFromChat,
} from '../employees/employee-method-tests.ts';
import {
  claimNextPlatformEmployeeTestRun,
  completePlatformEmployeeTestRun,
  savePlatformEmployeeDraft,
} from '../employees/platform-employees.ts';
import {
  appendNativeModelReceipt,
  bindJobNativeSession,
  prepareJobNativeSession,
  startClaimedJob,
} from '../execution/queue.ts';
import {
  nativeBindingDescriptor,
  nativeBindingWaiter,
} from '../native-session-binding.fixture.ts';
import { newNativeGeneration } from './current-execution-binding.ts';
import { freezeChatRunExecutionBinding } from './native-session-binding.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite(
  'B2a real method issuer, replay and explicit retry (isolated SQL)',
  () => {
    let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    const artifactA = 'sha256:' + 'a'.repeat(64);
    const artifactB = 'sha256:' + 'b'.repeat(64);
    const approve = (artifact = artifactA) => {
      // Synthetic SQL authority only; these are not measured runnable artifacts.
      // MET-221: the release primary is the only birth input.
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', artifact);
    };

    beforeAll(async () => {
      approve();
      fixture = await createRuntimeFixtureDatabase();
      const [where] =
        await fixture.db`select current_database() db,current_schema() schema`;
      expect(where!.db).toBe(
        new URL(process.env.ALLRICE_TEST_DATABASE_URL!).pathname.slice(1),
      );
      expect(where!.schema).toMatch(/^p25_[a-f0-9]{32}$/);
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        Error('No provider/network from method issuer SQL fixture'),
      );
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    }, 120000);

    afterEach(() => approve());
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      const proof = await fixture?.close();
      console.log(
        JSON.stringify({ kind: 'b2a-method-issuer-fixture-cleanup', proof }),
      );
    }, 30000);

    async function principal(
      organizationSlug = `b2a-method-${randomUUID()}`,
      role: 'member' | 'admin' = 'member',
    ) {
      const p = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug,
          organizationName: 'Synthetic B2a method company',
          workspaceSlug: 'default',
          workspaceName: 'Synthetic B2a method workspace',
          email: `${randomUUID()}@example.test`,
          displayName: 'Synthetic method member',
          role,
        },
        fixture.db,
      );
      const login = await createSession(p.user.id);
      const context = await authenticateSession(login.token, {
        organizationId: p.organizationId,
        workspaceId: p.workspaceId,
      });
      if (!context) throw Error('method fixture login failed');
      return { ...p, context };
    }

    async function setup() {
      approve();
      const slug = `b2a-method-${randomUUID()}`;
      const admin = await principal(undefined, 'admin');
      const owner = await principal(slug);
      const other = await principal(slug);
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', admin.user.email);
      const source = await createEmployeeAdministrationFixture(fixture.db);
      await savePlatformEmployeeDraft(source.employeeId, {
        definition: {
          ...source.definition,
          capabilities: {
            ...source.definition.capabilities,
            toolNames: ['workspace.skill.read', 'workspace.export.create'],
          },
        },
        expectedRevisionId: source.revisionId,
      });
      // The publication fixture records a synthetic no-provider preview result.
      // Its real queue INSERT must also satisfy the enabled 0211 guard.
      await source.preview();
      expect((await source.publish()).valid).toBe(true);
      const entry = (
        await listAdminTenantEmployees(
          admin.context,
          owner.organizationId,
          owner.workspaceId,
        )
      ).employees.find((e) => e.employeeId === source.employeeId)!;
      await changeAdminTenantEmployee(admin.context, owner.organizationId, {
        workspaceId: owner.workspaceId,
        employeeId: source.employeeId,
        action: 'assign',
        revisionId: entry.revisionId,
        expectedVersion: entry.deployment?.version ?? null,
      });
      const assignment = (
        await getEmployeeWorkspace(owner.context, owner.workspaceId)
      ).employees[0]!;
      const instance = await createEmployeeInstance(owner.context, {
        workspaceId: owner.workspaceId,
        assignmentId: assignment.id,
        requestId: randomUUID(),
        profile: { name: 'B2a frozen method fixture' },
      });
      expect(instance.source.kind).toBe('platform');
      const [published] = await fixture.db`
      select r.* from allrice_employee_version_sources s
      join allrice_platform_employee_revisions r
        on r.id=s.platform_revision_id and r.employee_id=s.platform_employee_id
      where s.employee_version_id=${instance.source.employeeVersionId}
        and s.organization_id=${owner.organizationId} and s.workspace_id=${owner.workspaceId}`;
      expect(published?.status).toBe('published');
      return { admin, owner, other, source, instance, published: published! };
    }

    /** A pre-retirement authorization Run: old grants exist on first INSERT.
     * No selector is mocked and no frozen Run is upgraded after admission. The
     * actual test issuer, queue claim/binding and retry paths stay under test. */
    async function historicalMethodRun(
      f: Awaited<ReturnType<typeof setup>>,
      text: string,
    ) {
      const session = await createChatSession(f.owner.context, {
        workspaceId: f.owner.workspaceId,
        employeeInstanceId: f.instance.id,
        title: 'Synthetic method authorization',
      });
      const userMessageId = randomUUID(),
        assistantMessageId = randomUUID();
      const runId = randomUUID(),
        jobId = randomUUID(),
        policyId = randomUUID();
      const workerId = randomUUID(),
        leaseToken = randomUUID();
      await fixture.db.begin(async (tx) => {
        await tx`select id from allrice_users where id=${f.owner.user.id} for no key update`;
        await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content,status,client_message_id)
          values(${userMessageId},${f.owner.organizationId},${f.owner.workspaceId},${session.id},${f.owner.user.id},'user',
            ${tx.json({ text, citations: [] })},'completed',${randomUUID()})`;
        await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content,status,reply_to_id)
          values(${assistantMessageId},${f.owner.organizationId},${f.owner.workspaceId},${session.id},${f.owner.user.id},'assistant',
            '{"text":"Synthetic historical response","citations":[]}','pending',${userMessageId})`;
        const [target] = await tx<
          { employee_assignment_id: string; employee_version_id: string }[]
        >`
          select employee_assignment_id,employee_version_id from allrice_chat_sessions where id=${session.id}`;
        const binding = await prepareEmployeeRunBinding(
          {
            context: f.owner.context,
            workspaceId: f.owner.workspaceId,
            assignmentId: target!.employee_assignment_id,
            employeeVersionId: target!.employee_version_id,
            sessionId: session.id,
            userMessageId,
            assistantMessageId,
            promptSnapshot: {
              systemPrompt: '',
              conversation: [],
              memories: [],
              userRequest: text,
            },
          },
          tx,
        );
        const snapshot = binding.executionSnapshot;
        expect(snapshot.instance?.kind).toBe('custom');
        const oldTools = toolSelection
          .employeeCustomizationToolsForInstance('custom')
          .filter((tool) =>
            snapshot.capabilitySnapshot.grantedCapabilities.includes(
              tool.capability,
            ),
          )
          .map((tool) => tool.name);
        const frozen = toolSelection.EmployeeExecutionSnapshotSchema.parse({
          ...snapshot,
          capabilitySnapshot: {
            ...snapshot.capabilitySnapshot,
            bindings: {
              ...snapshot.capabilitySnapshot.bindings,
              toolNames: [
                ...new Set([
                  ...snapshot.capabilitySnapshot.bindings.toolNames,
                  ...oldTools,
                ]),
              ],
            },
          },
          tenantContext: {
            organizationId: f.owner.organizationId,
            workspaceId: f.owner.workspaceId,
            actorId: f.owner.user.id,
            policySnapshotId: policyId,
          },
          createdAt: new Date().toISOString(),
        });
        expect(frozen.capabilitySnapshot.bindings.toolNames).toContain(
          'workspace.employee.method.test',
        );
        // Reuse the existing policy version allocation lock; retries create a
        // distinct historical authorization Run for the same owner.
        const [policy] = await tx<{ version: number }[]>`
          select coalesce(max(version),0)::int+1 version from allrice_policy_snapshots
          where organization_id=${f.owner.organizationId} and subject_id=${f.owner.user.id}`;
        await tx`insert into allrice_policy_snapshots(id,organization_id,subject_id,version,payload,expires_at)
          values(${policyId},${f.owner.organizationId},${f.owner.user.id},${policy!.version},${tx.json(
            {
              memberships: f.owner.context.memberships,
              grants: [
                {
                  resourceType: 'job',
                  action: 'job:execute',
                  workspaceId: f.owner.workspaceId,
                },
                ...['storage_object', 'memory', 'chat_session'].map(
                  (resourceType) => ({
                    resourceType,
                    action: 'resource:read',
                    workspaceId: f.owner.workspaceId,
                  }),
                ),
              ],
            },
          )},clock_timestamp()+interval '1 hour')`;
        const input = {
          employeeAssignmentId: binding.employeeAssignmentId,
          employeeVersionId: binding.employeeVersionId,
          sessionId: session.id,
          userMessageId,
          assistantMessageId,
        };
        await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,policy_snapshot_id,execution_spec,input)
          values(${runId},${f.owner.organizationId},${f.owner.workspaceId},${f.owner.user.id},'queued',${policyId},
            ${tx.json({ schemaVersion: 1, handler: 'allrice.employee.run', employeeVersionId: binding.employeeVersionId, provider: 'codex' })},${tx.json(input)})`;
        await tx`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at)
          values(${jobId},${f.owner.organizationId},${f.owner.workspaceId},${f.owner.user.id},${runId},'claimed',${randomUUID()},clock_timestamp()+interval '1 hour',
            ${tx.json({ schemaVersion: 1, type: 'allrice.employee.run', input })},${workerId},${leaseToken},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '5 minutes')`;
        const native = await freezeChatRunExecutionBinding(tx, {
          organizationId: f.owner.organizationId,
          workspaceId: f.owner.workspaceId,
          ownerId: f.owner.user.id,
          sessionId: session.id,
          runId,
          employeeVersionId: binding.employeeVersionId,
          executionSnapshot: frozen,
        });
        await tx`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,
          user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,skill_bindings,native_skills,execution_snapshot,native_execution_binding)
          values(${runId},${f.owner.organizationId},${f.owner.workspaceId},${f.owner.user.id},${binding.employeeAssignmentId},${binding.employeeVersionId},${session.id},
            ${userMessageId},${assistantMessageId},${tx.json(binding.providerSnapshot)},${tx.json(binding.promptSnapshot)},${tx.json(binding.skillBindings)},
            ${tx.json(binding.nativeSkills)},${tx.json(frozen)},${native ? tx.json(native) : null})`;
      });
      const execution = await startClaimedJob(workerId, jobId, leaseToken);
      if (!execution) throw Error('method authorizing chat did not start');
      const [row] = await fixture.db`select execution_snapshot
      from allrice_employee_runs where run_id=${runId}`;
      const runtime = await prepareEmployeeContentContext({
        organizationId: f.owner.organizationId,
        workspaceId: f.owner.workspaceId,
        ownerId: f.owner.user.id,
        sessionId: session.id,
        runId,
      });
      expect(runtime).not.toBeNull();
      return {
        context: execution.context,
        sessionId: session.id,
        userMessageId,
        worker: { attempt: execution.job.attempt, leaseToken },
        callId: randomUUID(),
        frozen: row!.execution_snapshot,
        // Same SQL-only chat completion as the source integration fixture. No
        // model/native dispatch or usage is fabricated by this authorizing chat.
        finish: async () => {
          await fixture.db`update allrice_jobs set status='succeeded',completed_at=now() where run_id=${runId}`;
          await fixture.db`update allrice_runs set state='succeeded',completed_at=now() where id=${runId}`;
          await fixture.db`update allrice_employee_runs set status='succeeded',completed_at=now() where run_id=${runId}`;
        },
      };
    }

    async function candidate() {
      const f = await setup();
      const contentId = randomUUID();
      const saved = await seedHistoricalEmployeeContent(
        fixture.db,
        f.owner.context,
        {
          workspaceId: f.owner.workspaceId,
          setId: randomUUID(),
          requestId: randomUUID(),
          expectedRevision: 0,
          ownership: {
            scope: 'personal',
            organizationId: f.owner.organizationId,
            ownerId: f.owner.context.actor.id,
          },
          target: { kind: 'instance', instanceId: f.instance.id },
          operation: 'save_draft',
          changeSummary: 'Pre-retirement B2a candidate fixture',
          manifest: {
            schemaVersion: 1,
            common: [],
            declaredConflicts: [],
            scenes: [
              {
                id: randomUUID(),
                name: '金额汇总',
                appliesWhen: '固定合成数据',
                references: [{ sourceKind: 'draft_text', contentId }],
              },
            ],
          },
          textEdits: [
            {
              contentId,
              revisionId: randomUUID(),
              expectedRevision: 0,
              kind: 'procedure',
              title: '金额汇总',
              body: '只将整数分相加',
            },
          ],
        },
      );
      const content = await getEmployeeContentSet(f.owner.context, saved.setId);
      const args = {
        expectedRevision: saved.revision,
        candidateRevisionId: saved.candidate.id,
        candidateDigest: saved.candidate.digest,
        sceneId: content.set.candidate!.manifest.scenes[0]!.id,
        caseId: 'cny-total-v1',
      };
      const testing = await historicalMethodRun(
        f,
        '请测试我的工作场景候选：金额汇总。',
      );
      return { f, saved, args, testing };
    }

    async function testRow(id: string) {
      const [row] =
        await fixture.db`select * from allrice_platform_employee_test_runs where id=${id}`;
      if (!row) throw Error('owned method test row missing');
      return row;
    }
    async function methodRow(id: string) {
      const [row] =
        await fixture.db`select * from allrice_employee_method_tests where test_id=${id}`;
      if (!row) throw Error('owned method binding missing');
      return row;
    }
    async function counts(id: string) {
      const [row] = await fixture.db`select
      (select count(*)::integer from allrice_runs where execution_spec->>'platformEmployeeTestRunId'=${id}) runs,
      (select count(*)::integer from allrice_jobs j join allrice_runs r on r.id=j.run_id
        where r.execution_spec->>'platformEmployeeTestRunId'=${id}) jobs`;
      return row!;
    }
    async function ownerCounts(f: Awaited<ReturnType<typeof setup>>) {
      const [row] = await fixture.db`select
      (select count(*)::integer from allrice_employee_method_tests where organization_id=${f.owner.organizationId}
        and workspace_id=${f.owner.workspaceId} and owner_id=${f.owner.user.id}) tests,
      (select count(*)::integer from allrice_runs where organization_id=${f.owner.organizationId}) runs,
      (select count(*)::integer from allrice_jobs where organization_id=${f.owner.organizationId}) jobs`;
      return row!;
    }
    async function fail(id: string) {
      return completePlatformEmployeeTestRun(id, {
        answer: null,
        provider: null,
        model: null,
        threadId: null,
        usage: null,
        events: [],
        error: {
          code: 'DSH_TRANSPORT',
          message: 'Synthetic pre-dispatch failure; no provider called',
        },
        modelExecution: {
          dispatched: false,
          subscriptionSnapshotCreated: false,
          usageComplete: true,
          cacheUsageKnown: true,
          costCents: 0,
        },
      });
    }
    async function claimAndBind(
      id: string,
      f: Awaited<ReturnType<typeof setup>>,
    ) {
      const row = await testRow(id),
        workerId = randomUUID();
      const claimed = await claimNextPlatformEmployeeTestRun(workerId);
      expect(claimed?.id).toBe(id);
      if (!claimed) throw Error('owned method test not claimed');
      expect(claimed.methodCandidate).toBeDefined();
      const descriptor = {
        ...nativeBindingDescriptor({
          organizationId: f.owner.organizationId,
          workspaceId: f.owner.workspaceId,
          ownerId: f.owner.user.id,
          contextKey: id,
          distributionGeneration: newNativeGeneration,
        }),
        artifactId: row.native_root_origin.artifactId,
        artifactManifestDigest: row.native_root_origin.artifactId,
      };
      const lease = {
        workerId,
        jobId: claimed.previewExecution.jobId,
        leaseToken: claimed.previewExecution.leaseToken,
        attempt: claimed.previewExecution.jobAttempt,
        subject: { kind: 'platform_employee_test' as const, id },
      };
      const preparation = {
        ...lease,
        nativeSessionId: descriptor.nativeSessionId,
        storageContextKey: id,
      };
      const prepared = await prepareJobNativeSession(preparation);
      expect(prepared.binding).toBeNull();
      expect(prepared.executionBinding).toEqual({
        kind: 'current_platform_test_run_execution',
        test: row.native_execution_binding,
        runId: claimed.previewExecution.runId,
        jobId: lease.jobId,
        attempt: lease.attempt,
      });
      const bound = await bindJobNativeSession({ ...lease, descriptor });
      expect(bound.binding).toMatchObject({
        contextKind: 'platform_employee_test',
        contextId: id,
        organizationId: f.owner.organizationId,
        workspaceId: f.owner.workspaceId,
        ownerId: f.owner.user.id,
        artifactId: row.native_root_origin.artifactId,
      });
      const cold = await prepareJobNativeSession(preparation);
      expect(cold.executionBinding).toEqual(prepared.executionBinding);
      expect(cold.requiresRecovery).toBe(true);
      expect(cold.binding?.firstRunId).toBe(claimed.previewExecution.runId);
      return claimed;
    }

    it.each([
      { closer: 'direct', first: 'receipt' },
      { closer: 'direct', first: 'finalizer' },
      { closer: 'timeout-scan', first: 'receipt' },
      { closer: 'timeout-scan', first: 'finalizer' },
    ] as const)(
      'serializes native receipts with real method $closer, $first first',
      async ({ closer, first }) => {
        const x = await candidate();
        const test = await startEmployeeMethodTestFromChat({
          ...x.testing,
          arguments: x.args,
        });
        await x.testing.finish();
        const claimed = await claimAndBind(test.id, x.f);
        const [job] =
          await fixture.db`select worker_id from allrice_jobs where id=${claimed.previewExecution.jobId}`;
        const [pin] =
          await fixture.db`select native_session_id from allrice_native_session_bindings where first_run_id=${claimed.previewExecution.runId}`;
        const request = {
          workerId: job!.worker_id as string,
          jobId: claimed.previewExecution.jobId,
          leaseToken: claimed.previewExecution.leaseToken,
          rootSessionId: pin!.native_session_id as string,
          routeDecisionId: claimed.methodCandidate!.decision.id,
        };
        const call = {
          phase: 'start' as const,
          callId: randomUUID(),
          nativeSessionId: request.rootSessionId,
          provider: 'synthetic',
          model: 'never-called',
        };
        await appendNativeModelReceipt({ ...request, fact: call });
        if (closer === 'timeout-scan')
          await fixture.db`update allrice_platform_employee_test_runs set timeout_at=clock_timestamp() where id=${test.id}`;
        const write = () =>
          appendNativeModelReceipt({
            ...request,
            fact: {
              ...call,
              phase: 'finish',
              outcome: 'succeeded',
              usageComplete: true,
              usage: {
                inputTokens: 1,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 1,
              },
            },
          }).then(
            () => 'committed',
            (error: unknown) => error,
          );
        const end = () =>
          (closer === 'timeout-scan'
            ? claimNextPlatformEmployeeTestRun(randomUUID())
            : completePlatformEmployeeTestRun(test.id, {
                answer: 'Synthetic complete',
                provider: 'synthetic',
                model: 'never-called',
                threadId: null,
                usage: null,
                events: [],
                error: null,
              })
          ).then(
            () => 'closed',
            (error: unknown) => error,
          );
        const gate = await fixture.db.reserve();
        await gate`begin`;
        const [held] = await gate`select pg_backend_pid() pid`;
        let writing: Promise<unknown> | undefined;
        let ending: Promise<unknown> | undefined;
        try {
          if (first === 'receipt') {
            await gate`select id from allrice_route_decisions where id=${request.routeDecisionId} for update`;
            writing = write();
            const writer = await nativeBindingWaiter(
              fixture.db,
              held!.pid as number,
            );
            ending = end();
            await nativeBindingWaiter(fixture.db, writer);
            // A blocked closer must not hold Run while waiting for the receipt's Job.
            // Claim retries only 55P03; this NOWAIT proves the lock order directly.
            await gate`select id from allrice_runs where id=${claimed.previewExecution.runId} for update nowait`;
          } else {
            await gate`select pg_advisory_xact_lock(hashtext(${`tenant:${x.f.owner.organizationId.toLowerCase()}`}))`;
            ending = end();
            const finalizer = await nativeBindingWaiter(
              fixture.db,
              held!.pid as number,
            );
            writing = write();
            await nativeBindingWaiter(fixture.db, finalizer);
          }
        } finally {
          await gate`rollback`;
          gate.release();
          await Promise.all([writing, ending]);
        }
        expect(await ending).toBe('closed');
        if (first === 'receipt') expect(await writing).toBe('committed');
        else expect(await writing).toMatchObject({ code: 'lease_lost' });
        const status = closer === 'timeout-scan' ? 'failed' : 'succeeded';
        const [closed] =
          await fixture.db`select t.status test_status,r.state run_status,j.status job_status,j.lease_token,d.status route_status,d.completed_at
          from allrice_platform_employee_test_runs t
          join allrice_runs r on r.id=${claimed.previewExecution.runId}
          join allrice_jobs j on j.run_id=r.id
          join allrice_route_decisions d on d.id=${request.routeDecisionId}
          where t.id=${test.id}`;
        expect(closed).toMatchObject({
          test_status: status,
          run_status: status,
          job_status: status,
          route_status: status,
          lease_token: null,
        });
        expect(closed!.completed_at).toBeInstanceOf(Date);
        const facts =
          await fixture.db`select payload->'fact'->>'phase' phase from allrice_run_events
          where run_id=${claimed.previewExecution.runId} and payload->>'source'='native_model_receipt_v1' order by sequence`;
        expect(facts.map((r) => r.phase)).toEqual(
          first === 'receipt' ? ['start', 'finish'] : ['start'],
        );
      },
      30000,
    );

    it('first INSERT freezes the published source; replay is one test and claim owns the first real execution', async () => {
      const x = await candidate();
      const input = { ...x.testing, arguments: x.args };
      const test = await startEmployeeMethodTestFromChat(input);
      expect(test).toMatchObject({
        status: 'queued',
        runId: null,
        validationStatus: 'pending',
      });
      expect(await counts(test.id)).toEqual({ runs: 0, jobs: 0 });
      const row = await testRow(test.id),
        binding = await methodRow(test.id);
      expect(row).toMatchObject({
        employee_id: x.f.source.employeeId,
        revision_id: x.f.published.id,
        purpose: 'method_candidate',
      });
      expect(row.frozen_definition).toEqual(x.f.published.definition);
      expect(row.frozen_runtime_profile).toEqual(x.f.published.runtime_profile);
      expect(row.frozen_native_skills).toEqual(
        x.f.published.runtime_profile.runtimePackage.skills,
      );
      expect(row.frozen_package_checksum).toBe(
        x.f.published.runtime_profile.runtimePackage.checksum,
      );
      expect(row.native_root_origin).toMatchObject({
        schemaVersion: 2,
        contextKind: 'platform_employee_test',
        contextId: test.id,
        artifactId: artifactA,
        birthSource: {
          platformRevisionId: x.f.published.id,
          definitionChecksum: x.f.published.checksum,
          purpose: 'method_candidate',
        },
      });
      expect(row.native_execution_binding).toMatchObject({
        scope: {
          testId: test.id,
          organizationId: x.f.owner.organizationId,
          workspaceId: x.f.owner.workspaceId,
          ownerId: x.f.owner.user.id,
        },
        source: row.native_root_origin.birthSource,
        execution: { artifactId: artifactA },
      });
      expect(binding.model_snapshot).toEqual(x.testing.frozen.modelSnapshot);
      expect(binding.candidate_snapshot.content).toMatchObject({
        candidateRevisionId: x.args.candidateRevisionId,
        candidateDigest: x.args.candidateDigest,
        employeeVersionId: x.f.instance.source.employeeVersionId,
      });
      expect((await startEmployeeMethodTestFromChat(input)).id).toBe(test.id);
      const repeats = await Promise.all(
        [0, 1].map(() =>
          startEmployeeMethodTestFromChat({ ...input, callId: randomUUID() }),
        ),
      );
      expect(repeats.map((r) => r.id)).toEqual([test.id, test.id]);
      expect((await ownerCounts(x.f)).tests).toBe(1);
      expect(await counts(test.id)).toEqual({ runs: 0, jobs: 0 });
      for (const context of [x.f.other.context, x.f.admin.context]) {
        await expect(
          getEmployeeMethodTest(context, test.id),
        ).rejects.toMatchObject({ code: 'not_found' });
      }
      await x.testing.finish();
      // A later editable platform draft must not become this queued test's source.
      await savePlatformEmployeeDraft(x.f.source.employeeId, {
        definition: {
          ...x.f.published.definition,
          name: 'Later draft must not replace queued source',
        },
        expectedRevisionId: x.f.published.id,
      });
      const claim = await claimAndBind(test.id, x.f);
      expect(await counts(test.id)).toEqual({ runs: 1, jobs: 1 });
      expect(claim.methodCandidate!.modelSnapshot).toEqual(
        binding.model_snapshot,
      );
      const after = await testRow(test.id);
      for (const key of [
        'revision_id',
        'frozen_definition',
        'frozen_runtime_profile',
        'frozen_native_skills',
        'frozen_package_checksum',
        'native_root_origin',
        'native_execution_binding',
      ]) {
        expect(after[key]).toEqual(row[key]);
      }
      await fail(test.id);
    }, 60000);

    it('explicit failure retry gets a new current executor while preserving the failed parent and original method/model source', async () => {
      const x = await candidate();
      const parent = await startEmployeeMethodTestFromChat({
        ...x.testing,
        arguments: x.args,
      });
      await x.testing.finish();
      await claimAndBind(parent.id, x.f);
      await fail(parent.id);
      const parentTest = await testRow(parent.id),
        parentMethod = await methodRow(parent.id);
      expect(parentTest.status).toBe('failed');
      expect(
        (await getEmployeeMethodTest(x.f.owner.context, parent.id))
          .validationStatus,
      ).toBe('not_verified');
      const ordinary = await historicalMethodRun(
        x.f,
        '请测试我的工作场景候选：金额汇总。',
      );
      expect(
        (
          await startEmployeeMethodTestFromChat({
            ...ordinary,
            arguments: x.args,
          })
        ).id,
      ).toBe(parent.id);
      await expect(
        startEmployeeMethodTestFromChat({
          ...ordinary,
          callId: randomUUID(),
          arguments: { ...x.args, retryOfTestId: parent.id },
        }),
      ).rejects.toMatchObject({ code: 'explicit_test_retry_required' });
      await ordinary.finish();

      approve(artifactB);
      const retrying = await historicalMethodRun(
        x.f,
        `请重试测试 ${parent.id}。`,
      );
      expect(retrying.sessionId).not.toBe(x.testing.sessionId);
      const args = { ...x.args, retryOfTestId: parent.id };
      const retried = await Promise.all(
        [0, 1].map(() =>
          startEmployeeMethodTestFromChat({
            ...retrying,
            callId: randomUUID(),
            arguments: args,
          }),
        ),
      );
      const child = retried[0]!;
      expect(retried[1]!.id).toBe(child.id);
      expect(child.id).not.toBe(parent.id);
      expect(child).toMatchObject({
        status: 'queued',
        retryOfTestId: parent.id,
        runId: null,
      });
      expect(
        (
          await startEmployeeMethodTestFromChat({
            ...retrying,
            arguments: args,
          })
        ).id,
      ).toBe(child.id);
      expect(await counts(child.id)).toEqual({ runs: 0, jobs: 0 });
      expect((await ownerCounts(x.f)).tests).toBe(2);
      const childTest = await testRow(child.id),
        childMethod = await methodRow(child.id);
      for (const key of [
        'employee_id',
        'revision_id',
        'purpose',
        'input',
        'frozen_definition',
        'frozen_runtime_profile',
        'frozen_native_skills',
        'frozen_package_checksum',
      ]) {
        expect(childTest[key]).toEqual(parentTest[key]);
      }
      for (const key of [
        'model_snapshot',
        'candidate_snapshot',
        'snapshot_digest',
        'binding_digest',
      ]) {
        expect(childMethod[key]).toEqual(parentMethod[key]);
      }
      expect(childMethod.source_session_id).toBe(retrying.sessionId);
      expect(childMethod.source_run_id).toBe(retrying.context.runId);
      expect(childMethod.retry_of_test_id).toBe(parent.id);
      expect(childTest.native_root_origin).toMatchObject({
        contextId: child.id,
        rootSeed: child.id,
        artifactId: artifactB,
      });
      expect(childTest.native_root_origin.birthSource).toEqual(
        parentTest.native_root_origin.birthSource,
      );
      expect(childTest.native_execution_binding.source).toEqual(
        parentTest.native_execution_binding.source,
      );
      expect(childTest.native_execution_binding.execution.artifactId).toBe(
        artifactB,
      );
      // The old failure, raw output, timestamps, source and execution identity are
      // immutable evidence. Only the DTO's reverse retry lookup can gain a child.
      expect(await testRow(parent.id)).toEqual(parentTest);
      expect(await methodRow(parent.id)).toEqual(parentMethod);
      await retrying.finish();
      const claimed = await claimAndBind(child.id, x.f);
      expect(claimed.methodCandidate!.modelSnapshot).toEqual(
        parentMethod.model_snapshot,
      );
      expect(claimed.methodCandidate!.sourceSessionId).toBe(
        parentMethod.model_snapshot.sessionId,
      );
      expect(await counts(child.id)).toEqual({ runs: 1, jobs: 1 });
      await fail(child.id);
      expect(await testRow(parent.id)).toEqual(parentTest);
      expect(await methodRow(parent.id)).toEqual(parentMethod);
    }, 60000);

    it('missing current execution approval rolls back the issuer without a test or additional Run/Job', async () => {
      const x = await candidate();
      const before = await ownerCounts(x.f);
      expect(before.tests).toBe(0);
      // The authorizing chat Run already exists. Assert no additional execution,
      // rather than incorrectly asserting the tenant has no Runs at all.
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', undefined);
      await expect(
        startEmployeeMethodTestFromChat({ ...x.testing, arguments: x.args }),
      ).rejects.toThrow();
      expect(await ownerCounts(x.f)).toEqual(before);
      expect(
        await fixture.db`select id from allrice_platform_employee_test_runs
      where purpose='method_candidate' and input->>'ownerId'=${x.f.owner.user.id}`,
      ).toHaveLength(0);
      approve();
      await x.testing.finish();
    }, 60000);

    it('revocation after enqueue terminates the method test before its first Run or Job', async () => {
      const x = await candidate();
      const test = await startEmployeeMethodTestFromChat({
        ...x.testing,
        arguments: x.args,
      });
      const frozen = await testRow(test.id);
      await x.testing.finish();
      await fixture.db`update allrice_memberships set active=false
      where organization_id=${x.f.owner.organizationId} and user_id=${x.f.owner.user.id}`;
      expect(await claimNextPlatformEmployeeTestRun(randomUUID())).toBeNull();
      const row = await testRow(test.id);
      expect(row.status).toBe('failed');
      expect(row.output.error.code).toBe('TEST_ENVIRONMENT_UNAVAILABLE');
      expect(await counts(test.id)).toEqual({ runs: 0, jobs: 0 });
      expect(row.native_root_origin).toEqual(frozen.native_root_origin);
      expect(row.native_execution_binding).toEqual(
        frozen.native_execution_binding,
      );
      expect(await claimNextPlatformEmployeeTestRun(randomUUID())).toBeNull();
    }, 60000);

    it('revocation before first INSERT rejects the issuer even with the original chat capability snapshot', async () => {
      const x = await candidate();
      const before = await ownerCounts(x.f);
      await fixture.db`update allrice_memberships set active=false
      where organization_id=${x.f.owner.organizationId} and user_id=${x.f.owner.user.id}`;
      await expect(
        startEmployeeMethodTestFromChat({ ...x.testing, arguments: x.args }),
      ).rejects.toThrow();
      expect(await ownerCounts(x.f)).toEqual(before);
      expect(
        await fixture.db`select id from allrice_platform_employee_test_runs
      where purpose='method_candidate' and input->>'ownerId'=${x.f.owner.user.id}`,
      ).toHaveLength(0);
      await x.testing.finish();
    }, 60000);
  },
);
