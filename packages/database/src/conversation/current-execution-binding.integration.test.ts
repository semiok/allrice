const oldGeneration = 'dsh-0.1.5-rc.3-a4c74a9' as const;
/** Real SQL admission/dispatch only. No native Host, provider, Dev API or live
 * application database is used; the existing fixture owns a UUID schema. */
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import {
  EmployeeDefinitionSchema,
  EmployeeExecutionSnapshotSchema,
  type EmployeeRuntimePackage,
} from '@allrice/contracts';
import * as client from '../core/client.ts';
import { createAssistantFixtureDatabase } from '../assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from '../assistant-authority.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import { createSession, authenticateSession } from '../identity.ts';
import {
  createAssignedChatSession,
  ensureDefaultEmployee,
  sendChatMessage,
} from '../workspace/service.ts';
import { resolveEmployeeExecution } from '../employees/employeehub.ts';
import { employeeManifestChecksum } from '../employees/employee-config.ts';
import {
  buildEmployeeRuntimePackage,
  runtimePackageChecksum,
  verifiedRuntimePackageChecksum,
} from '../platform-employees/runtime-package.ts';
import {
  bindJobNativeSession,
  cancelRun,
  claimNextJob,
  failJob,
  maintainQueue,
  prepareJobNativeSession,
  startClaimedJob,
} from '../execution/queue.ts';
import { nativeBindingDescriptor } from '../native-session-binding.fixture.ts';
import { acquireConversationRuntime } from './conversation-runtime.ts';
import {
  readChatNativeRootOrigin,
  type NativeSessionLeaseInput,
} from './native-session-binding.ts';
import {
  CurrentEmployeeChatOriginSchema,
  EmployeeRunExecutionBindingSchema,
  nativeRootDigest,
  newNativeGeneration,
} from './current-execution-binding.ts';
import { selectCheckedFinalDeliveryArtifact } from '../final-delivery-rollout.ts';
import { synchronizeTenantEmployeeAccess } from '../tenant-employee-access.ts';
import { updateEmployeeRelease } from '../employees/employee-quality.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const currentArtifact = `sha256:${'a'.repeat(64)}`;
const otherArtifact = `sha256:${'b'.repeat(64)}`;
const tools = [
  'assistant.delegate',
  'assistant.report',
  'workspace.export.create',
  'workspace.skill.read',
];
type SourceKind =
  | 'default-rice'
  | 'legacy-package2'
  | 'current-package2'
  | 'legacy-package1-plain'
  | 'current-package1-plain'
  | 'legacy-package1-empty'
  | 'current-package1-empty';

