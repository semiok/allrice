import {
  legacyRuntimePackageFixture,
  syntheticLegacyRuntimePackage,
} from '../platform-employees/legacy-runtime-package.fixture.ts';
/** Actual owner/authentication/publication/chat/queue/resolve in an isolated DB.
 * Synthetic preview completion only; no provider, native model or Dev data. */
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
import {
  DefaultPartnerProfile,
  EmployeeExecutionSnapshotSchema,
  EmployeeManifestSchema,
  EmployeePersonaPinSchema,
  EmployeePromptSnapshotSchema,
  PlatformEmployeeRuntimeProfileSchema,
  type EmployeeInstanceProfile,
  type PlatformEmployeeDefinition,
  type RequestContext,
} from '@allrice/contracts';
import * as client from '../core/client.ts';
import * as hub from './employeehub.ts';
import { createRuntimeFixtureDatabase } from '../runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import { createRunAuthorityFixture } from '../run-authority.fixture.ts';
import { approveSyntheticCurrentEmployeeExecution } from '../current-execution.fixture.ts';
import { isPlatformAdmin } from '../platform-authority.ts';
import { isBaseRiceInstance } from './employee-instance-policy.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from '../identity.ts';
import {
  createChatSession,
  ensureDefaultEmployee,
  getEmployeeWorkspace,
  sendChatMessage,
} from '../workspace/service.ts';
import {
  createEmployeeInstance,
  getEmployeeInstance,
  updateEmployeeInstance,
} from './employee-instances.ts';
import { savePlatformEmployeeDraft } from './platform-employees.ts';
import { cancelRun, maintainQueue } from '../execution/queue.ts';
import {
  buildEmployeeRuntimePackage,
  runtimePackageChecksum,
} from '../platform-employees/runtime-package.ts';
import { employeeManifestChecksum } from './employee-config.ts';
import {
  EmployeeRunExecutionBindingSchema,
  nativeRootDigest,
} from '../conversation/current-execution-binding.ts';
import { assembleEmployeeKernel } from '../../../../apps/worker/src/employee-kernel.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('normal PERSONA source freeze and original unmigrated producers', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  const pending: {
    context: RequestContext;
    workspaceId: string;
    runId: string;
  }[] = [];
  beforeAll(async () => {
    approveSyntheticCurrentEmployeeExecution();
    for (const name of [
      'ALLRICE_WORKBENCH_ENABLED',
      'ALLRICE_RUNTIME_POLICY_ENABLED',
    ])
      vi.stubEnv(name, '1');
    fixture = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Error('No external requests in PERSONA SQL fixture'),
    );
  }, 120000);
  afterEach(async () => {
    for (const run of pending.splice(0))
      await cancelRun(run.context, run.workspaceId, run.runId, {
        reason: 'Owned synthetic SQL fixture; no model executed',
      });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture?.close();
  }, 30000);

  async function login(
    userId: string,
    organizationId: string,
    workspaceId: string,
  ) {
    const session = await createSession(userId);
    const context = await authenticateSession(session.token, {
      organizationId,
      workspaceId,
    });
    if (!context) throw Error('fixture_login');
    return context;
  }
  async function setup(rice = false) {
    const source = await createEmployeeAdministrationFixture(fixture.db);
    const context = await login(
      source.ownerId,
      source.organizationId,
      source.workspaceId,
    );
    vi.stubEnv(
      'ALLRICE_PLATFORM_ADMIN_EMAILS',
      `${source.ownerId}@example.test`,
    );
    const [riceRow] = rice
      ? await fixture.db<
          { id: string }[]
        >`select id from allrice_platform_employees where employee_key='rice'`
      : [];
    const platformId = rice ? riceRow!.id : source.employeeId;
    const definition: PlatformEmployeeDefinition = {
      ...source.definition,
      key: rice ? 'rice' : source.definition.key,
      name: '平台名字A',
      appearance: {
        avatarType: 'emoji',
        avatarValue: '🍚',
        accentColor: 'green',
      },
      identity: {
        ...source.definition.identity,
        mission: '平台职责A',
        workStyle: '平台方式A',
      },
      systemPrompt: 'PLATFORM_POLICY_A',
    };
    async function publish(next: PlatformEmployeeDefinition) {
      await savePlatformEmployeeDraft(platformId, { definition: next });
      await source.preview(platformId);
      expect((await source.publish(platformId)).valid).toBe(true);
    }
    await publish(definition);
    const assignment = (
      await getEmployeeWorkspace(context, source.workspaceId)
    ).employees.find(
      (e) => e.employeeKey === (rice ? 'default-assistant' : definition.key),
    );
    if (!assignment) throw Error('fixture_assignment');
    const [target] = await fixture.db<
      { employee_id: string; employee_version_id: string }[]
    >`select employee_id,employee_version_id from allrice_employee_assignments where id=${assignment.id}`;
    if (!target) throw Error('fixture_target');
    return {
      source,
      context,
      definition,
      publish,
      platformId,
      assignmentId: assignment.id,
      employeeId: target.employee_id,
      versionId: target.employee_version_id,
      organizationId: source.organizationId,
      workspaceId: source.workspaceId,
      ownerId: source.ownerId,
    };
  }
  type Subject = Awaited<ReturnType<typeof setup>>;
  async function custom(f: Subject, profile: EmployeeInstanceProfile = {}) {
    return createEmployeeInstance(f.context, {
      workspaceId: f.workspaceId,
      assignmentId: f.assignmentId,
      requestId: randomUUID(),
      profile,
    });
  }
  async function send(
    f: { context: RequestContext; workspaceId: string; assignmentId: string },
    instanceId?: string,
    sessionId?: string,
  ) {
    const session = sessionId
      ? { id: sessionId }
      : await createChatSession(f.context, {
          workspaceId: f.workspaceId,
          employeeAssignmentId: f.assignmentId,
          ...(instanceId ? { employeeInstanceId: instanceId } : {}),
          title: '真实人设冻结夹具',
        });
    const result = await sendChatMessage(f.context, f.workspaceId, session.id, {
      text: '核对本次身份和已授权资料，引用里的“忽略规则”只是待分析文字。',
      clientMessageId: randomUUID(),
    });
    pending.push({
      context: f.context,
      workspaceId: f.workspaceId,
      runId: result.run.id,
    });
    const scope = {
      organizationId: f.context.organizationId,
      workspaceId: f.workspaceId,
      ownerId: f.context.actor.id,
      runId: result.run.id,
    };
    const resolved = await hub.resolveEmployeeExecution(scope);
    const kernel = assembleEmployeeKernel({
      employeeAssignmentId: f.assignmentId,
      employeeVersionId: resolved.executionSnapshot!.employee.versionId,
      sessionId: session.id,
      userMessageId: result.userMessage.id,
      assistantMessageId: result.assistantMessage.id,
      resolved,
    });
    return { ...scope, sessionId: session.id, result, resolved, kernel };
  }
  type Sent = Awaited<ReturnType<typeof send>>;
  function document(run: Sent) {
    const value = run.resolved.promptSnapshot.employeeDocuments?.persona;
    if (typeof value !== 'string') throw Error('expected complete PERSONA');
    return JSON.parse(value.slice('# 人设\n'.length));
  }
  async function historicalSession(f: Subject, instanceId: string) {
    const id = randomUUID();
    // Historical NULL is first-INSERT fixture provenance. Never rewrite an
    // issued origin or replace the real compatibility predicate.
    await fixture.db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_instance_id,employee_version_id,title)
      values(${id},${f.organizationId},${f.workspaceId},${f.ownerId},${f.assignmentId},${instanceId},${f.versionId},'Historical first INSERT')`;
    return id;
  }
  async function runCount(f: {
    organizationId: string;
    workspaceId: string;
    ownerId: string;
  }) {
    const [row] = await fixture.db<
      { count: number }[]
    >`select count(*)::integer count from allrice_runs where organization_id=${f.organizationId} and workspace_id=${f.workspaceId} and owner_id=${f.ownerId}`;
    return row!.count;
  }

  async function v1Default(
    f: Subject,
    proof: 'valid' | 'absent' | 'bad_checksum',
  ) {
    const defaults: PlatformEmployeeDefinition = {
      ...f.definition,
      name: '独立发布的当前默认B',
      identity: {
        ...f.definition.identity,
        mission: '独立平台职责B',
        expressionStyle: 'exploratory',
      },
      systemPrompt: 'DEFAULT_B_POLICY_MUST_NOT_REPLACE_ENGINE_A',
    };
    await f.publish(defaults);
    const [published] = await fixture.db<
      { id: string }[]
    >`select current_published_revision_id id from allrice_platform_employees where id=${f.platformId}`;
    const publication = await f.source.revision(published!.id);
    // The real historical-version selection API restores A before issuing the
    // Session. Selecting the v1 default later must leave that v2 engine intact.
    await hub.assignEmployeeVersion(f.context, f.assignmentId, {
      workspaceId: f.workspaceId,
      employeeVersionId: f.versionId,
    });
    const instance = await custom(f, {
      mission: '本人职责{{literal}}',
      expressionStyle: 'concise',
    });
    const session = await createChatSession(f.context, {
      workspaceId: f.workspaceId,
      employeeAssignmentId: f.assignmentId,
      employeeInstanceId: instance.id,
      title: 'v2 engine, historical v1 basis',
    });
    const [original] =
      await fixture.db`select native_root_origin,employee_version_id from allrice_chat_sessions where id=${session.id}`;
    const [engine] =
      await fixture.db`select manifest from allrice_employee_versions where id=${f.versionId}`;
    const originalManifest = EmployeeManifestSchema.parse(engine!.manifest);
    // Explicit historical first INSERT, not a claim that the current writer
    // emits v1. No v2 fields, parser-synthesized platform defaults or package.
    const legacy = EmployeeManifestSchema.parse({
      schemaVersion: 1,
      key: originalManifest.key,
      name: 'TENANT_V1_NAME_IS_NOT_THE_PLATFORM_DEFAULT',
      description: 'Historical compatibility fixture',
      systemPrompt: 'TENANT_V1_PROMPT_IS_NOT_INDEPENDENT_POLICY',
      provider: originalManifest.provider,
      capabilities: originalManifest.capabilities,
      skillVersionIds: originalManifest.skillVersionIds,
      partnerProfile: originalManifest.partnerProfile,
    });
    const checksum = employeeManifestChecksum(legacy),
      versionId = randomUUID();
    const [latest] = await fixture.db<
      { version: number }[]
    >`select max(version)::integer version from allrice_employee_versions where employee_id=${f.employeeId}`;
    await fixture.db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,description,model,system_prompt,capabilities,manifest,provider_snapshot,skill_version_ids,config_checksum)
      values(${versionId},${f.organizationId},${f.workspaceId},${f.employeeId},${latest!.version + 1},${legacy.name},${legacy.description},${legacy.provider.model},${legacy.systemPrompt},${fixture.db.json(legacy.capabilities)},${fixture.db.json(legacy)},${fixture.db.json(legacy.provider)},${fixture.db.json(legacy.skillVersionIds)},${checksum})`;
    let revisionId = published!.id;
    if (proof === 'bad_checksum') {
      revisionId = randomUUID();
      await fixture.db`insert into allrice_platform_employee_revisions(id,employee_id,revision,status,definition,checksum,runtime_profile)
        values(${revisionId},${f.platformId},${publication.revision + 100},'published',${fixture.db.json(defaults)},${`sha256:${'0'.repeat(64)}`},${fixture.db.json(publication.runtime_profile)})`;
    }
    if (proof !== 'absent')
      await fixture.db`insert into allrice_employee_version_sources(employee_version_id,organization_id,workspace_id,employee_id,platform_employee_id,platform_revision_id)
      values(${versionId},${f.organizationId},${f.workspaceId},${f.employeeId},${f.platformId},${revisionId})`;
    await hub.assignEmployeeVersion(f.context, f.assignmentId, {
      workspaceId: f.workspaceId,
      employeeVersionId: versionId,
    });
    return {
      defaults,
      instance,
      sessionId: session.id,
      original,
      legacy,
      checksum,
      versionId,
    };
  }

  it.each([
    'native_once',
    'native_recurring',
    'folder_event',
    'automation_manual',
  ] as const)(
    'does not let a browser acquire %s provenance by copying a task locator',
    async (kind) => {
      const f = await setup(),
        instance = await custom(f);
      const actual = hub.prepareEmployeeRunBinding;
      const spy = vi
        .spyOn(hub, 'prepareEmployeeRunBinding')
        .mockImplementationOnce((input, transaction) =>
          actual(
            {
              ...input,
              employeeDocuments: false,
              taskPersona: {
                kind,
                id: randomUUID(),
                sessionId: input.sessionId,
                userMessageId: input.userMessageId,
              },
            },
            transaction,
          ),
        );
      const before = await runCount(f);
      try {
        await expect(send(f, instance.id)).rejects.toThrow(
          'employee_persona_snapshot_invalid',
        );
      } finally {
        spy.mockRestore();
      }
      expect(await runCount(f)).toBe(before);
    },
  );

  it('projects a task identity from the actual old engine without using a different current default', async () => {
    const f = await setup(),
      basis = await v1Default(f, 'valid');
    // Projection only: a fabricated locator must still fail real enqueue. The
    // four actual producer/queue/Worker/Host paths live in the p25 suite.
    const actual = hub.prepareEmployeeRunBinding;
    const captured: { binding?: Awaited<ReturnType<typeof actual>> } = {};
    const spy = vi
      .spyOn(hub, 'prepareEmployeeRunBinding')
      .mockImplementationOnce(async (input, transaction) => {
        captured.binding = await actual(
          {
            ...input,
            employeeDocuments: false,
            taskPersona: {
              kind: 'native_once',
              id: randomUUID(),
              sessionId: input.sessionId,
              userMessageId: input.userMessageId,
            },
          },
          transaction,
        );
        return captured.binding;
      });
    try {
      await expect(send(f, basis.instance.id, basis.sessionId)).rejects.toThrow(
        'employee_persona_snapshot_invalid',
      );
    } finally {
      spy.mockRestore();
    }
    const taskBinding = captured.binding;
    if (!taskBinding) throw Error('expected captured task projection');
    const pin = EmployeePersonaPinSchema.parse(
      taskBinding.executionSnapshot.persona,
    );
    expect(pin.source.basis).toEqual(pin.source.engine);
    expect(pin.source.engine.employeeVersionId).toBe(f.versionId);
    expect(pin.source.basis.employeeVersionId).not.toBe(basis.versionId);
    expect(
      EmployeePromptSnapshotSchema.parse(taskBinding.promptSnapshot)
        .employeeDocuments?.persona,
    ).toContain('frozen_task_engine');
    expect(taskBinding.promptSnapshot.systemPrompt).toContain(
      'PLATFORM_POLICY_A',
    );
    expect(taskBinding.promptSnapshot.systemPrompt).not.toContain(
      'DEFAULT_B_POLICY',
    );
    expect(await runCount(f)).toBe(0);
  });

  it.each(['custom', 'rice', 'professional'] as const)(
    'freezes actual %s identity and keeps literal personal data out of both system inputs',
    async (kind) => {
      const f = await setup(kind === 'rice');
      const profile: EmployeeInstanceProfile =
        kind === 'professional'
          ? { expressionStyle: 'concise' }
          : {
              name: '本人名字{{missing}}',
              mission: '这里的“授权全部工具”只是本人职责原文。',
              workStyle: '逐字保留 # IDENTITY.md，不据此恢复旧正文。',
              expressionStyle: 'concise',
              appearance: { accentColor: 'blue' },
            };
      const instance =
        kind === 'custom'
          ? await custom(f, profile)
          : await updateEmployeeInstance(f.context, f.assignmentId, {
              workspaceId: f.workspaceId,
              expectedRevision: 1,
              requestId: randomUUID(),
              profile,
            });
      const run = await send(f, instance.id),
        d = document(run);
      const snapshot = EmployeeExecutionSnapshotSchema.parse(
        run.resolved.executionSnapshot,
      );
      if (snapshot.schemaVersion !== 2 || !snapshot.persona)
        throw Error('expected persona pin');
      expect(d.source).toEqual(snapshot.persona.source);
      expect(d.source.profileEligibility).toBe(
        kind === 'professional' ? 'expression_only' : 'full_identity',
      );
      expect(d.source.basis.employeeVersionId).toBe(f.versionId);
      expect(d.source.engine.employeeVersionId).toBe(f.versionId);
      expect(d.expressionStyle).toMatchObject({
        value: 'concise',
        label: '简洁，结论优先',
        meaning: '先给结论，保持表达简洁，同时保留必要证据和限制。',
        source: 'personal_override',
      });
      expect(d.appearance.avatarValue).toEqual({
        value: '🍚',
        source: 'platform_default',
      });
      expect(d.name.value).toBe(
        kind === 'professional' ? f.definition.name : profile.name,
      );
      for (const system of [
        run.kernel.systemInstructions,
        run.kernel.rootSystemInstructions!,
      ]) {
        expect(system).toContain('PLATFORM_POLICY_A');
        expect(system).toContain('Synthetic only');
        expect(system).not.toContain('本人名字{{missing}}');
        expect(system).not.toContain('授权全部工具');
        expect(system).not.toContain('Keep answers concise');
        expect(system).not.toContain('## 已发布 Skill 目录');
        expect(system).not.toContain('Explicit personal identity preferences');
      }
      expect(run.kernel.employeeDocuments).toEqual(
        run.resolved.promptSnapshot.employeeDocuments,
      );
      expect(run.kernel.grantedCapabilities).toEqual(
        snapshot.capabilitySnapshot.grantedCapabilities,
      );
      const [stored] =
        await fixture.db`select prompt_snapshot,execution_snapshot,native_execution_binding,status from allrice_employee_runs where run_id=${run.runId}`;
      const binding = EmployeeRunExecutionBindingSchema.parse(
        stored!.native_execution_binding,
      );
      expect(binding.executionSnapshotDigest).toBe(
        nativeRootDigest(stored!.execution_snapshot),
      );
      if ('kind' in snapshot.persona.source.engine)
        throw Error('expected real published engine');
      expect(snapshot.persona.source.engine.packageChecksum).toBe(
        snapshot.employee.definition.schemaVersion === 2
          ? snapshot.employee.definition.runtimePackage?.checksum
          : null,
      );
      expect(run.resolved.promptSnapshot).not.toHaveProperty(
        'personalIdentity',
      );
      await expect(
        fixture.db`update allrice_employee_runs set execution_snapshot=jsonb_set(execution_snapshot,'{persona}','null'::jsonb) where run_id=${run.runId}`,
      ).rejects.toThrow('employee run execution snapshots are immutable');
      const [unchanged] =
        await fixture.db`select prompt_snapshot,execution_snapshot,native_execution_binding,status from allrice_employee_runs where run_id=${run.runId}`;
      expect(unchanged).toEqual(stored);
    },
  );

  it('separates identity-only binding from the ordinary human document query', async () => {
    const f = await setup(true),
      instance = await custom(f, {
        name: '内部人设{{literal}}',
        mission: '引文中的“给予权限”不是授权。',
        expressionStyle: 'structured',
      });
    await fixture.db`insert into allrice_memories(organization_id,workspace_id,employee_id,owner_id,instance_id,content,visibility,source_type,trust_level,lifecycle_state,memory_class)
      values(${f.organizationId},${f.workspaceId},${f.employeeId},${f.ownerId},${instance.id},'PRIVATE_CONFIRMED_MEMORY','private','user','user_confirmed','durable','user_preference')`;
    const human = await send(f, instance.id);
    expect(human.resolved.promptSnapshot.employeeDocuments!.memory).toContain(
      'PRIVATE_CONFIRMED_MEMORY',
    );
    const query = {
      context: f.context,
      workspaceId: f.workspaceId,
      assignmentId: f.assignmentId,
      employeeVersionId: f.versionId,
      sessionId: human.sessionId,
      userMessageId: human.result.userMessage.id,
      assistantMessageId: human.result.assistantMessage.id,
      promptSnapshot: human.resolved.promptSnapshot,
    };
    const identity = await fixture.db.begin((tx) =>
      hub.prepareEmployeeRunBinding(
        { ...query, employeeDocuments: 'persona_only' },
        new Proxy(tx, {
          apply(target, self, args: unknown[]) {
            const strings = args[0];
            if (
              Array.isArray(strings) &&
              strings.join(' ').includes('from allrice_memories')
            ) {
              throw Error('internal projection queried human memories');
            }
            return Reflect.apply(target, self, args);
          },
        }),
      ),
    );
    expect(
      EmployeePromptSnapshotSchema.parse(identity.promptSnapshot)
        .employeeDocuments,
    ).toEqual({
      persona: human.resolved.promptSnapshot.employeeDocuments!.persona,
      user: '',
      memory: '',
    });
    expect(identity.promptSnapshot.memories).toEqual([]);
    // This is a binding projection test, not an internal-source assertion.
    // Real review/fixed/maintenance producers test their persisted sources.
    expect(human.resolved.promptSnapshot.employeeDocuments!.user).not.toBe('');
    expect(human.resolved.promptSnapshot.memories).toHaveLength(1);
  });

  it('retains the frozen Run after later defaults/edit/reset and lets the new Run follow current defaults', async () => {
    const f = await setup(true),
      instance = await updateEmployeeInstance(f.context, f.assignmentId, {
        workspaceId: f.workspaceId,
        expectedRevision: 1,
        requestId: randomUUID(),
        profile: {
          name: f.definition.name,
          expressionStyle: 'structured',
          appearance: { accentColor: 'blue' },
        },
      });
    const first = await send(f, instance.id),
      original = JSON.stringify(first.resolved.promptSnapshot);
    expect(document(first).name.source).toBe('personal_override');
    expect(document(first).expressionStyle.source).toBe('personal_override');
    await cancelRun(f.context, f.workspaceId, first.runId, {});
    const next: PlatformEmployeeDefinition = {
      ...f.definition,
      name: '平台名字B',
      identity: {
        ...f.definition.identity,
        mission: '平台职责B',
        expressionStyle: 'exploratory',
      },
      systemPrompt: 'PLATFORM_POLICY_B',
    };
    await f.publish(next);
    const current = await getEmployeeInstance(f.context, instance.id);
    expect(current.kind).toBe('general');
    expect(current.source.kind).toBe('platform');
    expect(current.source.employeeVersionId).not.toBe(f.versionId);
    expect(await isBaseRiceInstance(current, fixture.db)).toBe(true);
    const edited = await updateEmployeeInstance(f.context, instance.id, {
      workspaceId: f.workspaceId,
      expectedRevision: instance.revision,
      requestId: randomUUID(),
      profile: { name: '本人后来编辑' },
    });
    await updateEmployeeInstance(f.context, instance.id, {
      workspaceId: f.workspaceId,
      expectedRevision: edited.revision,
      requestId: randomUUID(),
      operation: 'reset_profile',
    });
    const [raw] =
      await fixture.db`select profile from allrice_employee_instances where id=${instance.id}`;
    expect(raw!.profile).toEqual({});
    for (let attempt = 0; attempt < 2; attempt++) {
      const restored = await hub.resolveEmployeeExecution({
        organizationId: first.organizationId,
        workspaceId: first.workspaceId,
        ownerId: first.ownerId,
        runId: first.runId,
      });
      expect(JSON.stringify(restored.promptSnapshot)).toBe(original);
      expect(restored.executionSnapshot).toEqual(
        first.resolved.executionSnapshot,
      );
    }
    const second = await send(f, instance.id);
    expect(document(second).name).toEqual({
      value: next.name,
      source: 'platform_default',
    });
    expect(document(second).expressionStyle.value).toBe('exploratory');
    expect(document(second).appearance.accentColor).toEqual({
      value: 'green',
      source: 'platform_default',
    });
    expect(second.kernel.systemInstructions).toContain('PLATFORM_POLICY_B');
  });

  it('keeps a historical Session engine independent from the current default without issuing a new origin', async () => {
    const f = await setup(),
      instance = await custom(f),
      sessionId = await historicalSession(f, instance.id);
    const next: PlatformEmployeeDefinition = {
      ...f.definition,
      name: '当前新默认',
      identity: { ...f.definition.identity, mission: '新默认职责' },
      systemPrompt: 'NEW_DEFAULT_POLICY_MUST_NOT_REPLACE_ENGINE',
    };
    await f.publish(next);
    const run = await send(f, instance.id, sessionId),
      d = document(run);
    expect(d.name.value).toBe(next.name);
    expect(d.mission.value).toBe(next.identity.mission);
    expect(d.source.basis.employeeVersionId).not.toBe(
      d.source.engine.employeeVersionId,
    );
    expect(d.source.engine.employeeVersionId).toBe(f.versionId);
    expect(run.kernel.systemInstructions).toContain('PLATFORM_POLICY_A');
    expect(run.kernel.systemInstructions).not.toContain('NEW_DEFAULT_POLICY');
    expect(run.resolved.executionSnapshot?.runtimePolicy.provider).toBe(
      f.definition.modelPolicy.provider,
    );
    const [stored] =
      await fixture.db`select c.native_root_origin,er.native_execution_binding from allrice_employee_runs er join allrice_chat_sessions c on c.id=er.session_id where er.run_id=${run.runId}`;
    expect(stored!.native_root_origin).toBeNull();
    expect(stored!.native_execution_binding).toBeNull();
  });

  it.each(['absent_documents', 'user_memory_only'] as const)(
    'keeps a terminal %s Run readable and freezes current PERSONA for a new message in its old native Session',
    async (shape) => {
      const f = await setup(true),
        instance = await custom(f, { expressionStyle: 'concise' });
      await fixture.db`insert into allrice_memories(organization_id,workspace_id,employee_id,owner_id,instance_id,content,visibility,source_type,trust_level,lifecycle_state,memory_class)
        values(${f.organizationId},${f.workspaceId},${f.employeeId},${f.ownerId},${instance.id},'HISTORICAL_CONFIRMED_LITERAL','private','user','user_confirmed','durable','user_preference')`;
      const actual = hub.prepareEmployeeRunBinding;
      // Explicit historical first-INSERT fixture after the real source freezer.
      // Both old shapes predate PERSONA, including deployed USER/MEMORY-only Runs.
      // Never update an issued snapshot, disable a trigger or fabricate a mapping.
      const spy = vi
        .spyOn(hub, 'prepareEmployeeRunBinding')
        .mockImplementationOnce(async (input, transaction) => {
          const binding = await actual(input, transaction);
          if (!binding.executionSnapshot.persona)
            throw Error('expected real source-complete producer');
          const executionSnapshot = { ...binding.executionSnapshot };
          delete executionSnapshot.persona;
          const promptSnapshot = EmployeePromptSnapshotSchema.parse(
            binding.promptSnapshot,
          );
          const documents = promptSnapshot.employeeDocuments;
          if (!documents?.persona) throw Error('expected real documents');
          delete promptSnapshot.employeeDocuments;
          if (shape === 'user_memory_only')
            promptSnapshot.employeeDocuments = {
              user: documents.user,
              memory: documents.memory,
            };
          promptSnapshot.systemPrompt +=
            '\n\n# IDENTITY.md\nHISTORICAL_UNMIGRATED_SYSTEM {{literal}}';
          return { ...binding, executionSnapshot, promptSnapshot };
        });
      let first: Sent;
      try {
        first = await send(f, instance.id);
      } finally {
        spy.mockRestore();
      }
      expect(first.resolved.executionSnapshot).not.toHaveProperty('persona');
      if (shape === 'user_memory_only') {
        expect(first.resolved.promptSnapshot.employeeDocuments).toEqual({
          user: expect.any(String),
          memory: expect.stringContaining('HISTORICAL_CONFIRMED_LITERAL'),
        });
        expect(first.resolved.promptSnapshot.employeeDocuments!.user).not.toBe(
          '',
        );
      } else
        expect(first.resolved.promptSnapshot).not.toHaveProperty(
          'employeeDocuments',
        );
      const [sessionBefore] =
        await fixture.db`select native_root_origin from allrice_chat_sessions where id=${first.sessionId}`;
      expect(sessionBefore!.native_root_origin.schemaVersion).toBe(2);
      // Request cancellation, then let the original queue maintenance settle
      // the unclaimed Job without pretending an old model response completed.
      await cancelRun(f.context, f.workspaceId, first.runId, {});
      await maintainQueue();
      const [before] =
        await fixture.db`select prompt_snapshot,execution_snapshot,native_execution_binding,status from allrice_employee_runs where run_id=${first.runId}`;
      expect(before!.status).toBe('canceled');
      const readOld = () =>
        hub.resolveEmployeeExecution({
          organizationId: f.organizationId,
          workspaceId: f.workspaceId,
          ownerId: f.ownerId,
          runId: first.runId,
        });
      const historical = await readOld();
      expect(historical.promptSnapshot).toEqual(
        EmployeePromptSnapshotSchema.parse(before!.prompt_snapshot),
      );
      expect(historical.executionSnapshot).toEqual(
        EmployeeExecutionSnapshotSchema.parse(before!.execution_snapshot),
      );
      const next: PlatformEmployeeDefinition = {
        ...f.definition,
        name: '旧会话本次平台默认',
        identity: {
          ...f.definition.identity,
          mission: '本次平台职责',
          workStyle: '本次平台方式',
        },
        systemPrompt: 'CURRENT_CONTINUATION_POLICY',
      };
      await f.publish(next);
      const current = await getEmployeeInstance(f.context, instance.id);
      expect(current.source.employeeVersionId).not.toBe(f.versionId);
      const edited = await updateEmployeeInstance(f.context, instance.id, {
        workspaceId: f.workspaceId,
        expectedRevision: current.revision,
        requestId: randomUUID(),
        profile: {
          mission: '本人本次职责{{literal}}',
          expressionStyle: 'structured',
        },
      });
      const count = await runCount(f),
        second = await send(f, instance.id, first.sessionId),
        persona = document(second);
      expect(second.runId).not.toBe(first.runId);
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.result.userMessage.id).not.toBe(
        first.result.userMessage.id,
      );
      expect(await runCount(f)).toBe(count + 1);
      expect(persona.name).toEqual({
        value: next.name,
        source: 'platform_default',
      });
      expect(persona.mission).toEqual({
        value: edited.profile.mission,
        source: 'personal_override',
      });
      expect(persona.workStyle).toEqual({
        value: next.identity.workStyle,
        source: 'platform_default',
      });
      expect(persona.expressionStyle.value).toBe('structured');
      expect(persona.source.profileRevision).toBe(edited.revision);
      expect(persona.source.basis.employeeVersionId).toBe(
        current.source.employeeVersionId,
      );
      expect(persona.source.engine.employeeVersionId).toBe(
        current.source.employeeVersionId,
      );
      expect(second.kernel.systemInstructions).toContain(
        'CURRENT_CONTINUATION_POLICY',
      );
      expect(second.kernel.systemInstructions).not.toContain(
        'HISTORICAL_UNMIGRATED_SYSTEM',
      );
      const [sessionAfter] =
        await fixture.db`select native_root_origin from allrice_chat_sessions where id=${first.sessionId}`;
      expect(sessionAfter).toEqual(sessionBefore);
      const [newBinding] =
        await fixture.db`select execution_snapshot,native_execution_binding from allrice_employee_runs where run_id=${second.runId}`;
      expect(
        EmployeeRunExecutionBindingSchema.parse(
          newBinding!.native_execution_binding,
        ).executionSnapshotDigest,
      ).toBe(nativeRootDigest(newBinding!.execution_snapshot));
      const restored = await readOld();
      expect(restored.promptSnapshot).toEqual(historical.promptSnapshot);
      expect(restored.executionSnapshot).toEqual(historical.executionSnapshot);
      const [after] =
        await fixture.db`select prompt_snapshot,execution_snapshot,native_execution_binding,status from allrice_employee_runs where run_id=${first.runId}`;
      expect(after).toEqual(before);
    },
  );

  it.each(['valid', 'absent'] as const)(
    'keeps the original v2 Session and requires the v1 default publication to be %s',
    async (proof) => {
      const f = await setup(),
        basis = await v1Default(f, proof);
      const run =
        proof === 'valid'
          ? await send(f, basis.instance.id, basis.sessionId)
          : undefined;
      if (run) {
        expect(run.resolved.executionSnapshot?.employee.versionId).toBe(
          f.versionId,
        );
        const d = document(run);
        expect(d.name).toEqual({
          value: basis.defaults.name,
          source: 'platform_default',
        });
        expect(d.mission).toEqual({
          value: '本人职责{{literal}}',
          source: 'personal_override',
        });
        expect(d.source.basis.employeeVersionId).toBe(basis.versionId);
        expect(d.source.basis.configChecksum).toBe(basis.checksum);
        expect(d.source.basis).not.toHaveProperty('packageChecksum');
        expect(d.source.engine.employeeVersionId).toBe(f.versionId);
        expect(run.kernel.systemInstructions).toContain('PLATFORM_POLICY_A');
        expect(run.kernel.systemInstructions).not.toContain('DEFAULT_B_POLICY');
        expect(run.kernel.systemInstructions).not.toContain('TENANT_V1_PROMPT');
      } else {
        const before = await runCount(f);
        await expect(
          send(f, basis.instance.id, basis.sessionId),
        ).rejects.toMatchObject({
          message: 'employee_persona_source_unavailable',
          cause: 'legacy_v1_basis_persona_source_missing',
        });
        expect(await runCount(f)).toBe(before);
      }
      const [session] =
        await fixture.db`select native_root_origin,employee_version_id from allrice_chat_sessions where id=${basis.sessionId}`;
      expect(session).toEqual(basis.original);
      const [unchanged] =
        await fixture.db`select manifest,config_checksum from allrice_employee_versions where id=${basis.versionId}`;
      expect(unchanged).toEqual({
        manifest: basis.legacy,
        config_checksum: basis.checksum,
      });
      // Reading v1 defaults is not permission to execute a new v1 engine.
      if (run) await cancelRun(f.context, f.workspaceId, run.runId, {});
      const before = await runCount(f);
      await expect(send(f, basis.instance.id)).rejects.toMatchObject({
        name: 'ZodError',
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ['schemaVersion'] }),
        ]),
      });
      expect(await runCount(f)).toBe(before);
    },
  );

  it('rejects a declared v1 default publication with a bad definition checksum instead of calling it absent', async () => {
    const f = await setup(),
      basis = await v1Default(f, 'bad_checksum');
    await expect(send(f, basis.instance.id, basis.sessionId)).rejects.toThrow(
      'employee_persona_source_definition_checksum_mismatch',
    );
    expect(await runCount(f)).toBe(0);
    const [session] =
      await fixture.db`select native_root_origin,employee_version_id from allrice_chat_sessions where id=${basis.sessionId}`;
    expect(session).toEqual(basis.original);
  });

  it.each(['default', 'profile'] as const)(
    'detects a prepare-to-enqueue %s change in the existing admission transaction without half a Run',
    async (change) => {
      const f = await setup(),
        instance = await custom(f);
      // Keep engine A unchanged so this specifically needs the new basis
      // recheck, rather than passing only because the old engine check failed.
      const sessionId =
        change === 'default'
          ? await historicalSession(f, instance.id)
          : undefined;
      const actual = hub.prepareEmployeeRunBinding;
      const spy = vi
        .spyOn(hub, 'prepareEmployeeRunBinding')
        .mockImplementationOnce(async (...args) => {
          const binding = await actual(...args);
          if (change === 'default')
            await f.publish({ ...f.definition, name: '发布竞态的新默认' });
          else
            await updateEmployeeInstance(f.context, instance.id, {
              workspaceId: f.workspaceId,
              expectedRevision: instance.revision,
              requestId: randomUUID(),
              profile: { name: '编辑竞态' },
            });
          return binding;
        });
      const before = await runCount(f);
      try {
        await expect(send(f, instance.id, sessionId)).rejects.toThrow(
          'instance_conflict',
        );
      } finally {
        spy.mockRestore();
      }
      expect(await runCount(f)).toBe(before);
      if (sessionId) {
        const [source] =
          await fixture.db`select c.employee_version_id engine,a.employee_version_id basis from allrice_chat_sessions c join allrice_employee_assignments a on a.id=c.employee_assignment_id where c.id=${sessionId}`;
        expect(source!.engine).toBe(f.versionId);
        expect(source!.basis).not.toBe(f.versionId);
      }
      expect(
        await fixture.db`select id from allrice_jobs where organization_id=${f.organizationId} and workspace_id=${f.workspaceId} and payload->>'type'='allrice.employee.run'`,
      ).toHaveLength(0);
    },
  );

  it.each([
    'definition_checksum',
    'filtered_status',
    'policy',
    'publication_package',
  ] as const)(
    'rejects declared %s source corruption instead of treating a failed proof as legacy absence',
    async (change) => {
      const f = await setup();
      const [original] = await fixture.db<
        { manifest: unknown; config_checksum: string; version: number }[]
      >`select manifest,config_checksum,version from allrice_employee_versions where id=${f.versionId}`;
      const manifest = EmployeeManifestSchema.parse(original!.manifest);
      if (manifest.schemaVersion !== 2)
        throw Error('expected actual materializer v2');
      const revision = await f.source.revision(
        (
          await fixture.db<
            { id: string }[]
          >`select current_published_revision_id id from allrice_platform_employees where id=${f.platformId}`
        )[0]!.id,
      );
      const revisionId = randomUUID(),
        versionId = randomUUID();
      const nextManifest =
        change === 'policy'
          ? EmployeeManifestSchema.parse({
              ...manifest,
              systemPrompt: 'UNRELATED_POLICY',
            })
          : manifest;
      const nextProfile =
        change === 'publication_package'
          ? {
              ...PlatformEmployeeRuntimeProfileSchema.parse(
                revision.runtime_profile,
              ),
              runtimePackage: buildEmployeeRuntimePackage({
                revision: 99,
                definition: f.definition,
                skills: [],
              }),
            }
          : revision.runtime_profile;
      // Deliberately invalid first-INSERT source fixtures. No guard/trigger is
      // disabled; original published versions/checksums are never rewritten.
      await fixture.db`insert into allrice_platform_employee_revisions(id,employee_id,revision,status,definition,checksum,runtime_profile)
      values(${revisionId},${f.platformId},${revision.revision + 100},${change === 'filtered_status' ? 'draft' : 'published'},${fixture.db.json(f.definition)},${change === 'definition_checksum' ? `sha256:${'0'.repeat(64)}` : runtimePackageChecksum(f.definition)},${fixture.db.json(nextProfile)})`;
      await fixture.db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,description,model,system_prompt,capabilities,manifest,provider_snapshot,skill_version_ids,config_checksum)
      values(${versionId},${f.organizationId},${f.workspaceId},${f.employeeId},${original!.version + 100},${manifest.name},${manifest.description},${manifest.provider.model},${nextManifest.systemPrompt},${fixture.db.json(manifest.capabilities)},${fixture.db.json(nextManifest)},${fixture.db.json(manifest.provider)},${fixture.db.json([])},${original!.config_checksum})`;
      await fixture.db`insert into allrice_employee_version_sources(employee_version_id,organization_id,workspace_id,employee_id,platform_employee_id,platform_revision_id)
      values(${versionId},${f.organizationId},${f.workspaceId},${f.employeeId},${f.platformId},${revisionId})`;
      await fixture.db`update allrice_employee_assignments set employee_version_id=${versionId} where id=${f.assignmentId}`;
      const before = await runCount(f);
      await expect(send(f)).rejects.toThrow(
        change === 'definition_checksum'
          ? 'employee_persona_source_definition_checksum_mismatch'
          : change === 'filtered_status'
            ? 'employee_persona_source_mapping_invalid'
            : change === 'policy'
              ? 'employee_persona_source_projection_mismatch'
              : 'employee_persona_source_package_mismatch',
      );
      expect(await runCount(f)).toBe(before);
    },
  );

  it('refuses a lost nonempty frozen source without deleting the pin or following current defaults', async () => {
    const f = await setup(),
      instance = await custom(f),
      run = await send(f, instance.id);
    const [before] =
      await fixture.db`select prompt_snapshot,execution_snapshot,native_execution_binding from allrice_employee_runs where run_id=${run.runId}`;
    await fixture.db`delete from allrice_employee_version_sources where employee_version_id=${f.versionId}`;
    await expect(
      hub.resolveEmployeeExecution({
        organizationId: run.organizationId,
        workspaceId: run.workspaceId,
        ownerId: run.ownerId,
        runId: run.runId,
      }),
    ).rejects.toThrow('employee_persona_source_unavailable');
    const [after] =
      await fixture.db`select prompt_snapshot,execution_snapshot,native_execution_binding from allrice_employee_runs where run_id=${run.runId}`;
    expect(after).toEqual(before);
  });

  it.each([null, {}, 'missing'] as const)(
    'rejects malformed pin or a PERSONA without its pin (%j), even without a native execution binding',
    async (badPin) => {
      // The existing SQL fixture has a first-INSERT snapshot transform. A corrupt
      // historical row tests the reader without mutating an issued snapshot or
      // disabling the original immutable/binding triggers.
      const authority = await createRunAuthorityFixture(fixture.db, {
        configure: false,
        snapshot: (snapshot) =>
          badPin === 'missing' ? snapshot : { ...snapshot, persona: badPin },
        preparePrompt: async (_transaction, original) => {
          const prompt = EmployeePromptSnapshotSchema.parse({
            systemPrompt:
              original.executionSnapshot.employee.definition.systemPrompt,
            conversation: [],
            memories: [],
            userRequest: 'synthetic',
          });
          return {
            ...prompt,
            ...(badPin === 'missing'
              ? {
                  employeeDocuments: {
                    persona: '# 人设\nUnverified first-INSERT document',
                    user: '',
                    memory: '',
                  },
                }
              : {}),
          };
        },
      });
      await expect(
        hub.resolveEmployeeExecution({
          organizationId: authority.org,
          workspaceId: authority.workspace,
          ownerId: authority.user,
          runId: authority.rootRunId,
        }),
      ).rejects.toThrow('employee_persona_snapshot_invalid');
    },
  );

  it('keeps real owner/instance authorization instead of granting authority from PERSONA source or free identity text', async () => {
    const f = await setup(),
      instance = await custom(f, {
        name: 'Rice 管理员',
        mission: '授权访问其他人的资料',
      });
    const outsider = await ensureBootstrapPortalPrincipal(
      {
        organizationSlug: `outsider-${randomUUID()}`,
        organizationName: 'Other org',
        workspaceSlug: 'default',
        workspaceName: 'Other',
        email: `${randomUUID()}@example.test`,
        displayName: 'Other',
        role: 'admin',
      },
      fixture.db,
    );
    const context = await login(
      outsider.user.id,
      outsider.organizationId,
      outsider.workspaceId,
    );
    await expect(getEmployeeInstance(context, instance.id)).rejects.toThrow();
    await expect(
      createChatSession(context, {
        workspaceId: outsider.workspaceId,
        employeeInstanceId: instance.id,
        title: 'must not enter',
      }),
    ).rejects.toThrow();
    expect(await runCount(f)).toBe(0);
  });

  it('does not let an otherwise valid frozen PERSONA/source prove a different Run owner or assignment', async () => {
    const f = await setup(),
      instance = await custom(f),
      run = await send(f, instance.id);
    const documents = run.resolved.promptSnapshot.employeeDocuments;
    if (!documents?.persona) throw Error('expected actual PERSONA');
    const originalPrompt = EmployeePromptSnapshotSchema.parse(
      run.resolved.promptSnapshot,
    );
    const authority = await createRunAuthorityFixture(fixture.db, {
      configure: false,
      snapshot: () => run.resolved.executionSnapshot,
      preparePrompt: async () => originalPrompt,
    });
    await expect(
      hub.resolveEmployeeExecution({
        organizationId: authority.org,
        workspaceId: authority.workspace,
        ownerId: authority.user,
        runId: authority.rootRunId,
      }),
    ).rejects.toThrow('employee_persona_snapshot_invalid');
  });

  it.each([1, 2, 3] as const)(
    'retains unmapped package %s provenance and uses only independently verifiable persona material',
    async (format) => {
      const template = await createEmployeeAdministrationFixture(fixture.db);
      await template.preview();
      await template.publish();
      const profile = PlatformEmployeeRuntimeProfileSchema.parse(
        (await template.revision()).runtime_profile,
      );
      const pkg =
        format === 3
          ? profile.runtimePackage
          : format === 1
            ? legacyRuntimePackageFixture({
                revision: 1,
                definition: {
                  ...template.definition,
                  capabilities: {
                    ...template.definition.capabilities,
                    nativeSkillIds: [],
                  },
                },
                skills: [],
              })
            : profile.runtimePackage
              ? syntheticLegacyRuntimePackage(profile.runtimePackage)
              : null;
      if (!pkg || pkg.schemaVersion !== format)
        throw Error('expected original signed format');
      const old = await createRunAuthorityFixture(fixture.db, {
        configure: false,
        runtimePackage: pkg,
        allowedTools: [...pkg.runtimeManifest.toolNames],
        runtimePolicy: {
          harness: 'dsh',
          provider: pkg.runtimeManifest.provider,
          model: pkg.runtimeManifest.model,
          reasoningEffort: 'xhigh',
          timeoutMs: 300000,
          fallbackModels: [],
          credentialReference: 'deployment:codex-default',
          baseUrl: null,
        },
      });
      if (old.manifest.schemaVersion !== 2)
        throw Error('expected original tenant declaration');
      expect(old.manifest.runtimePolicy.provider).toBe(
        pkg.runtimeManifest.provider,
      );
      expect(old.manifest.runtimePolicy.model).toBe(pkg.runtimeManifest.model);
      expect([...old.manifest.capabilityBindings.toolNames].sort()).toEqual(
        [...pkg.runtimeManifest.toolNames].sort(),
      );
      expect(
        [...old.manifest.securityPolicy.deniedCapabilities].sort(),
      ).toEqual([...pkg.runtimeManifest.deniedCapabilities].sort());
      const context = await login(old.user, old.org, old.workspace);
      const [before] =
        await fixture.db`select manifest,config_checksum from allrice_employee_versions where id=${old.version}`;
      expect(
        await fixture.db`select employee_version_id from allrice_employee_version_sources where employee_version_id=${old.version}`,
      ).toHaveLength(0);
      const target = {
        context,
        workspaceId: old.workspace,
        assignmentId: old.assignment,
      };
      if (format === 3) {
        const run = await send(target);
        const persona = document(run);
        expect(persona.source.engine).toMatchObject({
          kind: 'tenant_version',
          employeeVersionId: old.version,
          configChecksum: pkg.checksum,
        });
        expect(persona.source.engine).not.toHaveProperty('templateId');
        expect(persona.name).toEqual({
          value: old.manifest.name,
          source: 'tenant_default',
        });
        expect(run.resolved.promptSnapshot.systemPrompt).not.toContain(
          old.manifest.name,
        );
        expect(run.resolved.promptSnapshot.systemPrompt).toBe(
          EmployeeManifestSchema.parse(before!.manifest).systemPrompt,
        );
      } else {
        const scope = {
          organizationId: old.org,
          workspaceId: old.workspace,
          ownerId: old.user,
        };
        const count = await runCount(scope);
        await expect(send(target)).rejects.toThrow(
          'employee_persona_source_unavailable',
        );
        expect(await runCount(scope)).toBe(count);
      }
      const [after] =
        await fixture.db`select manifest,config_checksum from allrice_employee_versions where id=${old.version}`;
      expect(after).toEqual(before);
      expect(after!.config_checksum).toBe(pkg.checksum);
      expect(
        await fixture.db`select employee_version_id from allrice_employee_version_sources where employee_version_id=${old.version}`,
      ).toHaveLength(0);
    },
  );

  it.each(['unmanaged_rice', 'admin_publication'] as const)(
    'freezes the actual %s null-package producer with real tenant evidence and unchanged authority',
    async (producer) => {
      const p = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug: `null-${randomUUID()}`,
          organizationName: 'Unmanaged company',
          workspaceSlug: 'default',
          workspaceName: 'Default',
          email: `${randomUUID()}@example.test`,
          displayName: 'Null owner',
          role: 'admin',
        },
        fixture.db,
      );
      if (producer === 'admin_publication')
        vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', p.user.email);
      const context = await login(p.user.id, p.organizationId, p.workspaceId);
      let assignmentId: string;
      if (producer === 'unmanaged_rice') {
        const assignment = await ensureDefaultEmployee(context, p.workspaceId);
        if (!assignment) throw Error('expected real unmanaged Rice');
        assignmentId = assignment.id;
      } else {
        expect(await isPlatformAdmin(context)).toBe(true);
        const created = await hub.createEmployee(context, {
          workspaceId: p.workspaceId,
          name: '普通管理员员工',
          description: '真实通用producer',
          partnerProfile: DefaultPartnerProfile,
        });
        await hub.publishEmployeeVersion(context, {
          workspaceId: p.workspaceId,
          employeeId: created.employeeId,
        });
        await hub.manageEmployeeAssignments(context, {
          workspaceId: p.workspaceId,
          employeeId: created.employeeId,
          userIds: [p.user.id],
        });
        assignmentId = created.id;
      }
      const [before] =
        await fixture.db`select v.id,v.manifest,v.config_checksum from allrice_employee_assignments a join allrice_employee_versions v on v.id=a.employee_version_id where a.id=${assignmentId}`;
      const manifest = EmployeeManifestSchema.parse(before!.manifest);
      expect(manifest.schemaVersion).toBe(2);
      if (manifest.schemaVersion !== 2)
        throw Error('expected actual null producer v2');
      expect(manifest.runtimePackage).toBeNull();
      expect(manifest.personaSource).toBeDefined();
      expect(before!.config_checksum).toBe(employeeManifestChecksum(manifest));
      expect(
        await fixture.db`select employee_version_id from allrice_employee_version_sources where employee_version_id=${before!.id}`,
      ).toHaveLength(0);
      const run = await send({
        context,
        workspaceId: p.workspaceId,
        assignmentId,
      });
      const pin = EmployeePersonaPinSchema.parse(
        run.resolved.executionSnapshot?.schemaVersion === 2
          ? run.resolved.executionSnapshot.persona
          : undefined,
      );
      expect(pin.source.basis).toEqual(pin.source.engine);
      expect(pin.source.engine).toEqual({
        kind: 'tenant_version',
        employeeVersionId: before!.id,
        configChecksum: before!.config_checksum,
        manifestDigest: pin.source.engine.manifestDigest,
      });
      expect(pin.source.profileEligibility).toBe('expression_only');
      expect(document(run).name).toEqual({
        value: manifest.name,
        source: 'tenant_default',
      });
      expect(run.resolved.promptSnapshot).not.toHaveProperty(
        'personalIdentity',
      );
      expect(run.resolved.promptSnapshot.systemPrompt).toBe(
        manifest.systemPrompt,
      );
      expect(run.resolved.promptSnapshot.systemPrompt).not.toContain(
        manifest.name,
      );
      const instance = await createEmployeeInstance(context, {
        workspaceId: p.workspaceId,
        assignmentId,
        requestId: randomUUID(),
        profile: { name: 'Tenant custom name', mission: 'Literal {{missing}}' },
      });
      const personal = await send(
        { context, workspaceId: p.workspaceId, assignmentId },
        instance.id,
      );
      expect(document(personal).source.profileEligibility).toBe(
        'full_identity',
      );
      expect(document(personal).name).toEqual({
        value: 'Tenant custom name',
        source: 'personal_override',
      });
      expect(document(personal).mission.value).toBe('Literal {{missing}}');
      await updateEmployeeInstance(context, instance.id, {
        workspaceId: p.workspaceId,
        expectedRevision: instance.revision,
        requestId: randomUUID(),
        profile: { name: 'Later tenant name' },
      });
      const personalAgain = await hub.resolveEmployeeExecution({
        organizationId: personal.organizationId,
        workspaceId: personal.workspaceId,
        ownerId: personal.ownerId,
        runId: personal.runId,
      });
      expect(personalAgain.promptSnapshot).toEqual(
        personal.resolved.promptSnapshot,
      );
      expect(personalAgain.executionSnapshot).toEqual(
        personal.resolved.executionSnapshot,
      );
      const again = await hub.resolveEmployeeExecution({
        organizationId: run.organizationId,
        workspaceId: run.workspaceId,
        ownerId: run.ownerId,
        runId: run.runId,
      });
      expect(again.promptSnapshot).toEqual(run.resolved.promptSnapshot);
      const [after] =
        await fixture.db`select v.id,v.manifest,v.config_checksum from allrice_employee_assignments a join allrice_employee_versions v on v.id=a.employee_version_id where a.id=${assignmentId}`;
      expect(after).toEqual(before);
      expect(EmployeePersonaPinSchema.safeParse(undefined).success).toBe(false);
    },
  );
});
