import { readWorkAutomation, updateWorkAutomation } from './work-automation.ts';
/** Synthetic PostgreSQL/Bridge fixture only, never a production entrypoint. */
import { randomUUID } from 'node:crypto';
import {
  BridgeDeviceSchema,
  ExecutionContextSchema,
  localCommandToolchainImageV1,
  type RuntimeActionApprovalRequest,
} from '@allrice/contracts';
import type { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { createRunAuthorityFixture } from './run-authority.fixture.ts';
import { createLocalCommandOperation } from './local-command-service.ts';
import { reportLocalCommandProfile } from './local-command-profile.ts';
import { createGovernedBridgeOperationLedger } from './runtime-governed-bridge.ts';
import {
  decideRuntimeActionApproval,
  runtimePolicyDigest as digest,
} from './runtime-policy.ts';
export async function createLocalCommandFixture(
  database: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>['db'],
  effect: 'ask' | 'allow' = 'ask',
  project = false,
  options: {
    nativeSessionId?: string;
    deferRuntimeRoot?: boolean;
    projectWorkspace?: boolean;
    projectCloud?: boolean;
    snapshot?: NonNullable<
      Parameters<typeof createRunAuthorityFixture>[1]
    >['snapshot'];
    /** A current-generation package with a first-INSERT business origin; only
     * such a chat can bind a native session (MET-221). */
    runtimePackage?: NonNullable<
      Parameters<typeof createRunAuthorityFixture>[1]
    >['runtimePackage'];
    businessCreationOrigin?: boolean;
  } = {},
) {
  const f = await createRunAuthorityFixture(database, {
    snapshot: options.snapshot,
    runtimePackage: options.runtimePackage,
    businessCreationOrigin: options.businessCreationOrigin,
    project,
    ...(options.projectWorkspace ? { memberRole: 'member' as const } : {}),
    nativeSessionId: options.nativeSessionId,
    configure: !options.deferRuntimeRoot,
    allowedTools: [
      'web.fetch',
      'local.process.execute',
      ...(options.projectWorkspace ? ['workspace.project'] : []),
      ...(options.projectCloud ? ['cloud.process.execute'] : []),
    ],
    controls: {
      version: 1,
      enabled: true,
      mode: 'execute',
      rules: [
        { action: 'local.process.execute', effect },
        ...(options.projectCloud
          ? [{ action: 'cloud.process.execute' as const, effect }]
          : []),
      ],
    },
  });
  const { db } = f;
  const automation = await db.begin((tx) =>
    readWorkAutomation(tx, {
      organizationId: f.org,
      workspaceId: f.workspace,
      userId: f.user,
    }),
  );
  if (automation.available)
    await updateWorkAutomation(
      f.context,
      f.workspace,
      {
        expectedRevision: automation.revision,
        capability: 'computer',
        enabled: false,
      },
      db,
    );

  const deviceId = randomUUID(),
    grantId = randomUUID(),
    targetId = randomUUID();
  const now = new Date().toISOString();
  const device = BridgeDeviceSchema.parse({
    id: deviceId,
    organizationId: f.org,
    workspaceId: f.workspace,
    ownerId: f.user,
    name: 'Synthetic P25 Bridge',
    platform: 'macos-x64',
    protocolVersion: 2,
    capabilities: ['local.fs.write', 'local.fs.list'],
    status: 'online',
    lastSeenAt: now,
    createdAt: now,
    revokedAt: null,
  });
  await db`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at)
  values(${deviceId},${f.org},${f.workspace},${f.user},'Synthetic P25 Bridge','macos-x64',2,array['local.fs.write','local.fs.list'],${digest(deviceId).slice(7)},clock_timestamp())`;
  await db`insert into allrice_bridge_folder_grants(id,organization_id,workspace_id,owner_id,device_id,label,root_fingerprint)
  values(${grantId},${f.org},${f.workspace},${f.user},${deviceId},'Synthetic work copy',${'a'.repeat(64)})`;
  await db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities,metadata)
  values(${targetId},${f.org},${f.workspace},${`bridge.${deviceId}`},'rice_bridge','Synthetic P25 Bridge','online',${db.json(['files.read', 'files.write'])},${db.json({ bridgeDeviceId: deviceId })})`;
  await reportLocalCommandProfile(
    device,
    {
      contractVersion: 1,
      backend: 'local-vm-container-v1',
      imageDigest: localCommandToolchainImageV1,
      architecture: 'amd64',
      available: true,
    },
    db,
  );
  const [policy] = await db<
    {
      payload: Record<string, unknown>;
      issued_at: Date;
      expires_at: Date;
    }[]
  >`
  select payload,issued_at,expires_at from allrice_policy_snapshots where id=${f.policy}`;
  const context = ExecutionContextSchema.parse({
    executionId: randomUUID(),
    runId: f.rootRunId,
    jobId: f.worker.jobId,
    worker: { type: 'worker', id: f.worker.workerId },
    delegatedBy: f.context.actor,
    organizationId: f.org,
    workspaceId: f.workspace,
    startedAt: now,
    policySnapshot: {
      id: f.policy,
      organizationId: f.org,
      subjectId: f.user,
      version: 1,
      issuedAt: policy!.issued_at.toISOString(),
      expiresAt: policy!.expires_at.toISOString(),
      ...policy!.payload,
    },
  });
  const args = {
    executable: '/usr/local/bin/node',
    args: ['test.mjs'],
    path: '.',
    files: [{ path: 'test.mjs', sha256: digest('synthetic-never-executed') }],
    limits: {
      timeoutMs: 10000,
      outputBytes: 8192,
      memoryMiB: 128,
      cpuMillis: 500,
      pids: 32,
    },
  };
  const create = (
    callId: string = randomUUID(),
    argumentsInput: unknown = args,
  ) => {
    return createLocalCommandOperation(
      { context, arguments: argumentsInput, callId },
      db,
    );
  };
  const freshLedger = () =>
    createGovernedBridgeOperationLedger(device, { database: db });
  const approve = async (request: RuntimeActionApprovalRequest) =>
    decideRuntimeActionApproval(
      f.context,
      request.approvalId,
      {
        contractVersion: 1,
        direction: 'response',
        kind: 'action_approval',
        requestId: request.requestId,
        version: request.version,
        requestDigest: request.requestDigest,
        task: request.task,
        responseId: randomUUID(),
        respondedBy: f.user,
        respondedAt: new Date().toISOString(),
        approvalId: request.approvalId,
        decision: 'approved',
      },
      db,
    );
  const approvalFor = async (operationId: string) => {
    const [row] = await db<
      { runtime_request: RuntimeActionApprovalRequest }[]
    >`select runtime_request from allrice_approval_requests where resource_id=${operationId} and resource_type='runtime_operation'`;
    if (!row) throw Error('Expected exact command approval');
    return row.runtime_request;
  };
  return {
    ...f,
    device,
    args,
    context,
    requestContext: f.context,
    create,
    freshLedger,
    approve,
    approvalFor,
  };
}
