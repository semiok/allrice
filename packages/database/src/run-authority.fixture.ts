import type { RuntimeLedgerTransaction } from './runtime-ledger/types.ts';
/** Synthetic isolated PostgreSQL fixture only; not a production entrypoint. */
import { randomUUID } from 'node:crypto';
import {
  EmployeeExecutionSnapshotSchema,
  PLATFORM_EMPLOYEE_DSH_DISTRIBUTION,
  PlatformEmployeeDefinitionSchema,
  PlatformEmployeeRuntimeProfileSchema,
  type EmployeeExecutionSnapshot,
  type EmployeeRuntimePolicy,
  type EmployeeRuntimePackage,
  type PlatformEmployeeDefinition,
  type RuntimePolicyControls,
  type RuntimeTaskRef,
  type RunMemoryContextV2State,
} from '@allrice/contracts';
import {
  runFixture,
  type createRuntimeFixtureDatabase,
} from './runtime.fixture.ts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from './employees/employee-config.ts';
import { createRuntimeOperationLedger } from './runtime-ledger/ledger.ts';
import { ensureRuntimeOperationRoot } from './runtime-ledger/root-service.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import { newEmployeeNativeRootOrigin } from './conversation/native-root-origin.ts';
import { frozenPackageSkills } from './skill-bundles.ts';
import {
  employeePersonaSourceSystemPrompt,
  runtimePackageChecksum,
  runtimePackageSystemPrompt,
  validatePlatformEmployeeTestExecutionSnapshot,
} from './platform-employees/runtime-package.ts';
type FixtureDatabase = Awaited<
  ReturnType<typeof createRuntimeFixtureDatabase>
>['db'];
export type LegacyPublicationFixtureSource = {
  platformEmployeeId: string;
  definition: PlatformEmployeeDefinition;
  revision: number;
  historicalGeneration?: 'dsh-0.1.5-rc.3-a4c74a9';
};

/** Explicit historical first-INSERT evidence in an isolated fixture schema.
 * The caller supplies the original independent definition, never a prompt
 * recovered from a tenant manifest or today's default/catalog. */