integration(
  'MET195 current execution binding: complete isolated SQL chain',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    let schema: string;
    let currentPackage: EmployeeRuntimePackage;
    let plainPackage: EmployeeRuntimePackage;
    let emptyPackage: EmployeeRuntimePackage;
    let platformSource: Pick<
      Awaited<ReturnType<typeof createEmployeeAdministrationFixture>>,
      'employeeId' | 'revisionId'
    >;
    const submitted: { f: Subject; runId: string }[] = [];
    let fetchSpy: MockInstance<typeof globalThis.fetch>;
    type JsonValue = Parameters<typeof fixture.db.json>[0];
    const toJsonValue = (value: unknown): JsonValue =>
      JSON.parse(JSON.stringify(value)) as JsonValue;

    beforeAll(async () => {
      for (const key of Object.keys(process.env))
        if (key.startsWith('ALLRICE_DSH_ORIGIN_READER_'))
          vi.stubEnv(key, undefined);
      // MET-221: the release primary is the only birth input; the retired
      // new-root ID and checked-delivery allowlist are not read.
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', currentArtifact);
      for (const flag of [
        'ALLRICE_ASSISTANTS_ENABLED',
        'ALLRICE_WORKBENCH_ENABLED',
        'ALLRICE_RUNTIME_POLICY_ENABLED',
      ])
        vi.stubEnv(flag, '1');
      fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(
          Error('This isolated SQL test must not make external requests'),
        );
      fixture = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      const [scope] =
        await fixture.db`select current_schema() name,current_database() database`;
      schema = scope!.name;
      expect(schema).toMatch(/^p25_[a-f0-9]{32}$/);
      expect(['allrice_b2', 'allrice']).toContain(scope!.database);
      const owned = await fixture.db`select n.nspname from pg_class c
      join pg_namespace n on n.oid=c.relnamespace where c.oid in (
      to_regclass('allrice_chat_sessions'),to_regclass('allrice_employee_runs'),
      to_regclass('allrice_jobs'),to_regclass('allrice_native_session_bindings'))`;
      expect(owned).toHaveLength(4);
      expect(owned.every((row) => row.nspname === schema)).toBe(true);
      const template = await createEmployeeAdministrationFixture(fixture.db);
      platformSource = template;
      const skills = await fixture.db<
        Parameters<typeof buildEmployeeRuntimePackage>[0]['skills']
      >`select * from allrice_platform_dsh_skills where id=${template.skillId}`;
      const definition = {
        ...template.definition,
        capabilities: {
          ...template.definition.capabilities,
          toolNames: tools,
        },
      };
      currentPackage = buildEmployeeRuntimePackage({
        revision: 1,
        definition,
        skills,
      });
      expect(currentPackage.schemaVersion).toBe(2);
      plainPackage = buildEmployeeRuntimePackage({
        revision: 1,
        definition,
        skills: skills.map(({ bundle: unused, ...skill }) => {
          void unused;
          return skill;
        }),
      });
      emptyPackage = buildEmployeeRuntimePackage({
        revision: 1,
        definition: {
          ...definition,
          capabilities: { ...definition.capabilities, nativeSkillIds: [] },
        },
        skills: [],
      });
      expect(plainPackage.schemaVersion).toBe(1);
      expect(plainPackage.skills).toHaveLength(1);
      expect(plainPackage.skills[0]!.bundle).toBeUndefined();
      expect(emptyPackage.schemaVersion).toBe(1);
      expect(emptyPackage.skills).toEqual([]);
      for (const pkg of [currentPackage, plainPackage, emptyPackage])
        expect(verifiedRuntimePackageChecksum(pkg)).toBe(pkg.checksum);
    }, 120_000);

    afterEach(async () => {
      // Only jobs created by the tested API are canceled. The fixture closes its
      // remaining synthetic roots with the entire owned schema, never a live run.
      for (const { f, runId } of submitted.splice(0))
        await cancelRun(f.context, f.workspace, runId, {
          reason: 'Owned SQL fixture cleanup; no model executed',
        });
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', currentArtifact);
      vi.stubEnv('ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS', undefined);
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', undefined);
    });

    afterAll(async () => {
      try {
        if (fixture) {
          const cleanup = await fixture.close();
          expect(cleanup).toMatchObject({
            schema,
            schemaRemoved: true,
            storageRemoved: true,
            databaseClosed: true,
            adminClosed: true,
          });
          console.info('current_binding_sql_cleanup', JSON.stringify(cleanup));
        }
      } finally {
        const externalCalls = fetchSpy?.mock.calls.length ?? 0;
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        expect(externalCalls).toBe(0);
      }
    }, 30_000);

    function packageFor(kind: Exclude<SourceKind, 'default-rice'>) {
      const pkg = structuredClone(
        kind.endsWith('-plain')
          ? plainPackage
          : kind.endsWith('-empty')
            ? emptyPackage
            : currentPackage,
      );
      pkg.runtimeManifest.distributionGeneration = kind.startsWith('legacy-')
        ? oldGeneration
        : newNativeGeneration;
      const p = pkg.runtimeManifest;
      pkg.capabilityFingerprint = runtimePackageChecksum({
        distributionGeneration: p.distributionGeneration,
        provider: p.provider,
        model: p.model,
        tools: [...p.toolNames].sort(),
        skills: pkg.skills.map((skill) => ({
          name: skill.name,
          checksum: skill.checksum,
          requiredToolRefs: [...skill.requiredToolRefs].sort(),
          ...(skill.bundle ? { bundleChecksum: skill.bundle.checksum } : {}),
        })),
        deniedCapabilities: [...p.deniedCapabilities].sort(),
      });
      pkg.checksum = runtimePackageChecksum({
        schemaVersion: pkg.schemaVersion,
        packageVersion: pkg.packageVersion,
        capabilityFingerprint: pkg.capabilityFingerprint,
        files: {
          identityMd: pkg.files.identityMd,
          soulMd: pkg.files.soulMd,
          userMd: pkg.files.userMd,
          agentsMd: pkg.files.agentsMd,
        },
        skills: pkg.skills,
        runtimeManifest: p,
      });
      expect(verifiedRuntimePackageChecksum(pkg)).toBe(pkg.checksum);
      return pkg;
    }

    async function subject(kind: SourceKind, legacyBirth = false) {
      const pkg = kind === 'default-rice' ? undefined : packageFor(kind);
      const f = await createAssistantAuthorityFixture(fixture.db, {
        configure: false,
        memberRole: 'member',
        runtimePackage: pkg,
        allowedTools: tools,
        runtimePolicy: {
          harness: 'dsh',
          provider: 'openai-codex',
          model: pkg?.runtimeManifest.model ?? 'synthetic-never-called',
          reasoningEffort: 'low',
          timeoutMs: 300_000,
          fallbackModels: [],
          credentialReference: 'deployment:synthetic-never-resolved',
          baseUrl: null,
        },
        businessCreationOrigin: legacyBirth && kind === 'current-package2',
      });
      const login = await createSession(f.user);
      const context = await authenticateSession(login.token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      });
      if (!context) throw Error('isolated_login_required');
      let assignment = f.assignment,
        employee = f.employee,
        version = f.version;
      if (kind === 'default-rice' && !legacyBirth) {
        await ensureDefaultEmployee(context, f.workspace);
        // Provisioning preserves the fixture's existing default employee. Read
        // the Rice assignment it actually inserted, not its returned default.
        const [row] =
          await fixture.db`select a.id,a.employee_id,a.employee_version_id
          from allrice_employee_assignments a join allrice_employees e on e.id=a.employee_id
          where a.organization_id=${f.org} and a.workspace_id=${f.workspace}
            and a.user_id=${f.user} and a.active and e.employee_key='default-assistant'`;
        if (!row) throw Error('default_rice_required');
        assignment = row.id;
        employee = row.employee_id;
        version = row.employee_version_id;
      }
      const [versionRow] =
        await fixture.db`select manifest,config_checksum from allrice_employee_versions where id=${version}`;
      const manifest = EmployeeDefinitionSchema.parse(versionRow!.manifest);
      if (kind === 'default-rice') {
        expect(manifest.key).toBe('default-assistant');
        expect(versionRow!.config_checksum).toBe(
          employeeManifestChecksum(manifest),
        );
      }
      const chat = legacyBirth
        ? f.session
        : (
            await createAssignedChatSession(context, {
              workspaceId: f.workspace,
              employeeAssignmentId: assignment,
              title: 'Owned B1 SQL acceptance; never execute a model',
            })
          ).id;
      return {
        ...f,
        context,
        assignment,
        employee,
        version,
        manifest,
        configChecksum: versionRow!.config_checksum as string,
        chat,
      };
    }
    type Subject = Awaited<ReturnType<typeof subject>>;
    const scope = (f: Subject) => ({
      organizationId: f.org,
      workspaceId: f.workspace,
      ownerId: f.user,
      sessionId: f.chat,
    });
    async function birth(f: Subject) {
      const [row] =
        await fixture.db`select native_root_origin from allrice_chat_sessions where id=${f.chat}`;
      return row!.native_root_origin;
    }
    async function send(
      f: Subject,
      clientMessageId = randomUUID(),
      assistants = false,
    ) {
      const result = await sendChatMessage(f.context, f.workspace, f.chat, {
        text: 'Synthetic SQL-only current execution acceptance; do not call a model',
        clientMessageId,
        deliveryMode: 'follow_up',
        assistantPreference: { mode: 'daily', allowAssistants: assistants },
      });
      if (!result.run) throw Error('fixture_run_not_enqueued');
      if (!submitted.some((item) => item.runId === result.run!.id))
        submitted.push({ f, runId: result.run.id });
      return result.run.id;
    }
    async function stored(runId: string) {
      const [row] =
        await fixture.db`select employee_version_id,execution_snapshot,native_execution_binding
      from allrice_employee_runs where run_id=${runId}`;
      if (!row) throw Error('fixture_run_missing');
      return row;
    }
    async function lease(
      f: Subject,
      runId: string,
      generation: NativeSessionLeaseInput['descriptor']['distributionGeneration'] = newNativeGeneration,
    ) {
      const claimed = await claimNextJob(f.worker.workerId, 120_000);
      expect(claimed).not.toBeNull();
      const [job] =
        await fixture.db`select run_id from allrice_jobs where id=${claimed!.id}`;
      expect(job!.run_id).toBe(runId);
      expect(
        await startClaimedJob(
          f.worker.workerId,
          claimed!.id,
          claimed!.lease!.token,
        ),
      ).not.toBeNull();
      const current = await stored(runId);
      const execution = EmployeeExecutionSnapshotSchema.parse(
        current.execution_snapshot,
      );
      const conversation = await acquireConversationRuntime({
        ...scope(f),
        runId,
        workerId: f.worker.workerId,
        configChecksum: execution.employee.definitionChecksum,
        compactThresholdTokens: 10_000,
      });
      const descriptor = nativeBindingDescriptor({
        ...scope(f),
        contextKey: f.chat,
        distributionGeneration: generation,
      });
      const input: NativeSessionLeaseInput = {
        workerId: f.worker.workerId,
        jobId: claimed!.id,
        leaseToken: claimed!.lease!.token,
        attempt: claimed!.attempt,
        subject: {
          kind: 'chat',
          id: f.chat,
          configChecksum: conversation.configChecksum,
          generation: conversation.generation,
          expectedThreadId: conversation.threadId,
        },
        descriptor,
      };
      return input;
    }
    const prepare = (input: NativeSessionLeaseInput) => {
      const { descriptor, ...admission } = input;
      return prepareJobNativeSession({
        ...admission,
        nativeSessionId: descriptor.nativeSessionId,
        storageContextKey: descriptor.storageContextKey,
      });
    };

    it.each([
      'default-rice',

      'current-package2',

      'current-package1-plain',

      'current-package1-empty',
    ] as const)(
      '%s creates v2 at real chat INSERT and carries a current execution binding through send/resolve/leased bind',
      async (kind) => {
        const f = await subject(kind);
        const origin = CurrentEmployeeChatOriginSchema.parse(await birth(f));
        expect(origin.birthSource).toMatchObject({
          employeeVersionId: f.version,
          configChecksum: f.configChecksum,
          packageSchema: f.manifest.runtimePackage?.schemaVersion ?? null,
          declaredGeneration:
            kind === 'default-rice'
              ? null
              : kind.startsWith('legacy-')
                ? oldGeneration
                : newNativeGeneration,
        });
        if (kind === 'default-rice') {
          expect(f.manifest.key).toBe('default-assistant');
          expect(f.manifest.runtimePackage).toBeNull();
        }
        if (kind.includes('package1'))
          expect(origin.sourcePolicy.variant).toBe(
            kind.startsWith('legacy-')
              ? 'legacy_published_package_v1'
              : 'current_published_package_v1',
          );
        const id = await send(f),
          before = await stored(id);
        const binding = EmployeeRunExecutionBindingSchema.parse(
          before.native_execution_binding,
        );
        expect(binding.execution).toEqual({
          artifactId: currentArtifact,
          generation: newNativeGeneration,
          profileId: 'restricted',
        });
        expect(binding.originDigest).toBe(nativeRootDigest(origin));
        expect(binding.scope).toEqual({ ...scope(f), runId: id });
        const execution = await resolveEmployeeExecution({
          ...scope(f),
          runId: id,
        });
        expect(execution.executionSnapshot?.employee.versionId).toBe(f.version);
        expect(
          EmployeeDefinitionSchema.parse(
            execution.executionSnapshot?.employee.definition,
          ).runtimePackage,
        ).toEqual(f.manifest.runtimePackage);
        const input = await lease(f, id);
        const prepared = await prepare(input);
        expect(prepared.origin).toEqual(origin);
        expect(prepared.executionBinding).toEqual(binding);
        expect(prepared.binding).toBeNull();
        const bound = await bindJobNativeSession(input);
        expect(bound.binding).toMatchObject({
          artifactId: currentArtifact,
          distributionGeneration: newNativeGeneration,
          bindingBasis: 'business_root_origin',
          rootOriginDigest: nativeRootDigest(origin),
        });
        expect((await prepare(input)).executionBinding).toEqual(binding);
        expect(await stored(id)).toEqual(before);
      },
      30_000,
    );

    it.each([null, 'current-package1-plain'] as const)(
      'updates the same-family source to %s for the next message while birth and already queued Run remain immutable',
      async (target) => {
        const f = await subject('legacy-package2');
        const origin = await birth(f),
          first = await send(f),
          before = await stored(first);
        const input = await lease(f, first);
        const nextManifest = EmployeeDefinitionSchema.parse({
          ...f.manifest,
          runtimePackage: target === null ? null : packageFor(target),
        });
        const nextVersion = randomUUID();
        await fixture.db`insert into allrice_employee_versions
      (id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
      values(${nextVersion},${f.org},${f.workspace},${f.employee},2,${nextManifest.name},${nextManifest.provider.model},
      ${nextManifest.systemPrompt},${fixture.db.json(nextManifest.capabilities)},${nextManifest.runtimePackage?.checksum ?? employeeManifestChecksum(nextManifest)},
      ${fixture.db.json(nextManifest)},${fixture.db.json(nextManifest.provider)})`;
        await fixture.db`update allrice_employee_assignments set employee_version_id=${nextVersion} where id=${f.assignment}`;
        const next = await send(f),
          after = await stored(next);
        expect(after.employee_version_id).toBe(nextVersion);
        expect(
          EmployeeRunExecutionBindingSchema.parse(
            after.native_execution_binding,
          ).source,
        ).toMatchObject({
          employeeVersionId: nextVersion,
          packageSchema: nextManifest.runtimePackage?.schemaVersion ?? null,
          packageChecksum: nextManifest.runtimePackage?.checksum ?? null,
        });
        expect(await birth(f)).toEqual(origin);
        expect(await stored(first)).toEqual(before);
        expect((await prepare(input)).executionBinding).toEqual(
          before.native_execution_binding,
        );
        expect((await bindJobNativeSession(input)).binding.artifactId).toBe(
          currentArtifact,
        );
        expect(
          (await resolveEmployeeExecution({ ...scope(f), runId: first }))
            .executionSnapshot?.employee.versionId,
        ).toBe(f.version);
      },
      30_000,
    );

    it.each([
      ['tenant-inheritance', 'current-package2'],

      ['quality-release', 'current-package2'],
    ] as const)(
      '%s synchronizes v2 while preserving the incompatible historical %s session',
      async (path, kind) => {
        const f = await subject(kind, true);
        const oldBirth = await birth(f),
          oldRun = await stored(f.rootRunId);
        const currentChat = await createAssignedChatSession(f.context, {
          workspaceId: f.workspace,
          employeeAssignmentId: f.assignment,
          title: 'Current execution alongside historical identity',
        });
        const current = { ...f, chat: currentChat.id };
        const currentBirth = await birth(current);
        const currentRunId = await send(current),
          currentRun = await stored(currentRunId);
        // Changed declarations are incompatible with the historical birth,
        // but both reviewed declarations are allowed within the v2 family.
        const target = EmployeeDefinitionSchema.parse({
          ...f.manifest,
          runtimePackage: null,
        });
        const version = randomUUID();
        await fixture.db`insert into allrice_employee_versions
          (id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
          values(${version},${f.org},${f.workspace},${f.employee},2,${target.name},${target.provider.model},
          ${target.systemPrompt},${fixture.db.json(target.capabilities)},${target.runtimePackage?.checksum ?? employeeManifestChecksum(target)},
          ${fixture.db.json(target)},${fixture.db.json(target.provider)})`;
        const [before] =
          await fixture.db`select updated_at from allrice_chat_sessions where id=${current.chat}`;
        if (path === 'tenant-inheritance') {
          // First-INSERT synthetic deployment metadata; use the actual shared
          // synchronizer to materialize memberships and advance assignments.
          await fixture.db`insert into allrice_platform_employee_tenant_assignments
            (employee_id,revision_id,organization_id,workspace_id,tenant_employee_id,tenant_employee_version_id)
            values(${platformSource.employeeId},${platformSource.revisionId},${f.org},${f.workspace},${f.employee},${version})`;
          await fixture.db.begin((tx) =>
            synchronizeTenantEmployeeAccess(tx, {
              organizationId: f.org,
              workspaceId: f.workspace,
            }),
          );
        } else {
          vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', `${f.user}@example.test`);
          // The existing quality API initializes its stable release from the
          // latest immutable version. Rollback has no fabricated model gate.
          await updateEmployeeRelease(f.context, {
            workspaceId: f.workspace,
            employeeId: f.employee,
            action: 'rollback',
          });
        }
        const [assignment] =
          await fixture.db`select employee_version_id from allrice_employee_assignments where id=${f.assignment}`;
        expect(assignment!.employee_version_id).toBe(version);
        const sessions =
          await fixture.db`select id,employee_version_id,updated_at from allrice_chat_sessions where id in ${fixture.db([f.chat, current.chat])}`;
        expect(
          sessions.find((row) => row.id === f.chat)!.employee_version_id,
        ).toBe(f.version);
        expect(sessions.find((row) => row.id === current.chat)).toMatchObject({
          employee_version_id: version,
          updated_at: before!.updated_at,
        });
        expect(await birth(f)).toEqual(oldBirth);
        expect(await birth(current)).toEqual(currentBirth);
        expect(await stored(f.rootRunId)).toEqual(oldRun);
        expect(await stored(currentRunId)).toEqual(currentRun);
      },
      30_000,
    );

    it('repeated browser delivery and a real retry lease reuse the original Run binding despite changed deployment approval', async () => {
      const f = await subject('current-package2'),
        clientMessageId = randomUUID();
      const id = await send(f, clientMessageId),
        before = await stored(id);
      const input = await lease(f, id);
      await bindJobNativeSession(input);
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', otherArtifact);
      expect(await send(f, clientMessageId)).toBe(id);
      expect(
        await failJob({
          workerId: input.workerId,
          jobId: input.jobId,
          leaseToken: input.leaseToken,
          code: 'SYNTHETIC_RETRY',
          message: 'No provider executed',
          retryable: true,
          retryBaseMs: 0,
        }),
      ).toMatchObject({ retrying: true });
      await maintainQueue();
      const retried = await lease(f, id);
      expect(retried.attempt).toBe(input.attempt + 1);
      const prepared = await prepare(retried);
      expect(prepared.requiresRecovery).toBe(true);
      expect(prepared.executionBinding).toEqual(
        before.native_execution_binding,
      );
      expect((await bindJobNativeSession(retried)).binding.artifactId).toBe(
        currentArtifact,
      );
      expect(await stored(id)).toEqual(before);
      await expect(
        fixture.db`update allrice_employee_runs set native_execution_binding=null where run_id=${id}`,
      ).rejects.toThrow('employee execution binding is immutable');
    }, 30_000);

    it.each(['current-package2'] as const)(
      'preserves an existing %s NULL/v1 birth and queued snapshot without creating a private binding',
      async (kind) => {
        const f = await subject(kind, true),
          origin = await birth(f);
        expect(origin?.schemaVersion ?? null).toBe(1);
        const before = await stored(f.rootRunId);
        expect(before.native_execution_binding).toBeNull();
        // Authority fixture roots intentionally have no real prompt. Close that
        // synthetic lease through the queue API; the next actual send supplies
        // a full prompt and exercises the preserved historical session.
        expect(
          await failJob({
            ...f.worker,
            code: 'SYNTHETIC_FIXTURE_SEED',
            message: 'Unexecuted authority setup root closed for SQL admission',
            retryable: false,
          }),
        ).toEqual({ retrying: false });
        const input = {
          workspaceId: f.workspace,
          employeeAssignmentId: f.assignment,
          title: 'Existing historical identity',
        };
        expect(
          (
            await createAssignedChatSession(f.context, input, {
              sessionId: f.chat,
            })
          ).id,
        ).toBe(f.chat);
        expect(await birth(f)).toEqual(origin);
        const id = await send(f),
          row = await stored(id);
        expect(row.native_execution_binding).toBeNull();
        expect(
          (await resolveEmployeeExecution({ ...scope(f), runId: id }))
            .executionSnapshot,
        ).not.toBeNull();
        const execution = await lease(f, id, newNativeGeneration);
        expect((await prepare(execution)).executionBinding).toBeNull();
        expect(
          (await bindJobNativeSession(execution)).binding.bindingBasis,
        ).toBe('business_root_origin');
        expect(await stored(f.rootRunId)).toEqual(before);
      },
      30_000,
    );

    it('rejects foreign owners and foreign chat subjects before creating any native binding', async () => {
      const f = await subject('current-package2'),
        other = await subject('current-package2');
      const id = await send(f),
        input = await lease(f, id);
      await expect(
        sendChatMessage(other.context, f.workspace, f.chat, {
          text: 'Foreign access must fail',
          clientMessageId: randomUUID(),
        }),
      ).rejects.toThrow();
      await expect(
        resolveEmployeeExecution({
          ...scope(f),
          ownerId: other.user,
          runId: id,
        }),
      ).rejects.toThrow();
      const foreign = {
        ...input,
        subject: {
          ...input.subject,
          kind: 'chat' as const,
          id: other.chat,
          configChecksum:
            input.subject.kind === 'chat' ? input.subject.configChecksum : '',
          generation:
            input.subject.kind === 'chat' ? input.subject.generation : 0,
          expectedThreadId: null,
        },
      };
      await expect(prepare(foreign)).rejects.toThrow();
      await expect(bindJobNativeSession(foreign)).rejects.toThrow();
      expect(
        await fixture.db`select native_session_id from allrice_native_session_bindings where context_id=${f.chat}`,
      ).toHaveLength(0);
    }, 30_000);

    async function corruptOwnedRun(
      runId: string,
      snapshot?: ReturnType<typeof EmployeeExecutionSnapshotSchema.parse>,
    ) {
      const [actual] = await fixture.db`select current_schema() name`;
      if (actual?.name !== schema || !/^p25_[a-f0-9]{32}$/.test(schema))
        throw Error('owned_schema_required_for_corruption_fixture');
      const trigger = snapshot
        ? 'allrice_employee_runs_snapshot_immutable'
        : 'employee_execution_binding_guard';
      await fixture.db.begin(async (tx) => {
        // Simulate damaged preexisting storage only inside this owned UUID schema.
        // Re-enable in the same transaction; production immutability is tested separately.
        await tx.unsafe(
          `alter table "${schema}".allrice_employee_runs disable trigger ${trigger}`,
        );
        if (snapshot)
          await tx`update allrice_employee_runs set execution_snapshot=${tx.json(toJsonValue(snapshot))} where run_id=${runId}`;
        else
          await tx`update allrice_employee_runs set native_execution_binding=null where run_id=${runId}`;
        await tx.unsafe(
          `alter table "${schema}".allrice_employee_runs enable trigger ${trigger}`,
        );
      });
    }
    it.each(['snapshot', 'missing-binding'] as const)(
      'fails closed for damaged %s on resolve, leased prepare and final bind',
      async (damage) => {
        const f = await subject('legacy-package2'),
          id = await send(f),
          input = await lease(f, id);
        const before = await stored(id);
        if (damage === 'snapshot') {
          const snapshot = EmployeeExecutionSnapshotSchema.parse(
            before.execution_snapshot,
          );
          snapshot.runtimePolicy.model = 'tampered-after-admission';
          await expect(
            fixture.db`update allrice_employee_runs set execution_snapshot=${fixture.db.json(toJsonValue(snapshot))} where run_id=${id}`,
          ).rejects.toThrow('employee run execution snapshots are immutable');
          await corruptOwnedRun(id, snapshot);
        } else {
          await expect(
            fixture.db`update allrice_employee_runs set native_execution_binding=null where run_id=${id}`,
          ).rejects.toThrow('employee execution binding is immutable');
          await corruptOwnedRun(id);
        }
        await expect(
          resolveEmployeeExecution({ ...scope(f), runId: id }),
        ).rejects.toThrow();
        await expect(prepare(input)).rejects.toThrow();
        await expect(bindJobNativeSession(input)).rejects.toThrow();
        expect(
          await fixture.db`select native_session_id from allrice_native_session_bindings where context_id=${f.chat}`,
        ).toHaveLength(0);
        expect((await stored(id)).native_execution_binding).toEqual(
          damage === 'missing-binding' ? null : before.native_execution_binding,
        );
      },
      30_000,
    );

    // MET-221: checked final delivery is every release's protocol on the
    // restricted profile. The retired allowlist is ignored and the frozen
    // artifact is the origin's (provenance), even under a later primary.
    it('admits checked final delivery for a business-origin chat with its origin artifact and retains assistant opt-out', async () => {
      const f = await subject('legacy-package2');
      vi.stubEnv('ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS', '[]');
      expect(
        await fixture.db.begin((tx) =>
          selectCheckedFinalDeliveryArtifact(tx, scope(f)),
        ),
      ).toBe(currentArtifact);
      const included = await send(f, randomUUID(), true);
      expect(
        (await stored(included)).execution_snapshot.finalDeliveryPolicy,
      ).toEqual({
        version: 1,
        mode: 'checked_native_v1',
        artifactId: currentArtifact,
      });
      expect(
        (await stored(included)).execution_snapshot.officeFirstDeliveryPolicy,
      ).toBe('xlsx_formula_cache_v1');
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', otherArtifact);
      expect(
        await fixture.db.begin((tx) =>
          selectCheckedFinalDeliveryArtifact(tx, scope(f)),
        ),
      ).toBe(currentArtifact);
      const later = await send(f, randomUUID(), true);
      expect(
        (await stored(later)).execution_snapshot.finalDeliveryPolicy,
      ).toEqual({
        version: 1,
        mode: 'checked_native_v1',
        artifactId: currentArtifact,
      });
      const optedOut = await send(f, randomUUID(), false);
      expect((await stored(optedOut)).execution_snapshot).not.toHaveProperty(
        'finalDeliveryPolicy',
      );
      const history = await subject('legacy-package2', true);
      expect(
        await fixture.db.begin((tx) =>
          readChatNativeRootOrigin(tx, scope(history)),
        ),
      ).toBeNull();
      expect(
        await fixture.db.begin((tx) =>
          selectCheckedFinalDeliveryArtifact(tx, scope(history)),
        ),
      ).toBeUndefined();
    }, 30_000);
  },
);
