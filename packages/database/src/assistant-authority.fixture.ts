/** Synthetic isolated PostgreSQL fixture only; not a production entrypoint. */
import { randomUUID } from 'node:crypto';
import {
  EmployeeExecutionSnapshotSchema,
  type EmployeeExecutionSnapshot,
  type RuntimePolicyControls,
  type RuntimeTaskRef,
} from '@allrice/contracts';
import { assertAssistantAuthority } from './assistant-authority.ts';
import {
  createAssistantRuntime,
  type AssistantAuthorityInput,
} from './assistant-runtime.ts';
import {
  assistantFixture,
  type createAssistantFixtureDatabase,
} from './assistant-runtime.fixture.ts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from './employees/employee-config.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
const defaultControls = (): RuntimePolicyControls => ({
  version: 1,
  enabled: true,
  mode: 'execute',
  rules: [{ action: 'assistant.delegate', effect: 'allow' }],
});
export async function createAssistantAuthorityFixture(
  db: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>['db'],
  options: {
    controls?: RuntimePolicyControls | null;
    toolNames?: string[];
    allowedTools?: string[];
    project?: boolean;
    nativeSessionId?: string;
    snapshot?: (value: EmployeeExecutionSnapshot) => unknown;
    deniedModel?: boolean;
    configure?: boolean;
  } = {},
) {
  const selectedTools = options.allowedTools ?? [
    'assistant.delegate',
    'assistant.report',
    'web.fetch',
  ];
  const base = await assistantFixture(db, 12, {
    nativeSessionId: options.nativeSessionId,
  });
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
  const manifest = employeeManifest({
    key: 'p25-authority',
    name: 'P25 authority',
    description: 'Synthetic authority fixture',
    toolNames: options.toolNames ?? selectedTools,
    runtimePolicy: {
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
  const checksum = employeeManifestChecksum(manifest);
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
  const frozenPolicy = {
    memberships: [
      {
        id: membership!.id,
        userId: user,
        organizationId: org,
        workspaceId: workspace,
        role: 'admin',
        active: true,
      },
    ],
    grants: [
      {
        resourceType: 'job',
        action: 'job:execute',
        workspaceId: workspace,
      },
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
    // Replace only the synthetic permissive fixture's root admission, before
    // any child/message/usage exists. Production configure runs below.
    await tx`delete from allrice_assistant_instances where root_run_id=${rootRunId}`;
    await tx`delete from allrice_assistant_roots where root_run_id=${rootRunId}`;
    await tx`update allrice_runtime_roots set task=${tx.json(task)} where root_run_id=${rootRunId}`;
    await tx`update allrice_runtime_run_links set task=${tx.json(task)} where run_id=${rootRunId}`;
    await tx`insert into allrice_policy_snapshots(id,organization_id,subject_id,version,payload,expires_at)
    values(${policy},${org},${user},1,${tx.json(frozenPolicy)},clock_timestamp()+interval '1 hour')`;
    await tx`update allrice_runs set policy_snapshot_id=${policy},execution_spec=${tx.json(executionSpec)},input=${tx.json({ assistantConfiguration: base.config })} where id=${rootRunId}`;
    await tx`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name)
    values(${employee},${org},${workspace},'p25-authority','P25 authority')`;
    await tx`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
    values(${version},${org},${workspace},${employee},1,'P25 authority',${manifest.provider.model},${manifest.systemPrompt},${tx.json(manifest.capabilities)},${checksum},${tx.json(manifest)},${tx.json(manifest.provider)})`;
    await tx`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id,is_default)
        values(${assignment},${org},${workspace},${employee},${version},${user},false)`;
    await tx`insert into allrice_chat_sessions(id,organization_id,workspace_id,project_id,owner_id,title,employee_assignment_id,employee_version_id)
        values(${session},${org},${workspace},${task.scope.projectId},${user},'P25 authority',${assignment},${version})`;
    await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
    values(${um},${org},${workspace},${session},${user},'user','{"text":"synthetic","citations":[]}'),
      (${am},${org},${workspace},${session},${user},'assistant','{"text":"synthetic","citations":[]}')`;
    await tx`insert into allrice_conversation_runtimes(organization_id,workspace_id,session_id,owner_id,thread_generation,config_checksum,state,active_run_id,worker_id)
    values(${org},${workspace},${session},${user},${base.worker.generation},${checksum},'running',${rootRunId},${base.worker.workerId})`;
    await tx`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,native_skills,execution_snapshot)
    values(${rootRunId},${org},${workspace},${user},${assignment},${version},${session},${um},${am},${tx.json(manifest.provider)},'{}','[]',${tx.json(JSON.parse(JSON.stringify(options.snapshot ? options.snapshot(snapshot) : snapshot)))})`;
    const controls =
      options.controls === undefined ? defaultControls() : options.controls;
    if (controls)
      await tx`insert into allrice_runtime_policy_controls(organization_id,workspace_id,version,controls)
    values(${org},${workspace},${controls.version},${tx.json(controls)})`;
  });
  const runtime = createAssistantRuntime({
    database: db,
    authorize: assertAssistantAuthority,
  });
  const configure = () =>
    runtime.configureRoot({
      task,
      configuration: base.config,
      nativeSessionId: base.nativeSessionId,
      worker: base.worker,
      allowedTools: selectedTools,
    });
  if (options.configure !== false) await configure();
  const authorize = (
    phase: AssistantAuthorityInput['phase'] = 'configure',
    tools = selectedTools,
    requestedTask = task,
  ) =>
    db.begin((transaction) =>
      assertAssistantAuthority({
        transaction,
        task: requestedTask,
        tools,
        phase,
      }),
    );
  const setControls = (controls: RuntimePolicyControls) => db`
  update allrice_runtime_policy_controls set version=${controls.version},controls=${db.json(controls)}
  where organization_id=${org} and workspace_id=${workspace}`;
  return {
    ...base,
    task,
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
    runtime,
    base: { ...base.base, scope: task.scope },
    configure,
    authorize,
    setControls,
    rootRunId,
  };
}