export async function insertLegacyEmployeePublicationFixture(
  sql: FixtureDatabase | RuntimeLedgerTransaction,
  input: LegacyPublicationFixtureSource & {
    organizationId: string;
    workspaceId: string;
    employeeId: string;
    employeeVersionId: string;
    runtimePackage: EmployeeRuntimePackage;
  },
) {
  const definition = PlatformEmployeeDefinitionSchema.parse(input.definition);
  const { runtimePackage } = input;
  const generation =
    input.historicalGeneration ?? PLATFORM_EMPLOYEE_DSH_DISTRIBUTION;
  if (
    runtimePackage.schemaVersion === 3 ||
    runtimePackage.packageVersion !== `${definition.key}:r${input.revision}` ||
    runtimePackage.runtimeManifest.distributionGeneration !== generation ||
    (generation !== PLATFORM_EMPLOYEE_DSH_DISTRIBUTION &&
      generation !== 'dsh-0.1.5-rc.3-a4c74a9')
  )
    throw Error('fixture_original_legacy_publication_required');
  const fields = PlatformEmployeeRuntimeProfileSchema.omit({
    distributionGeneration: true,
  }).parse({
    schemaVersion: 1,
    harness: 'dsh',
    employeeKey: definition.key,
    provider: definition.modelPolicy.provider,
    model: definition.modelPolicy.model,
    reasoningEffort: definition.modelPolicy.reasoningEffort,
    timeoutMs: definition.modelPolicy.timeoutMs,
    credentialReference: definition.modelPolicy.credentialReference,
    baseUrl: definition.modelPolicy.baseUrl,
    systemPrompt: runtimePackageSystemPrompt({
      platformPolicy: definition.systemPrompt,
      runtimePackage,
    }),
    nativeSkillIds: runtimePackage.skills.map((skill) => skill.id),
    nativeSkillChecksums: runtimePackage.skills.map((skill) => skill.checksum),
    toolNames: definition.capabilities.toolNames,
    connectorRefs: definition.capabilities.connectorRefs,
    securityPolicy: definition.securityPolicy,
    runtimePackage,
  });
  const runtimeProfile = { ...fields, distributionGeneration: generation };
  frozenPackageSkills(runtimePackage);
  if (generation === PLATFORM_EMPLOYEE_DSH_DISTRIBUTION)
    validatePlatformEmployeeTestExecutionSnapshot({
      definition,
      nativeSkills: runtimePackage.skills,
      packageChecksum: runtimePackage.checksum,
      runtimeProfile,
    });
  // An explicit rc3 first-INSERT retains both historical generation fields.
  // Today's preview envelope only admits the installed generation; historical
  // source readers still verify the original package/signature/skills/mapping.
  const checksum = runtimePackageChecksum(definition);
  const [existing] =
    await sql`select id,status,definition,checksum,runtime_profile
    from allrice_platform_employee_revisions where employee_id=${input.platformEmployeeId} and revision=${input.revision}`;
  if (
    existing &&
    (existing.status !== 'published' ||
      existing.checksum !== checksum ||
      runtimePolicyDigest(existing.definition) !==
        runtimePolicyDigest(definition) ||
      runtimePolicyDigest(existing.runtime_profile) !==
        runtimePolicyDigest(runtimeProfile))
  )
    throw Error('fixture_published_revision_must_remain_identical');
  const revisionId = existing?.id ?? randomUUID();
  if (!existing) {
    const [revision] = await sql`insert into allrice_platform_employee_revisions
    (id,employee_id,revision,status,definition,checksum,runtime_profile,validation_report,published_by_label,published_at)
    select ${revisionId},id,${input.revision},
      'published',${sql.json(definition)},${checksum},${sql.json(runtimeProfile)},
      '{"valid":true,"errors":[],"warnings":[]}'::jsonb,'isolated-historical-fixture',clock_timestamp()
    from allrice_platform_employees where id=${input.platformEmployeeId} and employee_key=${definition.key}
    returning id`;
    if (!revision) throw Error('fixture_original_platform_employee_required');
  }
  await sql`insert into allrice_employee_version_sources
    (employee_version_id,organization_id,workspace_id,employee_id,platform_employee_id,platform_revision_id)
    values(${input.employeeVersionId},${input.organizationId},${input.workspaceId},${input.employeeId},${input.platformEmployeeId},${revisionId})`;
}
const defaultControls = (): RuntimePolicyControls => ({
  version: 1,
  enabled: true,
  mode: 'execute',
  rules: [],
});
export async function createRunAuthorityFixture(
  db: FixtureDatabase,
  options: {
    preparePrompt?: (
      transaction: RuntimeLedgerTransaction,
      identity: {
        organizationId: string;
        workspaceId: string;
        userId: string;
        sessionId: string;
        rootRunId: string;
        employeeVersionId: string;
        employeeAssignmentId: string;
        policyId: string;
        executionSnapshot: EmployeeExecutionSnapshot;
        providerSnapshot: unknown;
        workerId: string;
        jobId: string;
      },
    ) => Promise<Parameters<RuntimeLedgerTransaction['json']>[0]>;
    /** Synthetic v2 issuance at the same first INSERT as preparePrompt. */
    memoryContextStateV2?: () => RunMemoryContextV2State;
    controls?: RuntimePolicyControls | null;
    toolNames?: string[];
    allowedTools?: string[];
    project?: boolean;
    nativeSessionId?: string;
    snapshot?: (
      value: EmployeeExecutionSnapshot,
      context: { sessionId: string },
    ) => unknown;
    deniedModel?: boolean;
    configure?: boolean;
    memberRole?: 'admin' | 'member';
    /** Frozen at fixture creation; never rewrite an immutable published version. */
    runtimePolicy?: EmployeeRuntimePolicy;
    runtimePackage?: EmployeeRuntimePackage;
    /** Opt-in original platform material for an already signed schema-1/2 package. */
    legacyPublication?: LegacyPublicationFixtureSource;
    /** Test-only first-INSERT issuance; historical fixtures remain NULL. */
    businessCreationOrigin?: boolean;
  } = {},
  suppliedBase?: Awaited<ReturnType<typeof runFixture>>,
) {
  const selectedTools = options.allowedTools ?? [
    'workspace.export.create',
    'workspace.document.read',
  ];
  const base = suppliedBase ?? (await runFixture(db));
  const { organizationId: org, workspaceId: workspace } = base.task.scope;
  const user = base.context.actor.id;
  const rootRunId = base.task.rootRunId;
  const employee = randomUUID(),
    version = randomUUID(),
    assignment = randomUUID();
  const session = randomUUID(),
    policy = randomUUID(),
    um = randomUUID(),
    am = randomUUID();
  const now = new Date().toISOString();
  const [membership] = await db<{ id: string }[]>`
  select id from allrice_memberships where organization_id=${org} and workspace_id=${workspace} and user_id=${user}`;
  const personaPackage =
    options.runtimePackage?.schemaVersion === 3
      ? options.runtimePackage
      : undefined;
  const legacyDefinition = options.legacyPublication?.definition;
  if (
    legacyDefinition &&
    (!options.runtimePackage || options.runtimePackage.schemaVersion === 3)
  )
    throw Error('fixture_legacy_package_required');
  const foundation = personaPackage?.foundation ?? legacyDefinition;
  const manifest = employeeManifest({
    runtimePackage: options.runtimePackage,
    key: legacyDefinition?.key ?? 'p25-authority',
    name: foundation?.name ?? 'P25 authority',
    description: foundation?.description ?? 'Synthetic authority fixture',
    ...(foundation
      ? {
          appearance: foundation.appearance,
          identity: {
            role: foundation.identity.role,
            mission: foundation.identity.mission,
            workStyle: foundation.identity.workStyle,
            behaviorRules: foundation.identity.behaviorRules,
            safetyBoundaries: foundation.identity.safetyBoundaries,
          },
          partnerProfile: {
            role: foundation.identity.role,
            mission: foundation.identity.mission,
            communicationStyle: foundation.identity.expressionStyle,
            outputLanguage: foundation.identity.outputLanguage,
            proactivePolicy: 'suggest' as const,
            approvalPolicy: 'confirm_side_effects' as const,
          },
          systemPromptOverride:
            legacyDefinition && options.runtimePackage
              ? runtimePackageSystemPrompt({
                  platformPolicy: legacyDefinition.systemPrompt,
                  runtimePackage: options.runtimePackage,
                })
              : employeePersonaSourceSystemPrompt(personaPackage!),
        }
      : {}),
    toolNames: options.toolNames ?? selectedTools,
    runtimePolicy: options.runtimePolicy ?? {
      harness: 'dsh',
      provider: 'openai-codex',
      model: 'synthetic-never-called',
      reasoningEffort: 'low',
      timeoutMs: 300000,
      fallbackModels: [],
      credentialReference: 'deployment:synthetic-never-resolved',
      baseUrl: null,
    },
    securityPolicy: {
      dataScopes: ['workspace'],
      connectorIdentityModes: ['user'],
      approvalPolicy: 'confirm_side_effects',
      deniedCapabilities: options.deniedModel
        ? ['model:invoke']
        : ['secret:use'],
    },
  });
  if (manifest.schemaVersion !== 2) throw Error('Fixture requires v2 manifest');
  const checksum =
    options.runtimePackage?.checksum ?? employeeManifestChecksum(manifest);
  const executionSpec = {
    kind: 'synthetic-p25-authority',
    employeeVersionId: version,
  };
  const task: RuntimeTaskRef = {
    ...base.task,
    scope: {
      ...base.task.scope,
      projectId: options.project ? randomUUID() : null,
    },
    chatSessionId: session,
    frozenConfiguration: {
      employeeVersionId: version,
      digest: runtimePolicyDigest(executionSpec),
    },
  };
  const memberRole = options.memberRole ?? 'admin';
  await db`update allrice_memberships set role=${memberRole} where id=${membership!.id}`;
  const frozenPolicy = {
    memberships: [
      {
        id: membership!.id,
        userId: user,
        organizationId: org,
        workspaceId: workspace,
        role: memberRole,
        active: true,
      },
    ],
    grants: [
      {
        resourceType: 'job',
        action: 'job:execute',
        workspaceId: workspace,
      },
      ...(selectedTools.includes('workspace.project')
        ? [
            {
              resourceType: 'storage_object',
              action: 'resource:read',
              workspaceId: workspace,
            },
          ]
        : []),
    ],
  };
  const snapshot = EmployeeExecutionSnapshotSchema.parse({
    schemaVersion: 2,
    employee: {
      id: employee,
      key: manifest.key,
      versionId: version,
      revision: 1,
      definitionChecksum: checksum,
      definition: manifest,
    },
    assignment: {
      id: assignment,
      userId: user,
      assignedBy: null,
      assignedAt: now,
    },
    runtimePolicy: manifest.runtimePolicy,
    capabilitySnapshot: {
      declaredCapabilities: manifest.capabilities,
      grantedCapabilities: manifest.capabilities.filter(
        (c) => !manifest.securityPolicy.deniedCapabilities.includes(c),
      ),
      bindings: manifest.capabilityBindings,
      skillBindings: [],
      agentSkills: [],
      workflows: [],
      knowledge: [],
      resolvedForActorId: user,
    },
    tenantContext: {
      organizationId: org,
      workspaceId: workspace,
      actorId: user,
      policySnapshotId: policy,
    },
    userProfile: { schemaVersion: 1, displayName: null, preferences: {} },
    createdAt: now,
  });
  await db.begin(async (tx) => {
    if (task.scope.projectId) {
      await tx`insert into allrice_projects(id,organization_id,workspace_id,owner_id,name) values(${task.scope.projectId},${org},${workspace},${user},'Synthetic P25 project')`;
      await tx`update allrice_runs set project_id=${task.scope.projectId} where id=${rootRunId}`;
    }
    await tx`insert into allrice_policy_snapshots(id,organization_id,subject_id,version,payload,expires_at)
    values(${policy},${org},${user},1,${tx.json(frozenPolicy)},clock_timestamp()+interval '1 hour')`;
    await tx`update allrice_runs set policy_snapshot_id=${policy},execution_spec=${tx.json(executionSpec)},input='{}' where id=${rootRunId}`;
    await tx`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name)
    values(${employee},${org},${workspace},${manifest.key},${manifest.name})`;
    await tx`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
    values(${version},${org},${workspace},${employee},1,${manifest.name},${manifest.provider.model},${manifest.systemPrompt},${tx.json(manifest.capabilities)},${checksum},${tx.json(manifest)},${tx.json(manifest.provider)})`;
    if (options.legacyPublication && options.runtimePackage)
      await insertLegacyEmployeePublicationFixture(tx, {
        ...options.legacyPublication,
        organizationId: org,
        workspaceId: workspace,
        employeeId: employee,
        employeeVersionId: version,
        runtimePackage: options.runtimePackage,
      });
    await tx`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id,is_default)
        values(${assignment},${org},${workspace},${employee},${version},${user},false)`;
    const origin = options.businessCreationOrigin
      ? newEmployeeNativeRootOrigin(
          'chat',
          session,
          options.runtimePackage,
          version,
        )
      : null;
    await tx`insert into allrice_chat_sessions(id,organization_id,workspace_id,project_id,owner_id,title,employee_assignment_id,employee_version_id,native_root_origin)
        values(${session},${org},${workspace},${task.scope.projectId},${user},'P25 authority',${assignment},${version},${origin ? tx.json(origin) : null})`;
    await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
    values(${um},${org},${workspace},${session},${user},'user','{"text":"synthetic","citations":[]}'),
      (${am},${org},${workspace},${session},${user},'assistant','{"text":"synthetic","citations":[]}')`;
    await tx`insert into allrice_conversation_runtimes(organization_id,workspace_id,session_id,owner_id,thread_generation,config_checksum,state,active_run_id,worker_id)
    values(${org},${workspace},${session},${user},${base.worker.generation},${checksum},'running',${rootRunId},${base.worker.workerId})`;
    const prompt = options.preparePrompt
      ? await options.preparePrompt(tx, {
          organizationId: org,
          workspaceId: workspace,
          userId: user,
          sessionId: session,
          rootRunId,
          employeeVersionId: version,
          employeeAssignmentId: assignment,
          policyId: policy,
          executionSnapshot: snapshot,
          providerSnapshot: manifest.provider,
          workerId: base.worker.workerId,
          jobId: base.worker.jobId,
        })
      : {};
    await tx`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,native_skills,execution_snapshot,memory_context_state)
    values(${rootRunId},${org},${workspace},${user},${assignment},${version},${session},${um},${am},${tx.json(manifest.provider)},${tx.json(prompt)},'[]',${tx.json(JSON.parse(JSON.stringify(options.snapshot ? options.snapshot(snapshot, { sessionId: session }) : snapshot)))},${tx.json(options.memoryContextStateV2?.() ?? { schemaVersion: 1, pending: true })})`;
    const controls =
      options.controls === undefined ? defaultControls() : options.controls;
    if (controls)
      await tx`insert into allrice_runtime_policy_controls(organization_id,workspace_id,version,controls)
    values(${org},${workspace},${controls.version},${tx.json(controls)})`;
  });
  const ledger = createRuntimeOperationLedger({
    database: db,
    admission: async () => {},
  });
  if (options.configure !== false)
    await ensureRuntimeOperationRoot(
      ledger,
      task,
      new Date(Date.now() + 600000).toISOString(),
      db,
    );
  const setControls = (controls: RuntimePolicyControls) => db`
  update allrice_runtime_policy_controls set version=${controls.version},controls=${db.json(controls)}
  where organization_id=${org} and workspace_id=${workspace}`;
  return {
    ...base,
    task,
    ledger,
    base: { scope: task.scope, rootRunId, worker: base.worker },
    db,
    org,
    workspace,
    user,
    employee,
    version,
    assignment,
    session,
    policy,
    membership: membership!.id,
    manifest,
    snapshot,
    setControls,
    rootRunId,
  };
}
