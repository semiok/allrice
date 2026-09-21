import { createHash, randomUUID } from 'node:crypto';
import {
  CloudCommandInputSchema,
  CloudCommandSchema,
  CloudExecutionProfileSchema,
  RuntimeActionBindingSchema,
  RuntimeOperationSnapshotSchema,
  StorageObjectSchema,
  UuidSchema,
  runtimeContractEqual,
  type ExecutionContext,
  type RuntimeActionBinding,
  type RequestContext,
  type StoragePort,
  type StorageObject,
  type CloudCommand,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import {
  requireTenantManagementScope,
  type TenantManagementOptions,
} from './tenant-management-scope.ts';
import { lockWorkspaceStorageQuota } from './core/storage-quota.ts';
import { createRuntimeOperationLedger } from './runtime-ledger/ledger.ts';
import { ensureRuntimeOperationRoot } from './runtime-ledger/root-service.ts';
import {
  cloudExecutionEnabled,
  checkCloudBindingAuthority,
  cloudCommandBinding,
} from './cloud-authority.ts';
import {
  createRuntimePolicyAdmission,
  RuntimePolicyError,
  requestRuntimeActionApproval,
  runtimePolicyDigest as digest,
  type RuntimePolicyPrincipal,
} from './runtime-policy.ts';
import {
  getToolBrokerFile,
  createToolBrokerExportObject,
  registerToolBrokerExport,
} from './execution/tool-broker.ts';

type Database = ReturnType<typeof getDatabase>;
export { cloudExecutionEnabled } from './cloud-authority.ts';
export function cloudStableId(key: string) {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Explicit admin installation, not tool discovery or self-granted model scope. */
export async function installCloudExecutionGrant(
  context: RequestContext,
  input: {
    targetId: string;
    ownerId: string;
    profile: unknown;
    enabled: boolean;
  },
  database: Database = getDatabase(),
  administration?: TenantManagementOptions,
) {
  const profile = CloudExecutionProfileSchema.parse(input.profile),
    id = randomUUID();
  const organizationId =
      administration?.organizationId ?? context.organizationId,
    workspaceId = administration?.workspaceId ?? context.workspaceId;
  return database.begin(async (tx) => {
    if (administration) {
      if (input.ownerId !== administration.subjectId)
        throw new RuntimePolicyError('membership_denied');
      await requireTenantManagementScope(context, administration, tx);
    }
    const [admin] =
      await tx`select m.id from allrice_memberships m join allrice_users u on u.id=m.user_id and u.status='active' where m.organization_id=${context.organizationId} and (m.workspace_id is null or m.workspace_id=${context.workspaceId}) and m.user_id=${context.actor.id} and m.active and m.role='admin' for share of m,u`;
    if (context.actor.type !== 'user' || (!administration && !admin))
      throw new RuntimePolicyError('membership_denied');
    const [target] =
      await tx`select id from allrice_execution_targets where id=${UuidSchema.parse(input.targetId)} and organization_id=${organizationId} and workspace_id=${workspaceId} and kind='cloud_sandbox' and state<>'revoked' and capabilities ? 'process.execute' for share`;
    const [owner] =
      await tx`select id from allrice_memberships where organization_id=${organizationId} and (workspace_id is null or workspace_id=${workspaceId}) and user_id=${UuidSchema.parse(input.ownerId)} and active for share`;
    if (!target || !owner)
      throw new RuntimePolicyError('cloud_grant_unavailable');
    await tx`insert into allrice_cloud_execution_grants(id,organization_id,workspace_id,owner_id,target_id,version,profile,enabled) values(${id},${organizationId},${workspaceId},${input.ownerId},${input.targetId},1,${tx.json(profile)},${input.enabled})`;
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata) values(${organizationId},${workspaceId},${context.actor.id},'cloud.grant.installed','execution_target',${input.targetId},'recorded',${administration?.reason ?? 'explicit_admin_grant'},${tx.json({ grantId: id, ownerId: input.ownerId, profileDigest: digest(profile), enabled: input.enabled })})`;
    return { id, version: 1, profile };
  });
}

export function createCloudOperationLedger(
  context: RuntimePolicyPrincipal,
  database: Database = getDatabase(),
) {
  const policyOptions = {
    context,
    resolveCurrentBinding: async ({
      transaction,
      binding,
    }: {
      transaction: Parameters<typeof checkCloudBindingAuthority>[0];
      binding: RuntimeActionBinding;
    }) =>
      (await checkCloudBindingAuthority(transaction, context, binding)).binding,
  };
  const policy = createRuntimePolicyAdmission(policyOptions);
  const ledger = createRuntimeOperationLedger({
    database,
    persistLease: async ({ transaction, lease }) => {
      if (lease.snapshot.binding.action !== 'cloud.process.execute')
        throw new RuntimePolicyError('resource_adapter_not_registered');
      await transaction`insert into allrice_cloud_execution_attempts(operation_id,lease_token) values(${lease.snapshot.binding.attempt.operationId},${lease.leaseToken})`;
    },
    admission: async (input) => {
      if (input.phase === 'dispatch') {
        await input.transaction`select pg_advisory_xact_lock(20260908,15)`;
        const { profile } = await checkCloudBindingAuthority(
          input.transaction,
          context,
          input.binding,
        );
        const [count] = await input.transaction<
          { n: string; own: string }[]
        >`select count(*)::text as n,count(*) filter(where o.snapshot->'binding'->'execution'->>'grantId'=${input.binding.execution.grantId})::text as own from allrice_runtime_operations o left join allrice_cloud_execution_attempts a on a.operation_id=o.id where o.snapshot->'binding'->>'action'='cloud.process.execute' and o.id<>${input.binding.attempt.operationId} and a.cleanup_confirmed_at is null and (o.snapshot->>'status' in ('dispatched','running','cancel_requested','unknown') or a.container_id is not null)`;
        if (
          Number(count?.n ?? 0) >= 2 ||
          Number(count?.own ?? 0) >= profile.maximumConcurrency
        )
          throw new RuntimePolicyError('cloud_capacity_unavailable');
      }
      return policy(input);
    },
  });
  return Object.assign(ledger, { policyOptions });
}

/** Trusted Worker ingress. Browser/model input cannot choose target/image/grant/budget. */
export async function createCloudCommandOperation(
  input: { context: ExecutionContext; arguments: unknown; callId: string },
  database: Database = getDatabase(),
) {
  if (!cloudExecutionEnabled())
    throw new RuntimePolicyError('runtime_policy_disabled');
  const args = CloudCommandInputSchema.parse(input.arguments),
    ctx = input.context,
    owner = ctx.policySnapshot.subjectId;
  if (!input.callId || input.callId.length > 255 || !ctx.workspaceId)
    throw new RuntimePolicyError('invalid_tool_call');
  const [run] = await database<
    {
      execution_spec: unknown;
      policy_snapshot_id: string;
      payload: unknown;
      session_id: string;
      employee_version_id: string;
      thread_generation: number;
      timeout_at: Date;
      lease_token: string;
    }[]
  >`select r.execution_spec,r.policy_snapshot_id,p.payload,e.session_id,e.employee_version_id,c.thread_generation,j.timeout_at,j.lease_token::text from allrice_runs r join allrice_employee_runs e on e.run_id=r.id and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id join allrice_jobs j on j.run_id=r.id and j.id=${ctx.jobId} and j.organization_id=r.organization_id and j.workspace_id=r.workspace_id and j.owner_id=r.owner_id join allrice_policy_snapshots p on p.id=r.policy_snapshot_id and p.organization_id=r.organization_id and p.subject_id=r.owner_id join allrice_conversation_runtimes c on c.session_id=e.session_id and c.organization_id=r.organization_id and c.workspace_id=r.workspace_id and c.owner_id=r.owner_id and c.active_run_id=r.id and c.state='running' where r.id=${ctx.runId} and r.organization_id=${ctx.organizationId} and r.workspace_id=${ctx.workspaceId} and r.owner_id=${owner} and r.state='running' and j.status='running' and j.worker_id=${ctx.worker.id} and j.lease_expires_at>clock_timestamp() and j.cancel_requested_at is null and j.timeout_at>clock_timestamp()`;
  if (!run || run.policy_snapshot_id !== ctx.policySnapshot.id)
    throw new RuntimePolicyError('run_or_frozen_configuration_changed');
  const [grant] = await database<
    { id: string; version: number; target_id: string; profile: unknown }[]
  >`select g.id,g.version,g.target_id,g.profile from allrice_cloud_execution_grants g join allrice_execution_targets t on t.id=g.target_id and t.organization_id=g.organization_id and t.workspace_id=g.workspace_id where g.organization_id=${ctx.organizationId} and g.workspace_id=${ctx.workspaceId} and g.owner_id=${owner} and g.enabled and g.revoked_at is null and t.state='online' and t.kind='cloud_sandbox' order by g.created_at desc limit 1`;
  if (!grant) throw new RuntimePolicyError('cloud_runner_unavailable');
  const profile = CloudExecutionProfileSchema.parse(grant.profile),
    payload = CloudCommandSchema.parse({
      capability: 'cloud.process.execute',
      arguments: args,
      backend: profile.backend,
      imageDigest: profile.imageDigest,
      runtime: profile.runtime,
      network: 'none',
    });
  // Frozen resource:read permission and current ready/owner scope; exact transfer
  // itself additionally requires the approval binding's dataScope below.
  for (const file of args.inputs) {
    const authorized = await getToolBrokerFile(ctx, file.objectId);
    if (authorized.object.checksum !== file.checksum)
      throw new RuntimePolicyError('cloud_input_changed');
  }
  const key = `cloud-command:${ctx.runId}:${input.callId}`,
    operationId = cloudStableId(key);
  const content = args.inputs.map((f) => ({
    kind: 'storage_object' as const,
    id: f.objectId,
    checksum: f.checksum,
  }));
  const binding = RuntimeActionBindingSchema.parse({
    task: {
      scope: {
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        projectId: null,
      },
      chatSessionId: run.session_id,
      runId: ctx.runId,
      rootRunId: ctx.runId,
      parentRunId: null,
      frozenConfiguration: {
        employeeVersionId: run.employee_version_id,
        digest: digest(run.execution_spec),
      },
    },
    attempt: {
      operationId,
      attemptId: cloudStableId(`${key}:attempt`),
      attemptNumber: 1,
      generation: run.thread_generation,
      fence: 1,
    },
    requestedBy: { type: 'user', id: owner },
    policy: { snapshotId: run.policy_snapshot_id, digest: digest(run.payload) },
    execution: {
      targetId: grant.target_id,
      targetKind: 'cloud_sandbox',
      deviceId: null,
      grantId: grant.id,
      grantVersion: grant.version,
      scopeDigest: digest(profile),
      workCopy: { id: operationId, kind: 'cloud_copy' },
    },
    action: payload.capability,
    inputDigest: digest(payload),
    command: cloudCommandBinding(payload),
    baseline: content,
    dataScope: content.map((c) => ({
      content: c,
      sourceTargetId: null,
      purpose: 'execution_input',
      destination: 'cloud_execution',
      authorizationId: operationId,
      authorizationVersion: 1,
    })),
  });
  await database`insert into allrice_cloud_execution_inputs(operation_id,organization_id,workspace_id,owner_id,run_id,grant_id,job_id,worker_id,job_lease_token,binding,payload) values(${operationId},${ctx.organizationId},${ctx.workspaceId},${owner},${ctx.runId},${grant.id},${ctx.jobId},${ctx.worker.id},${run.lease_token},${database.json(binding)},${database.json(payload)}) on conflict(operation_id) do nothing`;
  const [stored] = await database<
    {
      binding: unknown;
      payload: unknown;
      job_id: string;
      worker_id: string;
      job_lease_token: string;
    }[]
  >`select binding,payload,job_id,worker_id,job_lease_token::text from allrice_cloud_execution_inputs where operation_id=${operationId}`;
  if (
    !runtimeContractEqual(stored?.binding, binding) ||
    !runtimeContractEqual(stored?.payload, payload) ||
    stored?.job_id !== ctx.jobId ||
    stored?.worker_id !== ctx.worker.id ||
    stored?.job_lease_token !== run.lease_token
  )
    throw new RuntimePolicyError('idempotency_conflict');
  const principal = {
    actor: { type: 'user' as const, id: owner },
    organizationId: ctx.organizationId,
    workspaceId: ctx.workspaceId,
    requestId: randomUUID(),
  };
  const ledger = createCloudOperationLedger(principal, database);
  const budgets = await ensureRuntimeOperationRoot(
    ledger,
    binding.task,
    run.timeout_at.toISOString(),
    database,
  );
  const snapshot = await ledger.createOperation({
    snapshot: RuntimeOperationSnapshotSchema.parse({
      contractVersion: 1,
      binding,
      stepId: null,
      agentInstanceId: null,
      processId: null,
      cancelRequestId: null,
      idempotencyKey: cloudStableId(`${key}:delivery`),
      status: 'planned',
      result: null,
    }),
    reservations: budgets.map((b) => ({
      metric: b.metric,
      accountingId: cloudStableId(`${key}:meter:${b.metric}`),
      amount:
        b.metric === 'tool_calls'
          ? 1
          : b.metric === 'wall_time'
            ? args.limits.timeoutMs
            : b.metric === 'output_bytes'
              ? args.limits.artifactBytes + args.limits.outputBytes
              : 0,
    })),
  });
  if (snapshot.status === 'waiting_user')
    await requestRuntimeActionApproval(
      ledger.policyOptions,
      binding,
      600_000,
      database,
    );
  return {
    snapshot,
    payload,
    ledger,
    principal,
    deadlineAt: run.timeout_at.toISOString(),
    context: ctx,
    jobLeaseToken: run.lease_token,
  };
}

export async function loadCloudCommandInputs(
  context: ExecutionContext,
  payload: CloudCommand,
  storage: StoragePort,
) {
  const files: { path: string; contentBase64: string }[] = [];
  let total = 0;
  for (const input of payload.arguments.inputs) {
    const file = await getToolBrokerFile(context, input.objectId);
    const reader = (await storage.get(file.object)).getReader();
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const c = await reader.read();
        if (c.done) break;
        total += c.value.length;
        if (total > 2_000_000) {
          await reader.cancel();
          throw new RuntimePolicyError('cloud_input_limit');
        }
        chunks.push(c.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks);
    if (
      `sha256:${createHash('sha256').update(bytes).digest('hex')}` !==
      input.checksum
    )
      throw new RuntimePolicyError('cloud_input_changed');
    files.push({ path: input.path, contentBase64: bytes.toString('base64') });
  }
  return files;
}

/** Publish only a server-recorded, physically stopped successful attempt. Output
 * is tenant-controlled data; it never becomes executable same-origin content. */
export async function publishCloudOperationArtifacts(
  input: {
    context: ExecutionContext;
    binding: RuntimeActionBinding;
    payload: CloudCommand;
    artifacts: { path: string; contentBase64: string }[];
  },
  storage: StoragePort,
  database: Database = getDatabase(),
) {
  const { context: ctx, binding, payload } = input;
  return database.begin(async (tx) => {
    await lockWorkspaceStorageQuota(tx, ctx.organizationId, ctx.workspaceId);
    const [root] =
      await tx`select root_run_id from allrice_runtime_roots where root_run_id=${binding.task.rootRunId} and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId} and cancel_request_id is null and deadline_at>clock_timestamp() for update`;
    if (!root) throw new RuntimePolicyError('cloud_publication_revoked');
    const [attempt] = await tx<
      {
        outcome: {
          reason: string;
          stopped: boolean;
          artifacts: unknown;
        } | null;
        artifacts: unknown;
      }[]
    >`select outcome,artifacts from allrice_cloud_execution_attempts where operation_id=${binding.attempt.operationId} for update`;
    if (
      !attempt?.outcome?.stopped ||
      attempt.outcome.reason !== 'completed' ||
      !runtimeContractEqual(attempt.outcome.artifacts, input.artifacts)
    )
      throw new RuntimePolicyError('cloud_result_unconfirmed');
    const existing = attempt.artifacts as {
      object: StorageObject;
      fileName: string;
      versionId: string;
    }[];
    if (existing.length) return existing;
    const principal = {
      actor: { type: 'user' as const, id: ctx.policySnapshot.subjectId },
      organizationId: ctx.organizationId,
      workspaceId: ctx.workspaceId,
      requestId: randomUUID(),
    };
    const assertAdmission = createRuntimePolicyAdmission({
      context: principal,
      resolveCurrentBinding: async ({ transaction, binding: current }) =>
        (await checkCloudBindingAuthority(transaction, principal, current))
          .binding,
    });
    await assertAdmission({
      transaction: tx,
      binding,
      phase: 'heartbeat',
      now: new Date(),
    });
    const published: {
      object: StorageObject;
      fileName: string;
      versionId: string;
    }[] = [];
    for (const output of payload.arguments.outputs) {
      const artifact = input.artifacts.find((a) => a.path === output.path);
      if (!artifact) throw new RuntimePolicyError('cloud_artifact_missing');
      const bytes = Buffer.from(artifact.contentBase64, 'base64');
      if (bytes.length > payload.arguments.limits.artifactBytes)
        throw new RuntimePolicyError('cloud_artifact_limit');
      const object = StorageObjectSchema.parse({
        ...createToolBrokerExportObject({
          context: ctx,
          mediaType:
            output.format === 'json'
              ? 'application/json'
              : output.format === 'csv'
                ? 'text/csv'
                : 'text/plain',
          sizeBytes: bytes.length,
          checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        }),
        id: cloudStableId(
          `${binding.attempt.operationId}:artifact:${output.path}`,
        ),
        immutable: true,
      });
      // Deterministic IDs/keys make crash retries content-identical, no duplicate versions.
      object.key = object.key.replace(
        /[^/]+$/,
        object.id,
      ) as StorageObject['key'];
      await storage.put(object, new Blob([bytes]).stream());
      const version = await registerToolBrokerExport(
        {
          context: ctx,
          sessionId: binding.task.chatSessionId!,
          fileName: output.fileName,
          format: output.format === 'json' ? 'json' : 'text',
          object,
        },
        tx,
      );
      await tx`insert into allrice_workbench_artifacts(version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,execution,request_id,request_digest) values(${version.id},${ctx.organizationId},${ctx.workspaceId},${ctx.policySnapshot.subjectId},${ctx.runId},'file',${tx.json({ kind: 'tool_result', runId: ctx.runId, operationId: binding.attempt.operationId, stepId: null })},${tx.json(binding.execution)},${`cloud:${binding.attempt.operationId}:${output.path}`},${digest({ objectId: object.id, checksum: object.checksum })})`;
      published.push({
        object,
        fileName: output.fileName,
        versionId: version.id,
      });
    }
    // Storage I/O can cross an approval/job/root deadline. Locks prevent a
    // concurrent revocation update, but wall-clock validity must be rechecked.
    await assertAdmission({
      transaction: tx,
      binding,
      phase: 'heartbeat',
      now: new Date(),
    });
    const [stillCurrent] =
      await tx`select root_run_id from allrice_runtime_roots where root_run_id=${binding.task.rootRunId} and cancel_request_id is null and deadline_at>clock_timestamp()`;
    if (!stillCurrent)
      throw new RuntimePolicyError('cloud_publication_revoked');
    await tx`update allrice_cloud_execution_attempts set artifacts=${tx.json(published)} where operation_id=${binding.attempt.operationId}`;
    return published;
  });
}
