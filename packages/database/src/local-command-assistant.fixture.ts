/** Synthetic PostgreSQL/Bridge fixture only, never a production entrypoint. */
import { randomUUID } from 'node:crypto';
import {
  BridgeDeviceSchema,
  ExecutionContextSchema,
  localCommandToolchainImageV1,
  type RuntimeActionApprovalRequest,
} from '@allrice/contracts';
import type { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from './assistant-authority.fixture.ts';
import { createLocalCommandOperation } from './local-command-service.ts';
import { reportLocalCommandProfile } from './local-command-profile.ts';
import { createGovernedBridgeOperationLedger } from './runtime-governed-bridge.ts';
import {
  decideRuntimeActionApproval,
  runtimePolicyDigest as digest,
} from './runtime-policy.ts';
export async function createAssistantLocalCommandFixture(
  database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>['db'],
  effect: 'ask' | 'allow' = 'ask',
  project = false,
  options: { nativeSessionId?: string; deferRuntimeRoot?: boolean } = {},
) {
  const f = await createAssistantAuthorityFixture(database, {
    project,
    nativeSessionId: options.nativeSessionId,
    configure: !options.deferRuntimeRoot,
    allowedTools: [
      'assistant.delegate',
      'assistant.report',
      'web.fetch',
      'local.process.execute',
    ],
    controls: {
      version: 1,
      enabled: true,
      mode: 'execute',
      rules: [
        { action: 'assistant.delegate', effect: 'allow' },
        { action: 'local.process.execute', effect },
      ],
    },
  });
  const { db } = f;
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
  const child = options.deferRuntimeRoot
    ? null
    : (
        await f.runtime.provision({
          ...f.base,
          parentRunId: f.rootRunId,
          delegationId: randomUUID(),
          label: 'Synthetic command proposal',
          text: 'Submit for exact approval',
          tools: ['local.process.execute'],
        })
      ).instance;
  if (options.deferRuntimeRoot) {
    // This is setup of our fresh synthetic fixture only. No admitted assistant
    // or operation may exist; the production controller must create the root
    // and immutable budgets itself, rather than rewriting fixture limits.
    await db.begin(async (tx) => {
      const rows =
        await tx`select 1 from allrice_assistant_instances where root_run_id=${f.rootRunId}
        union all select 1 from allrice_assistant_messages where root_run_id=${f.rootRunId}
        union all select 1 from allrice_assistant_usage where root_run_id=${f.rootRunId}
        union all select 1 from allrice_runtime_operations where root_run_id=${f.rootRunId}`;
      if (rows.length)
        throw Error('Cannot defer an already admitted synthetic runtime');
      await tx`delete from allrice_runtime_budgets where root_run_id=${f.rootRunId}`;
      await tx`delete from allrice_runtime_run_links where root_run_id=${f.rootRunId}`;
      await tx`delete from allrice_runtime_roots where root_run_id=${f.rootRunId}`;
    });
  }
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
    assistant?: { runId: string; worker: typeof f.worker },
    argumentsInput: unknown = args,
  ) => {
    const origin =
      assistant ?? (child ? { runId: child.runId, worker: f.worker } : null);
    if (!origin) throw Error('Explicit production native child required');
    return createLocalCommandOperation(
      { context, arguments: argumentsInput, callId, assistant: origin },
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
    child,
    args,
    context,
    requestContext: f.context,
    create,
    freshLedger,
    approve,
    approvalFor,
  };
}
