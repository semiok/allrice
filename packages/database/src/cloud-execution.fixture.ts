import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  ExecutionContextSchema,
  EmployeeExecutionSnapshotSchema,
  cloudToolchainImageV1,
  type DshExecutionSnapshot,
  type DshNativeSkillSnapshot,
  type EmployeePromptSnapshotSchema,
  type RequestContext,
} from '@allrice/contracts';
import { LocalStorageAdapter } from '../../storage/src/local.ts';
import {
  createCloudCommandOperation,
  installCloudExecutionGrant,
} from './cloud-execution.ts';
import { createToolBrokerExportObject } from './execution/tool-broker.ts';
import {
  setRuntimePolicyControls,
  getRuntimeActionApproval,
  decideRuntimeActionApproval,
  runtimePolicyDigest as digest,
} from './runtime-policy.ts';

export async function createCloudExecutionFixture(
  db: ReturnType<typeof postgres>,
  storageRoot: string,
  options: {
    frozenTool?: boolean;
    planOnly?: boolean;
    workbench?: boolean;
    reconciliationOnly?: boolean;
    browserControl?: boolean;
    localBrowser?: boolean;
    /** Test-only initial values: persisted once, never mutate a frozen Run. */
    dsh?: {
      provider: DshExecutionSnapshot;
      skills: DshNativeSkillSnapshot[];
      prompt: ReturnType<typeof EmployeePromptSnapshotSchema.parse>;
    };
  } = {},
) {
  const org = randomUUID(),
    workspace = randomUUID(),
    user = randomUUID(),
    membership = randomUUID(),
    run = randomUUID(),
    policy = randomUUID(),
    employee = randomUUID(),
    version = randomUUID(),
    assignment = randomUUID(),
    session = randomUUID(),
    job = randomUUID(),
    worker = randomUUID(),
    target = randomUUID();
  const now = new Date().toISOString();
  const memberships = [
    {
      id: membership,
      organizationId: org,
      workspaceId: workspace,
      userId: user,
      role: 'admin' as const,
      active: true,
    },
  ];
  const policyPayload = {
    memberships,
    grants: [
      { resourceType: 'job', action: 'job:execute', workspaceId: workspace },
      {
        resourceType: 'storage_object',
        action: 'resource:read',
        workspaceId: workspace,
      },
    ],
  };
  const context: RequestContext = {
    actor: { type: 'user', id: user },
    organizationId: org,
    workspaceId: workspace,
    requestId: randomUUID(),
    sessionId: randomUUID(),
    authenticatedAt: now,
    memberships,
  };
  const capabilities = [
    ...(options.dsh ? ['model:invoke'] : []),
    'storage:read',
    'storage:write',
    ...(options.browserControl || options.localBrowser
      ? ['network:outbound']
      : []),
  ];
  const toolNames = options.dsh
    ? [
        ...new Set(
          options.dsh.skills.flatMap((skill) => skill.requiredToolRefs),
        ),
      ]
    : [
        ...(options.browserControl ? ['browser.workspace'] : []),
        ...(options.localBrowser ? ['local.browser.workspace'] : []),
        ...(options.frozenTool === false ? [] : ['cloud.process.execute']),
        ...(options.workbench
          ? [
              ...(options.reconciliationOnly
                ? []
                : ['workspace.export.create']),
              'workspace.reconciliation.export',
            ]
          : []),
      ];
  const frozen = EmployeeExecutionSnapshotSchema.parse({
    schemaVersion: 1,
    employee: {
      id: employee,
      versionId: version,
      key: 'p15',
      revision: 1,
      definitionChecksum: digest('p15'),
      definition: {
        schemaVersion: 1,
        key: 'p15',
        name: 'P15 synthetic',
        description: 'Synthetic tests only',
        systemPrompt: 'Synthetic tests only',
        provider: {
          provider: 'basic',
          authMode: 'none',
          model: 'allrice/basic-assistant-v1',
          reasoningEffort: 'none',
          sandbox: 'none',
        },
        capabilities,
        skillVersionIds: [],
      },
    },
    assignment: {
      id: assignment,
      userId: user,
      assignedBy: user,
      assignedAt: now,
    },
    runtimePolicy: {
      harness: 'dsh',
      provider: 'openai-codex',
      model: options.dsh?.provider.model ?? 'fixture',
      reasoningEffort: options.dsh?.provider.reasoningEffort ?? 'high',
      timeoutMs: options.dsh ? 180000 : 300000,
      fallbackModels: [],
      credentialReference:
        options.dsh?.provider.credentialReference ?? 'test:never-resolved',
    },
    capabilitySnapshot: {
      declaredCapabilities: capabilities,
      grantedCapabilities: capabilities,
      bindings: {
        skillVersionIds: [],
        toolNames,
        knowledgeScopes: ['workspace'],
        workflowIds: [],
      },
      skillBindings: [],
    },
    tenantContext: {
      organizationId: org,
      workspaceId: workspace,
      actorId: user,
      policySnapshotId: policy,
    },
    userProfile: {
      schemaVersion: 1,
      displayName: 'P15 synthetic',
      preferences: {},
    },
    createdAt: now,
  });
  await db.begin(async (tx) => {
    await tx`insert into allrice_users(id,email,display_name,password_hash) values(${user},${`${user}@example.test`},'P15 synthetic','not-login')`;
    await tx`insert into allrice_organizations(id,slug,name) values(${org},${`p15-${org}`},'P15 synthetic')`;
    await tx`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspace},${org},'test','P15 synthetic')`;
    await tx`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values(${membership},${org},${workspace},${user},'admin')`;
    await tx`insert into allrice_policy_snapshots(id,organization_id,subject_id,version,payload,expires_at) values(${policy},${org},${user},1,${tx.json(policyPayload)},clock_timestamp()+interval '1 hour')`;
    await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,policy_snapshot_id,execution_spec,input) values(${run},${org},${workspace},${user},'running',${policy},'{}','{}')`;
    await tx`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name) values(${employee},${org},${workspace},'p15','P15')`;
    await tx`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest) values(${version},${org},${workspace},${employee},1,'P15','synthetic','synthetic','[]',${digest('p15')},'{}')`;
    await tx`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id) values(${assignment},${org},${workspace},${employee},${version},${user})`;
    await tx`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id) values(${session},${org},${workspace},${user},'P15 synthetic',${assignment},${version})`;
    const um = randomUUID(),
      am = randomUUID();
    await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content) values(${um},${org},${workspace},${session},${user},'user','{"text":"synthetic","citations":[]}'),(${am},${org},${workspace},${session},${user},'assistant','{"text":"synthetic","citations":[]}')`;
    await tx`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,execution_snapshot,native_skills) values(${run},${org},${workspace},${user},${assignment},${version},${session},${um},${am},${tx.json(options.dsh?.provider ?? {})},${tx.json(options.dsh?.prompt ?? {})},${tx.json(JSON.parse(JSON.stringify(frozen)))},${tx.json(options.dsh?.skills ?? [])})`;
    await tx`insert into allrice_conversation_runtimes(organization_id,workspace_id,session_id,owner_id,thread_generation,config_checksum,state,active_run_id,worker_id) values(${org},${workspace},${session},${user},1,${digest('p15')},'running',${run},${worker})`;
    await tx`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at,attempt) values(${job},${org},${workspace},${user},${run},'running',${randomUUID()},clock_timestamp()+interval '5 minutes','{"schemaVersion":1,"type":"allrice.employee.run","input":{}}',${worker},${randomUUID()},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '5 minutes',${options.browserControl ? 1 : 0})`;
    await tx`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities) values(${target},${org},${workspace},'cloud.p15','cloud_sandbox','P15 gVisor','online',${tx.json(['process.execute', 'artifacts.write', ...(options.browserControl ? ['browser.navigate'] : [])])})`;
  });
  const execution = ExecutionContextSchema.parse({
    executionId: randomUUID(),
    runId: run,
    jobId: job,
    worker: { type: 'worker', id: worker },
    delegatedBy: context.actor,
    organizationId: org,
    workspaceId: workspace,
    policySnapshot: {
      id: policy,
      organizationId: org,
      subjectId: user,
      version: 1,
      issuedAt: now,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      ...policyPayload,
    },
    startedAt: now,
  });
  await setRuntimePolicyControls(
    context,
    {
      version: 1,
      enabled: true,
      mode: options.planOnly ? 'plan_only' : 'execute',
      rules: [
        { action: 'cloud.process.execute', effect: 'allow' },
        ...(options.localBrowser
          ? [
              {
                action: 'local.browser.act' as const,
                effect: 'allow' as const,
              },
              {
                action: 'local.browser.observe' as const,
                effect: 'allow' as const,
              },
            ]
          : []),
        ...(options.browserControl
          ? [
              {
                action: 'cloud.browser.act' as const,
                effect: 'allow' as const,
              },
              {
                action: 'cloud.browser.observe' as const,
                effect: 'allow' as const,
              },
            ]
          : []),
      ],
    },
    null,
    db,
  );
  const grant = await installCloudExecutionGrant(
    context,
    {
      ownerId: user,
      targetId: target,
      enabled: true,
      profile: {
        backend: 'cloud-gvisor-v1',
        imageDigest: cloudToolchainImageV1,
        architecture: 'amd64',
        runtime: 'runsc',
        runtimeVersion: 'release-20260831.0',
        runtimeChecksum:
          'sha256:1a4995a70b3c8b7d36f55d7d2dc6d15185ebe420de653b1a330b42d36c0e6b4a',
        network: 'none',
        maximumConcurrency: 2,
      },
    },
    db,
  );
  const storage = new LocalStorageAdapter(storageRoot);
  const upload = async (data: Buffer, mediaType = 'application/json') => {
    const object = createToolBrokerExportObject({
      context: execution,
      mediaType,
      sizeBytes: data.length,
      checksum: `sha256:${createHash('sha256').update(data).digest('hex')}`,
    });
    await storage.put(object, new Blob([Uint8Array.from(data)]).stream());
    await db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,visibility,state) values(${object.id},${org},${workspace},${user},${object.key},'uploads',${object.mediaType},${data.length},${object.checksum},'private','ready')`;
    return object;
  };
  const object = await upload(Buffer.from('[12,8,5]'));
  const args = {
    script:
      "import fs from 'node:fs'; const n=JSON.parse(fs.readFileSync('input/data.json','utf8'));fs.writeFileSync('output/result.json',JSON.stringify({sum:n.reduce((a,b)=>a+b,0)}));console.log('calculated');",
    inputs: [
      { path: 'data.json', objectId: object.id, checksum: object.checksum },
    ],
    outputs: [{ path: 'result.json', fileName: 'result.json', format: 'json' }],
  };
  const create = (callId = 'p15-task', argumentsInput: unknown = args) =>
    createCloudCommandOperation(
      { context: execution, arguments: argumentsInput, callId },
      db,
    );
  const approve = async (
    created: Pick<Awaited<ReturnType<typeof create>>, 'snapshot'>,
  ) => {
    const [row] = await db<
      { id: string }[]
    >`select id from allrice_approval_requests where resource_id=${created.snapshot.binding.attempt.operationId} and resource_type='runtime_operation'`;
    const { request: req } = await getRuntimeActionApproval(
      context,
      row!.id,
      db,
    );
    await decideRuntimeActionApproval(
      context,
      req.approvalId,
      {
        contractVersion: 1,
        direction: 'response',
        kind: 'action_approval',
        requestId: req.requestId,
        version: req.version,
        requestDigest: req.requestDigest,
        task: req.task,
        responseId: randomUUID(),
        respondedBy: user,
        respondedAt: new Date().toISOString(),
        approvalId: req.approvalId,
        decision: 'approved',
      },
      db,
    );
    return req;
  };
  return {
    context,
    execution,
    grant,
    object,
    storage,
    create,
    approve,
    args,
    run,
    workspace,
    org,
    user,
    target,
    worker,
    session,
    storageRoot,
    upload,
  };
}
