/** Synthetic P17 PostgreSQL fixture. No real Bridge/process/credential/model. */
import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  BridgeDeviceSchema,
  EmployeeExecutionSnapshotSchema,
  ExecutionContextSchema,
  RuntimeLocalMcpResultSchema,
  localCommandToolchainImageV1,
  type RequestContext,
  type McpDiscoveredTool,
  type FrozenLocalMcpConnection,
} from '@allrice/contracts';
import { createLocalMcpStore } from './local-mcp-connections.ts';
import { createEmployeeMcpBindingStore } from './mcp-employee-bindings.ts';
import { employeeManifest } from './employees/employee-config.ts';
import { prepareEmployeeRunBinding } from './employees/employeehub.ts';
import { createLocalMcpRuntimeOperation } from './local-mcp-execution.ts';
import { createGovernedBridgeOperationLedger } from './runtime-governed-bridge.ts';
import { reportLocalCommandProfile } from './local-command-profile.ts';
import {
  runtimePolicyDigest as digest,
  setRuntimePolicyControls,
  getRuntimeActionApproval,
  decideRuntimeActionApproval,
} from './runtime-policy.ts';

export const localMcpFixtureTool: McpDiscoveredTool = {
  name: 'records.list',
  description: 'List synthetic records',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: null,
};
export async function createLocalMcpFixture(
  db: ReturnType<typeof postgres>,
  options: {
    bind?: boolean;
    skill?: boolean;
    platform?: 'macos-x64' | 'macos-arm64';
    rootFingerprint?: string;
    configuration?: FrozenLocalMcpConnection['configuration'];
    deviceTokenHash?: string;
  } = {},
) {
  const org = randomUUID(),
    workspace = randomUUID(),
    user = randomUUID(),
    membership = randomUUID(),
    employee = randomUUID(),
    version = randomUUID(),
    assignment = randomUUID(),
    session = randomUUID(),
    deviceId = randomUUID(),
    grant = randomUUID(),
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
  const context: RequestContext = {
    actor: { type: 'user', id: user },
    organizationId: org,
    workspaceId: workspace,
    requestId: randomUUID(),
    sessionId: randomUUID(),
    authenticatedAt: now,
    memberships,
  };
  const scope = { organizationId: org, workspaceId: workspace, actorId: user };
  await db`insert into allrice_users(id,email,display_name,password_hash) values(${user},${`${user}@example.test`},'P17 synthetic','not-login')`;
  await db`insert into allrice_organizations(id,slug,name) values(${org},${`p17-${org}`},'P17 synthetic')`;
  await db`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspace},${org},'p17','P17 synthetic')`;
  await db`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values(${membership},${org},${workspace},${user},'admin')`;
  const platform = options.platform ?? 'macos-x64';
  const rootFingerprint = options.rootFingerprint ?? 'c'.repeat(64);
  const tokenHash =
    options.deviceTokenHash ??
    createHash('sha256').update(deviceId).digest('hex');
  if (
    !/^[a-f0-9]{64}$/.test(rootFingerprint) ||
    !/^[a-f0-9]{64}$/.test(tokenHash)
  )
    throw Error('Synthetic fixture fingerprints must be raw SHA256 hex');
  await db`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at)
    values(${deviceId},${org},${workspace},${user},'Synthetic P17 Bridge',${platform},2,array['local.fs.list','local.fs.write'],${tokenHash},clock_timestamp())`;
  await db`insert into allrice_bridge_folder_grants(id,organization_id,workspace_id,owner_id,device_id,label,root_fingerprint)
    values(${grant},${org},${workspace},${user},${deviceId},'P17 synthetic source',${rootFingerprint})`;
  await db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities,metadata)
    values(${target},${org},${workspace},${`bridge.${deviceId}`},'rice_bridge','P17 synthetic Bridge','online','["files.read","files.write"]',${db.json({ bridgeDeviceId: deviceId })})`;
  const device = BridgeDeviceSchema.parse({
    id: deviceId,
    organizationId: org,
    workspaceId: workspace,
    ownerId: user,
    name: 'Synthetic P17 Bridge',
    platform,
    protocolVersion: 2,
    capabilities: ['local.fs.list', 'local.fs.write'],
    status: 'online',
    lastSeenAt: now,
    createdAt: now,
    revokedAt: null,
  });
  await reportLocalCommandProfile(
    device,
    {
      contractVersion: 1,
      backend: 'local-vm-container-v1',
      imageDigest: localCommandToolchainImageV1,
      architecture: platform === 'macos-arm64' ? 'arm64' : 'amd64',
      available: true,
      features: ['local_mcp'],
    },
    db,
  );
  const source = {
    name: 'P17 synthetic MCP',
    version: '1',
    entrypoint: 'server.mjs',
    files: [{ path: 'server.mjs', sha256: digest('synthetic source bytes') }],
  };
  const configuration = options.configuration ?? {
    path: '.',
    source: { ...source, digest: digest(source) },
    credential: null,
  };
  const store = createLocalMcpStore({ database: db });
  const connection = await store.create(context, {
    workspaceId: workspace,
    name: 'P17 local MCP',
    deviceId,
    folderGrantId: grant,
    configuration,
  });
  const manifest = employeeManifest({
    key: 'p17',
    name: 'P17',
    description: 'Synthetic local MCP employee',
    toolNames: ['local.mcp.discover', 'local.mcp.call', 'local.fs.write'],
    securityPolicy: {
      dataScopes: ['workspace'],
      connectorIdentityModes: ['service'],
      approvalPolicy: 'confirm_side_effects',
      deniedCapabilities: [],
    },
  });
  await db`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name) values(${employee},${org},${workspace},'p17','P17')`;
  // A declared capability is not an authorization. Use the existing published
  // Skill + employee assignment authority to activate workspace write access.
  // The local MCP grant itself must never mint generic storage:write access.
  const skill = options.skill === false ? null : randomUUID();
  if (skill) {
    const content =
      '# Synthetic workspace changes\nOnly make explicitly approved changes inside the authorized workspace.';
    const checksum = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    await db`insert into allrice_dsh_skills(id,organization_id,workspace_id,name,description,content,checksum,required_tool_refs,created_by)
      values(${skill},${org},${workspace},'p17-workspace-changes','Synthetic approved workspace changes',${content},${checksum},'["local.fs.write"]',${user})`;
    await db`insert into allrice_employee_dsh_skill_bindings(organization_id,workspace_id,employee_id,skill_id,bound_by)
      values(${org},${workspace},${employee},${skill},${user})`;
  }
  await db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
    values(${version},${org},${workspace},${employee},1,'P17',${manifest.provider.model},${manifest.systemPrompt},${db.json(manifest.capabilities)},${digest(manifest)},${db.json(manifest)},${db.json(manifest.provider)})`;
  await db`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id) values(${assignment},${org},${workspace},${employee},${version},${user})`;
  await db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id) values(${session},${org},${workspace},${user},'P17 synthetic',${assignment},${version})`;
  const employeeBindings = createEmployeeMcpBindingStore({
    database: db,
    transport: 'local_stdio',
  });
  const beforeBinding = await store.freeze(scope, employee, version);
  const employeeGrant =
    options.bind === false
      ? null
      : await employeeBindings.bind(context, {
          workspaceId: workspace,
          connectionId: connection.id,
          employeeId: employee,
          employeeVersionId: version,
          expectedRevision: 0,
          enabled: true,
        });
  await setRuntimePolicyControls(
    context,
    {
      version: 1,
      enabled: true,
      mode: 'execute',
      rules: [
        { action: 'local.mcp.discover', effect: 'allow' },
        { action: 'local.mcp.call', effect: 'allow' },
      ],
    },
    null,
    db,
  );
  const ledger = () =>
    createGovernedBridgeOperationLedger(device, { database: db });
  let runSequence = 0;
  async function newRun() {
    const policyVersion = ++runSequence;
    const run = randomUUID(),
      job = randomUUID(),
      worker = randomUUID(),
      policy = randomUUID(),
      um = randomUUID(),
      am = randomUUID();
    const policyPayload = {
      memberships,
      grants: [
        { resourceType: 'job', action: 'job:execute', workspaceId: workspace },
      ],
    };
    await db`insert into allrice_policy_snapshots(id,organization_id,subject_id,version,payload,expires_at) values(${policy},${org},${user},${policyVersion},${db.json(policyPayload)},clock_timestamp()+interval '1 hour')`;
    await db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,policy_snapshot_id,execution_spec,input) values(${run},${org},${workspace},${user},'running',${policy},${db.json({ employeeVersionId: version })},'{}')`;
    await db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
      values(${um},${org},${workspace},${session},${user},'user','{"text":"synthetic local MCP task","citations":[]}'),(${am},${org},${workspace},${session},${user},'assistant','{"text":"synthetic local MCP task","citations":[]}')`;
    await db`insert into allrice_conversation_runtimes(organization_id,workspace_id,session_id,owner_id,thread_generation,config_checksum,state,active_run_id,worker_id)
      values(${org},${workspace},${session},${user},1,${digest('p17-runtime')},'running',${run},${worker})
      on conflict(session_id) do update set state='running',active_run_id=excluded.active_run_id,worker_id=excluded.worker_id`;
    await db`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at)
      values(${job},${org},${workspace},${user},${run},'running',${randomUUID()},clock_timestamp()+interval '5 minutes','{"schemaVersion":1,"type":"allrice.employee.run","input":{}}',${worker},${randomUUID()},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '5 minutes')`;
    const prepared = await prepareEmployeeRunBinding({
      context,
      workspaceId: workspace,
      assignmentId: assignment,
      employeeVersionId: version,
      sessionId: session,
      userMessageId: um,
      assistantMessageId: am,
      promptSnapshot: {
        systemPrompt: 'Synthetic test',
        conversation: [],
        memories: [],
        userRequest: 'Use synthetic local MCP',
      },
    });
    const snapshot = EmployeeExecutionSnapshotSchema.parse({
      ...prepared.executionSnapshot,
      tenantContext: {
        organizationId: org,
        workspaceId: workspace,
        actorId: user,
        policySnapshotId: policy,
      },
      createdAt: new Date().toISOString(),
    });
    await db`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,native_skills,execution_snapshot)
      values(${run},${org},${workspace},${user},${assignment},${version},${session},${um},${am},${db.json(prepared.providerSnapshot)},${db.json(prepared.promptSnapshot)},${db.json(prepared.nativeSkills)},${db.json(JSON.parse(JSON.stringify(snapshot)))})`;
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
        version: policyVersion,
        issuedAt: now,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        ...policyPayload,
      },
      startedAt: now,
    });
    const create = (
      capability:
        'local.mcp.discover' | 'local.mcp.call' = 'local.mcp.discover',
      callId = randomUUID(),
      args: unknown = capability === 'local.mcp.call'
        ? {
            connectionId: connection.id,
            tool: localMcpFixtureTool.name,
            arguments: {},
          }
        : { connectionId: connection.id },
    ) =>
      createLocalMcpRuntimeOperation(
        { context: execution, capability, arguments: args, callId },
        db,
      );
    return { run, job, worker, policy, execution, snapshot, prepared, create };
  }
  async function decide(
    c: Awaited<ReturnType<Awaited<ReturnType<typeof newRun>>['create']>>,
    decision: 'approved' | 'rejected' = 'approved',
  ) {
    const [approval] = await db<
      { id: string }[]
    >`select id from allrice_approval_requests where resource_type='runtime_operation' and resource_id=${c.snapshot.binding.attempt.operationId}`;
    const { request: req } = await getRuntimeActionApproval(
      context,
      approval!.id,
      db,
    );
    return decideRuntimeActionApproval(
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
        decision,
      },
      db,
    );
  }
  const runtimeScope = {
    organizationId: org,
    workspaceId: workspace,
    projectId: null,
  };
  const claim = (supportsLocalMcp = true) =>
    ledger().claimNextBridgeOperation({
      scope: runtimeScope,
      deviceId,
      leaseMs: 30000,
      supportsLocalMcp,
    });
  async function start() {
    const lease = await claim();
    if (!lease) throw Error('Fixture expected authorized device lease');
    const input = {
      scope: runtimeScope,
      operationId: lease.snapshot.binding.attempt.operationId,
      leaseToken: lease.leaseToken,
      attempt: lease.snapshot.binding.attempt,
      receiptId: randomUUID(),
    };
    const result = await ledger().startOperation(input);
    if (!result.mayExecute) throw Error('Fixture expected START authorization');
    return { lease, input };
  }
  function receiptFor(
    dispatched: Awaited<ReturnType<typeof start>>,
    tools: McpDiscoveredTool[] = [localMcpFixtureTool],
    overrides: Partial<
      ReturnType<typeof RuntimeLocalMcpResultSchema.parse>
    > = {},
  ) {
    const output = RuntimeLocalMcpResultSchema.parse(
      JSON.parse(
        JSON.stringify({
          backend: 'local-vm-container-v1',
          containerId: 'a'.repeat(64),
          imageDigest: localCommandToolchainImageV1,
          phase: 'completed',
          reason: 'completed',
          stopConfirmed: true,
          callAttempted: false,
          resultKnown: true,
          tools,
          stderr: '',
          truncated: false,
          workCopy: 'local_isolated_copy',
          sourceDirectoryModified: false,
          ...overrides,
        }),
      ),
    );
    const receipt = {
      ...dispatched.input,
      receiptId: randomUUID(),
      deviceSequence: 1,
      signal: {
        type: 'operation.outcome' as const,
        result: {
          status: 'succeeded' as const,
          effects: 'none' as const,
          evidence: {
            id: randomUUID(),
            recordedAt: new Date().toISOString(),
            digest: digest(output),
          },
        },
      },
      evidence: { output },
    };
    return receipt;
  }
  async function complete(
    dispatched: Awaited<ReturnType<typeof start>>,
    tools: McpDiscoveredTool[] = [localMcpFixtureTool],
  ) {
    const receipt = receiptFor(dispatched, tools);
    return { receipt, result: await ledger().recordReceipt(receipt) };
  }
  async function discover(tools: McpDiscoveredTool[] = [localMcpFixtureTool]) {
    const run = await newRun(),
      operation = await run.create();
    await decide(operation);
    const dispatched = await start(),
      completed = await complete(dispatched, tools);
    await store.acceptDiscovery(operation.snapshot.binding.attempt.operationId);
    return {
      run,
      operation,
      dispatched,
      completed,
      connection: (await store.list(context, workspace)).find(
        (c) => c.id === connection.id,
      )!,
    };
  }
  const grantTool = async () => {
    const discovered = await discover();
    const tool = discovered.connection.tools[0]!;
    await store.grant(context, {
      workspaceId: workspace,
      connectionId: connection.id,
      revisionId: tool.revisionId,
      allowed: true,
      risk: 'read_only',
    });
    return discovered;
  };
  return {
    db,
    org,
    workspace,
    user,
    context,
    scope,
    device,
    grant,
    target,
    configuration,
    connection,
    store,
    employeeBindings,
    employeeGrant,
    employee,
    skill,
    version,
    assignment,
    session,
    beforeBinding,
    newRun,
    decide,
    claim,
    start,
    complete,
    receiptFor,
    discover,
    grantTool,
    ledger,
    runtimeScope,
  };
}

export const createLocalMcpExecutionFixture = createLocalMcpFixture;
