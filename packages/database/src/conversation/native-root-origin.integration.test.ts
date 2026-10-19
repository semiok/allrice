import {
  claimNextJob,
  startClaimedJob,
  prepareJobNativeSession,
  bindJobNativeSession,
} from '../execution/queue.ts';
import { acquireConversationRuntime } from './conversation-runtime.ts';
import { nativeBindingDescriptor } from '../native-session-binding.fixture.ts';
import type { EmployeeRuntimePackage } from '@allrice/contracts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as client from '../core/client.ts';
import { createAssistantFixtureDatabase } from '../assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from '../assistant-authority.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import {
  queuePlatformEmployeeTestRun,
  claimNextPlatformEmployeeTestRun,
} from '../employees/platform-employees.ts';
import {
  assignEmployeeVersion,
  manageEmployeeAssignments,
} from '../employees/employeehub.ts';
import { ensureGeneralEmployeeInstance } from '../employees/employee-instances.ts';
import { employeeManifestChecksum } from '../employees/employee-config.ts';
import {
  createAssignedChatSession,
  sendChatMessage,
} from '../workspace/service.ts';
import { createSession, authenticateSession } from '../identity.ts';
import {
  nativeRootDigest,
  newInternalNativeRootOrigin,
} from './native-root-origin.ts';
import { verifyNativeArtifactReferenceCoverage } from './native-artifact-references.ts';
import {
  PlatformEmployeeRuntimeProfileSchema,
  DSH_MISSING_FROZEN_GENERATION,
} from '@allrice/contracts';
import { runtimePackageChecksum } from '../platform-employees/runtime-package.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
it('rejects an eighth independent reader approval before database access', async () => {
  const access = vi.spyOn(client, 'getDatabase').mockImplementation(() => {
    throw Error('unexpected_database_access');
  });
  try {
    await expect(
      verifyNativeArtifactReferenceCoverage(
        ['a', 'b', 'c', 'd', 'e', 'f', '7', '8'].map((letter) => ({
          artifactId: 'sha256:' + letter.repeat(64),
          generation: 'dsh-0.2.1-rc.2-687f282' as const,
          storageRoot: '/synthetic-approved-root',
        })),
      ),
    ).rejects.toThrow();
    expect(access).not.toHaveBeenCalled();
  } finally {
    access.mockRestore();
  }
});
suite(
  'MET192 immutable first business INSERT origin: isolated real PostgreSQL',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      fixture = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      vi.stubEnv(
        'ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID',
        'sha256:' + 'a'.repeat(64),
      );
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
    }, 30000);
    async function authority(runtimePackage: EmployeeRuntimePackage) {
      const f = await createAssistantAuthorityFixture(fixture.db, {
        configure: false,
        runtimePackage,
      });
      const login = await createSession(f.user);
      const context = await authenticateSession(login.token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      });
      if (!context) throw Error('fixture_login');
      return { ...f, context };
    }
    async function packaged() {
      const e = await createEmployeeAdministrationFixture(fixture.db);
      const queued = await queuePlatformEmployeeTestRun(e.employeeId, {
        environment: 'company',
        workspaceId: e.workspaceId,
        ownerId: e.ownerId,
        prompt: 'Synthetic only',
      });
      expect(queued.queued).toBe(true);
      const [row] =
        await fixture.db`select frozen_runtime_profile from allrice_platform_employee_test_runs where id=${queued.testRun!.id}`;
      return {
        employee: e,
        test: queued.testRun!,
        runtimePackage: PlatformEmployeeRuntimeProfileSchema.parse(
          row!.frozen_runtime_profile,
        ).runtimePackage!,
      };
    }
    it('concurrent first chat creation commits one origin with its published package, repeated creation never reissues', async () => {
      const { runtimePackage } = await packaged();
      const f = await authority(runtimePackage);
      await ensureGeneralEmployeeInstance(fixture.db, f.assignment);
      const id = randomUUID(),
        input = {
          workspaceId: f.workspace,
          employeeAssignmentId: f.assignment,
          title: 'Synthetic new origin',
        };
      const [a, b] = await Promise.all([
        createAssignedChatSession(f.context, input, { sessionId: id }),
        createAssignedChatSession(f.context, input, { sessionId: id }),
      ]);
      expect(a.id).toBe(b.id);
      const [first] =
        await fixture.db`select native_root_origin from allrice_chat_sessions where id=${id}`;
      expect(first!.native_root_origin).toMatchObject({
        contextId: id,
        rootSeed: id,
        frozenIdentity: { checksum: runtimePackage.checksum },
      });
      vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', undefined);
      await createAssignedChatSession(f.context, input, { sessionId: id });
      const [again] =
        await fixture.db`select native_root_origin from allrice_chat_sessions where id=${id}`;
      expect(nativeRootDigest(again!.native_root_origin)).toBe(
        nativeRootDigest(first!.native_root_origin),
      );
      vi.stubEnv(
        'ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID',
        'sha256:' + 'a'.repeat(64),
      );
      // Repeated real PostgreSQL races exercise both redundant unique indexes;
      // this is not an application-level retry or a repeated model task.
      for (let n = 0; n < 8; n++) {
        const sameId = randomUUID();
        const pair = await Promise.all([
          createAssignedChatSession(f.context, input, { sessionId: sameId }),
          createAssignedChatSession(f.context, input, { sessionId: sameId }),
        ]);
        expect(pair.map((x) => x.id)).toEqual([sameId, sameId]);
        expect(
          await fixture.db`select id from allrice_chat_sessions where id=${sameId}`,
        ).toHaveLength(1);
      }
    });
    it('a new Session with an old frozen package stays legacy, and NULL cannot be backfilled by UPDATE', async () => {
      const { runtimePackage } = await packaged();
      runtimePackage.runtimeManifest.distributionGeneration =
        DSH_MISSING_FROZEN_GENERATION;
      resign(runtimePackage);
      const f = await authority(runtimePackage);
      const s = await createAssignedChatSession(f.context, {
        workspaceId: f.workspace,
        employeeAssignmentId: f.assignment,
        title: 'New old-package Session',
      });
      const [r] =
        await fixture.db`select native_root_origin from allrice_chat_sessions where id=${s.id}`;
      expect(r!.native_root_origin).toBeNull();
      await expect(
        fixture.db`update allrice_chat_sessions set native_root_origin='{}'::jsonb where id=${s.id}`,
      ).rejects.toThrow('native root origin is immutable');
    });
    it('an old pre-upgrade Session is never retroactively issued a candidate origin', async () => {
      const { runtimePackage } = await packaged(),
        f = await authority(runtimePackage);
      const s = await createAssignedChatSession(
        f.context,
        {
          workspaceId: f.workspace,
          employeeAssignmentId: f.assignment,
          title: 'Idempotent old row',
        },
        { sessionId: f.session },
      );
      expect(s.id).toBe(f.session);
      const [r] =
        await fixture.db`select native_root_origin from allrice_chat_sessions where id=${f.session}`;
      expect(r!.native_root_origin).toBeNull();
    });
    it('preview first INSERT freezes actual test seed, generation/artifact and package, and mutation is rejected', async () => {
      const p = await packaged();
      const [r] =
        await fixture.db`select native_root_origin from allrice_platform_employee_test_runs where id=${p.test.id}`;
      expect(r!.native_root_origin).toMatchObject({
        contextKind: 'platform_employee_test',
        contextId: p.test.id,
        rootSeed: p.test.id,
        distributionGeneration: 'dsh-0.2.1-rc.2-687f282',
        artifactId: 'sha256:' + 'a'.repeat(64),
        frozenIdentity: { checksum: p.runtimePackage.checksum },
      });
      await expect(
        fixture.db`update allrice_platform_employee_test_runs set native_root_origin=null where id=${p.test.id}`,
      ).rejects.toThrow('native root origin is immutable');
    });
    function resign(p: EmployeeRuntimePackage) {
      p.checksum = runtimePackageChecksum({
        schemaVersion: p.schemaVersion,
        packageVersion: p.packageVersion,
        capabilityFingerprint: p.capabilityFingerprint,
        files: {
          identityMd: p.files.identityMd,
          soulMd: p.files.soulMd,
          userMd: p.files.userMd,
          agentsMd: p.files.agentsMd,
        },
        skills: p.skills,
        runtimeManifest: p.runtimeManifest,
      });
    }
    async function publishVersion(
      f: Awaited<ReturnType<typeof authority>>,
      runtimePackage: EmployeeRuntimePackage,
    ) {
      const id = randomUUID(),
        manifest = { ...f.manifest, runtimePackage };
      await fixture.db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
   select ${id},organization_id,workspace_id,employee_id,(select max(version)+1 from allrice_employee_versions where employee_id=${f.employee}),name,model,system_prompt,capabilities,${employeeManifestChecksum(manifest)},${fixture.db.json(manifest)},provider_snapshot from allrice_employee_versions where id=${f.version}`;
      return id;
    }
    async function send(f: Awaited<ReturnType<typeof authority>>, id: string) {
      return sendChatMessage(f.context, f.workspace, id, {
        text: 'Synthetic no-model acceptance',
        clientMessageId: randomUUID(),
        deliveryMode: 'follow_up',
      });
    }
    it('same-engine publication changes the next real Run package without changing birth provenance or a queued original Run', async () => {
      const { runtimePackage } = await packaged(),
        f = await authority(runtimePackage);
      const s = await createAssignedChatSession(f.context, {
        workspaceId: f.workspace,
        employeeAssignmentId: f.assignment,
        title: 'Same-engine publication',
      });
      const old = await send(f, s.id);
      const [before] =
        await fixture.db`select execution_snapshot,employee_version_id from allrice_employee_runs where run_id=${old.run!.id}`;
      const [birth] =
        await fixture.db`select native_root_origin from allrice_chat_sessions where id=${s.id}`;
      const claimed = await claimNextJob(f.worker.workerId, 60000);
      expect(claimed).not.toBeNull();
      expect(
        (
          await fixture.db`select run_id from allrice_jobs where id=${claimed!.id}`
        )[0]!.run_id,
      ).toBe(old.run!.id);
      const execution = await startClaimedJob(
        f.worker.workerId,
        claimed!.id,
        claimed!.lease!.token,
      );
      expect(execution).not.toBeNull();
      const conversation = await acquireConversationRuntime({
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        sessionId: s.id,
        runId: old.run!.id,
        workerId: f.worker.workerId,
        configChecksum: before!.execution_snapshot.employee.definitionChecksum,
        compactThresholdTokens: 10000,
      });
      const nextPackage = structuredClone(runtimePackage);
      nextPackage.files.agentsMd += '\nUpdated synthetic style';
      resign(nextPackage);
      const next = await publishVersion(f, nextPackage);
      await fixture.db`update allrice_employee_assignments set employee_version_id=${next} where id=${f.assignment}`;
      const second = await send(f, s.id);
      const [run] =
        await fixture.db`select employee_version_id,execution_snapshot from allrice_employee_runs where run_id=${second.run!.id}`;
      expect(run!.employee_version_id).toBe(next);
      expect(
        run!.execution_snapshot.employee.definition.runtimePackage.checksum,
      ).toBe(nextPackage.checksum);
      expect(
        (
          await fixture.db`select native_root_origin from allrice_chat_sessions where id=${s.id}`
        )[0]!.native_root_origin,
      ).toEqual(birth!.native_root_origin);
      expect(birth!.native_root_origin.frozenIdentity.sourceId).toBe(f.version);
      // Queued A is admitted after the mutable Session now points to B. Its
      // own CAS/Run snapshot stays A; only immutable birth A proves origin.
      const descriptor = nativeBindingDescriptor({
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        contextKey: s.id,
        distributionGeneration: 'dsh-0.2.1-rc.2-687f282',
      });
      descriptor.artifactId = descriptor.artifactManifestDigest =
        'sha256:' + 'a'.repeat(64);
      const input = {
        workerId: f.worker.workerId,
        jobId: claimed!.id,
        leaseToken: claimed!.lease!.token,
        attempt: claimed!.attempt,
        subject: {
          kind: 'chat' as const,
          id: s.id,
          configChecksum: conversation.configChecksum,
          generation: conversation.generation,
          expectedThreadId: conversation.threadId,
        },
        descriptor,
      };
      const { descriptor: boundDescriptor, ...admission } = input;
      expect(
        (
          await prepareJobNativeSession({
            ...admission,
            nativeSessionId: boundDescriptor.nativeSessionId,
            storageContextKey: s.id,
          })
        ).origin,
      ).toEqual(birth!.native_root_origin);
      expect((await bindJobNativeSession(input)).binding).toMatchObject({
        bindingBasis: 'business_root_origin',
        artifactId: descriptor.artifactId,
      });

      expect(
        (
          await fixture.db`select execution_snapshot,employee_version_id from allrice_employee_runs where run_id=${old.run!.id}`
        )[0],
      ).toEqual(before);
    });
    it.each(['next-turn', 'explicit-assignment', 'bulk-assignment'] as const)(
      'legacy Session keeps its old package through %s, while a new Session adopts the candidate',
      async (mode) => {
        const { runtimePackage } = await packaged(),
          oldPackage = structuredClone(runtimePackage);
        oldPackage.runtimeManifest.distributionGeneration =
          DSH_MISSING_FROZEN_GENERATION;
        resign(oldPackage);
        const f = await authority(oldPackage),
          s = await createAssignedChatSession(f.context, {
            workspaceId: f.workspace,
            employeeAssignmentId: f.assignment,
            title: 'Legacy family boundary',
          });
        const candidate = await publishVersion(f, runtimePackage);
        const [user] =
          await fixture.db`select email from allrice_users where id=${f.user}`;
        vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', user!.email);
        if (mode === 'explicit-assignment')
          await assignEmployeeVersion(f.context, f.assignment, {
            workspaceId: f.workspace,
            employeeVersionId: candidate,
          });
        else if (mode === 'bulk-assignment')
          await manageEmployeeAssignments(f.context, {
            workspaceId: f.workspace,
            employeeId: f.employee,
            userIds: [f.user],
          });
        else
          await fixture.db`update allrice_employee_assignments set employee_version_id=${candidate} where id=${f.assignment}`;
        const sent = await send(f, s.id);
        const [run] =
          await fixture.db`select employee_version_id from allrice_employee_runs where run_id=${sent.run!.id}`;
        expect(run!.employee_version_id).toBe(f.version);
        const [session] =
          await fixture.db`select employee_version_id,native_root_origin from allrice_chat_sessions where id=${s.id}`;
        expect(session!.employee_version_id).toBe(f.version);
        expect(session!.native_root_origin).toBeNull();
        const fresh = await createAssignedChatSession(f.context, {
          workspaceId: f.workspace,
          employeeAssignmentId: f.assignment,
          title: 'Explicit new-engine Session',
        });
        const [newRow] =
          await fixture.db`select employee_version_id,native_root_origin from allrice_chat_sessions where id=${fresh.id}`;
        expect(newRow!.employee_version_id).toBe(candidate);
        expect(newRow!.native_root_origin.frozenIdentity.sourceId).toBe(
          candidate,
        );
      },
    );
    it('failed business creation rolls back its origin and absence never authorizes later replay', async () => {
      const { runtimePackage } = await packaged(),
        f = await authority(runtimePackage),
        id = randomUUID();
      await expect(
        fixture.db.begin(async (tx) => {
          await createAssignedChatSession(
            f.context,
            {
              workspaceId: f.workspace,
              employeeAssignmentId: f.assignment,
              title: 'Rollback',
            },
            { sessionId: id },
            tx,
          );
          throw Error('fixture rollback');
        }),
      ).rejects.toThrow('fixture rollback');
      expect(
        await fixture.db`select id from allrice_chat_sessions where id=${id}`,
      ).toHaveLength(0);
    });
    it('blocks dropping A for all four persisted origin tables, including never-bound/terminal histories, and preserves exact pin storage', async () => {
      vi.stubEnv(
        'ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID',
        'sha256:' + 'a'.repeat(64),
      );
      const { runtimePackage } = await packaged(),
        f = await authority(runtimePackage);
      const setArtifact = (letter: string) =>
        vi.stubEnv(
          'ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID',
          'sha256:' + letter.repeat(64),
        );
      setArtifact('c');
      const chat = await createAssignedChatSession(f.context, {
        workspaceId: f.workspace,
        employeeAssignmentId: f.assignment,
        title: 'Never bound, protects artifact A',
      });
      await fixture.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${chat.id}`;
      setArtifact('7');
      const sixth = await createAssignedChatSession(f.context, {
        workspaceId: f.workspace,
        employeeAssignmentId: f.assignment,
        title: 'Sixth historical reader, never bound',
      });
      await fixture.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${sixth.id}`;
      setArtifact('f');
      const preview = await packaged();
      await fixture.db`update allrice_platform_employee_test_runs set status='failed',completed_at=clock_timestamp() where id=${preview.test.id}`;
      const technicalId = randomUUID(),
        occurrenceId = randomUUID(),
        automationId = randomUUID();
      // Synthetic reference records in the actual isolated schema. These are
      // not execution admission or a claim that a technical task ran.
      setArtifact('d');
      const technical = newInternalNativeRootOrigin(
        'platform_technical',
        technicalId,
        {},
      );
      setArtifact('e');
      const occurrence = newInternalNativeRootOrigin(
        'experience_consolidation',
        occurrenceId,
        {},
      );
      await fixture.db`insert into allrice_platform_technical_tasks(id,request_id,owner_id,run_id,job_id,organization_id,workspace_id,environment,input_digest,frozen_configuration,native_root_origin)
        values(${technicalId},${randomUUID()},${f.user},${f.rootRunId},${f.worker.jobId},${f.org},${f.workspace},'test',${nativeRootDigest({})},'{}',${fixture.db.json(technical!)})`;
      await fixture.db`insert into allrice_automations(id,organization_id,workspace_id,owner_id,name,prompt,schedule,status)
        values(${automationId},${f.org},${f.workspace},${f.user},'Synthetic retention reference','Never execute','{}','paused')`;
      await fixture.db`insert into allrice_automation_runs(id,organization_id,workspace_id,automation_id,status,scheduled_for,experience_occurrence,native_root_origin)
        values(${occurrenceId},${f.org},${f.workspace},${automationId},'succeeded',clock_timestamp(),'{}',${fixture.db.json(occurrence!)})`;
      const b = {
        artifactId: 'sha256:' + 'b'.repeat(64),
        generation: 'dsh-0.2.1-rc.2-687f282' as const,
        storageRoot: '/current-b',
      };
      await expect(verifyNativeArtifactReferenceCoverage([b])).rejects.toThrow(
        'REFERENCES_UNCOVERED',
      );
      const a = {
        artifactId: 'sha256:' + 'a'.repeat(64),
        generation: b.generation,
        storageRoot: '/isolated-native',
      };
      const sources = [
        ['c', 'origin:chat'],
        ['d', 'origin:platform_technical'],
        ['e', 'origin:experience_consolidation'],
        ['f', 'origin:platform_employee_test'],
        ['7', 'origin:chat'],
      ];
      const all = [
        a,
        ...sources.map(([letter]) => ({
          ...a,
          artifactId: 'sha256:' + letter!.repeat(64),
        })),
      ];
      const covered = await verifyNativeArtifactReferenceCoverage(all);
      // A newly promoted primary must coexist with all six historical
      // readers. Adding capacity grants no authority to alter their pins.
      expect(
        (await verifyNativeArtifactReferenceCoverage([b, ...all])).verified,
      ).toBe(true);
      expect([b, ...all]).toHaveLength(7);
      await expect(
        verifyNativeArtifactReferenceCoverage([
          b,
          ...all,
          { ...b, artifactId: 'sha256:' + '8'.repeat(64) },
        ]),
      ).rejects.toThrow();
      expect(covered.references.map((r) => r.source)).toEqual(
        expect.arrayContaining([
          'binding',
          'origin:chat',
          'origin:platform_technical',
          'origin:experience_consolidation',
          'origin:platform_employee_test',
        ]),
      );
      expect(covered.references.every((r) => r.covered)).toBe(true);
      for (const [letter, source] of sources) {
        const id = 'sha256:' + letter!.repeat(64);
        let missing;
        try {
          await verifyNativeArtifactReferenceCoverage(
            all.filter((x) => x.artifactId !== id),
          );
        } catch (error) {
          missing = JSON.parse(
            (error as Error).message.replace(
              'DSH_NATIVE_ARTIFACT_REFERENCES_UNCOVERED ',
              '',
            ),
          );
        }
        expect(missing).toEqual([
          {
            source,
            artifactId: id,
            generation: b.generation,
            profileId: letter === 'd' ? 'technical' : 'restricted',
            records: 1,
            covered: false,
          },
        ]);
      }
      await expect(
        verifyNativeArtifactReferenceCoverage(
          all.map((x) => ({ ...x, storageRoot: '/moved-a' })),
        ),
      ).rejects.toThrow('REFERENCES_UNCOVERED');
      await expect(
        verifyNativeArtifactReferenceCoverage([a, a]),
      ).rejects.toThrow('DUPLICATE_APPROVAL');
      expect(
        (
          await fixture.db`select native_root_origin from allrice_automation_runs where id=${occurrenceId}`
        )[0]!.native_root_origin,
      ).toEqual(occurrence);
      setArtifact('a');
    });
    it(
      'preserves the exact existing preview directory without granting it to chats or a moved execution root',
      { timeout: 30000 },
      async () => {
        const isolated = await createAssistantFixtureDatabase();
        vi.mocked(client.getDatabase).mockReturnValue(isolated.db);
        try {
          vi.stubEnv(
            'ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID',
            'sha256:' + 'a'.repeat(64),
          );
          const e = await createEmployeeAdministrationFixture(isolated.db);
          const queued = await queuePlatformEmployeeTestRun(e.employeeId, {
            environment: 'company',
            workspaceId: e.workspaceId,
            ownerId: e.ownerId,
            prompt: 'Synthetic retained preview storage only',
          });
          const workerId = randomUUID();
          const test = (await claimNextPlatformEmployeeTestRun(workerId))!;
          expect(test.id).toBe(queued.testRun!.id);
          const descriptor = nativeBindingDescriptor({
            organizationId: test.previewContext.organizationId,
            workspaceId: test.previewContext.workspaceId,
            ownerId: test.previewContext.ownerId,
            contextKey: test.id,
            distributionGeneration: 'dsh-0.2.1-rc.2-687f282',
          });
          descriptor.storageNamespace = descriptor.storageNamespace.replace(
            '/isolated-native/',
            `/existing-executions/platform-employee-tests/${test.id}/`,
          );
          await bindJobNativeSession({
            workerId,
            jobId: test.previewExecution.jobId,
            leaseToken: test.previewExecution.leaseToken,
            attempt: test.previewExecution.jobAttempt,
            subject: { kind: 'platform_employee_test', id: test.id },
            descriptor,
          });
          const a = {
            artifactId: descriptor.artifactId,
            generation: 'dsh-0.2.1-rc.2-687f282' as const,
            storageRoot: '/isolated-native',
            previewStorageRoot: '/existing-executions/platform-employee-tests',
          };
          expect(
            (await verifyNativeArtifactReferenceCoverage([a])).verified,
          ).toBe(true);
          await expect(
            verifyNativeArtifactReferenceCoverage([
              {
                ...a,
                previewStorageRoot: '/moved-executions/platform-employee-tests',
              },
            ]),
          ).rejects.toThrow('REFERENCES_UNCOVERED');
          const runtimePackage = test.runtimeProfile.runtimePackage!;
          const f = await createAssistantAuthorityFixture(isolated.db, {
            configure: false,
            runtimePackage,
            businessCreationOrigin: true,
          });
          await isolated.db`update allrice_jobs set attempt=1 where id=${f.worker.jobId}`;
          const [r] =
            await isolated.db`select * from allrice_conversation_runtimes where session_id=${f.session}`;
          const chat = nativeBindingDescriptor({
            organizationId: f.org,
            workspaceId: f.workspace,
            ownerId: f.user,
            contextKey: f.session,
            distributionGeneration: a.generation,
          });
          chat.storageNamespace = chat.storageNamespace.replace(
            '/isolated-native/',
            `/existing-executions/platform-employee-tests/${f.session}/`,
          );
          await bindJobNativeSession({
            workerId: f.worker.workerId,
            jobId: f.worker.jobId,
            leaseToken: f.worker.leaseToken,
            attempt: 1,
            subject: {
              kind: 'chat',
              id: f.session,
              configChecksum: r!.config_checksum,
              generation: r!.thread_generation,
              expectedThreadId: r!.thread_id,
            },
            descriptor: chat,
          });
          await expect(
            verifyNativeArtifactReferenceCoverage([a]),
          ).rejects.toThrow('REFERENCES_UNCOVERED');
          expect(
            (
              await isolated.db`select storage_namespace from allrice_native_session_bindings where native_session_id=${descriptor.nativeSessionId}`
            )[0]!.storage_namespace,
          ).toBe(descriptor.storageNamespace);
        } finally {
          vi.mocked(client.getDatabase).mockReturnValue(fixture.db);
          await isolated.close();
        }
      },
    );
    it(
      'protects a pin independently after a legacy Run finishes and its NULL-origin Session is archived',
      { timeout: 30000 },
      async () => {
        const isolated = await createAssistantFixtureDatabase();
        vi.mocked(client.getDatabase).mockReturnValue(isolated.db);
        try {
          const f = await createAssistantAuthorityFixture(isolated.db, {
            configure: false,
          });
          await isolated.db`update allrice_jobs set attempt=1 where id=${f.worker.jobId}`;
          const [r] =
            await isolated.db`select * from allrice_conversation_runtimes where session_id=${f.session}`;
          const descriptor = nativeBindingDescriptor({
            organizationId: f.org,
            workspaceId: f.workspace,
            ownerId: f.user,
            contextKey: f.session,
          });
          await bindJobNativeSession({
            workerId: f.worker.workerId,
            jobId: f.worker.jobId,
            leaseToken: f.worker.leaseToken,
            attempt: 1,
            subject: {
              kind: 'chat',
              id: f.session,
              configChecksum: r!.config_checksum,
              generation: r!.thread_generation,
              expectedThreadId: r!.thread_id,
            },
            descriptor,
          });
          await isolated.db`update allrice_runs set state='succeeded' where id=${f.rootRunId}`;
          await isolated.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${f.session}`;
          const a = {
            artifactId: descriptor.artifactId,
            generation: 'dsh-0.1.5-rc.3-a4c74a9' as const,
            storageRoot: '/isolated-native',
          };
          const covered = await verifyNativeArtifactReferenceCoverage([a]);
          expect(covered.references).toEqual([
            {
              source: 'binding',
              artifactId: a.artifactId,
              generation: a.generation,
              profileId: 'restricted',
              records: 1,
              covered: true,
            },
          ]);
          await expect(
            verifyNativeArtifactReferenceCoverage([
              { ...a, artifactId: 'sha256:' + 'b'.repeat(64) },
            ]),
          ).rejects.toThrow('REFERENCES_UNCOVERED');
        } finally {
          vi.mocked(client.getDatabase).mockReturnValue(fixture.db);
          await isolated.close();
        }
      },
    );
  },
);
