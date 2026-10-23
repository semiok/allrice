import {
  prepareMethodFileStep,
  methodFileProof,
  methodFileInputs,
  recordMethodFilePublication,
} from './employees/employee-method-file-runtime.ts';
import { isCompiledRepositoryExecution } from './platform-repair-contracts.ts';
import { cloudInputTransferScopes } from './cloud-network-authority.ts';
import { initializeProjectServiceLease } from './project-services.ts';
import { isPlatformAdmin } from './platform-authority.ts';
import {
  assertProjectOutputParent,
  assertExplicitOutputParent,
} from './project-output-parent.ts';
import { createHash, randomUUID } from 'node:crypto';
import { linkTaskOperationCall } from './task-clock.ts';
import {
  cloudPlatform,
  CloudCommandInputSchema,
  SandboxExecutionPolicySchema,
  sandboxExecutionBudgetSpec,
  EmployeeMethodFileStepSchema,
  CloudCommandSchema,
  CloudExecutionPayloadSchema,
  CloudProjectCommandSchema,
  CloudProjectRunResultSchema,
  ProjectRunnableInputSchema,
  RuntimeSavedProjectSourceSchema,
  projectRuntimeCacheIdentity,
  cloudPythonImageV1,
  cloudToolchainImageV1,
  cloudProjectResultMatchesPayload,
  ProjectCollectedArtifactsSchema,
  projectArtifactLimits,
  type CloudExecutionPayload,
  type RuntimeContentRef,
  PythonExecuteArgsSchema,
  CloudExecutionProfileSchema,
  cloudRuntimeImage,
  RuntimeActionBindingSchema,
  RuntimeOperationSnapshotSchema,
  StorageObjectSchema,
  UuidSchema,
  runtimeContractEqual,
  localFileMediaType,
  type ExecutionContext,
  type RuntimeActionBinding,
  type RequestContext,
  type StoragePort,
  type RuntimeInputSource,
  type StorageObject,
  type CloudCommand,
  type CloudPythonOrigin,
  type CloudProjectResolutionOrigin,
  ProjectDependencyResolveInputSchema,
  projectResolutionCloudArguments,
  projectResolutionReceiptSummary,
  ProjectDependencyResolutionReceiptSchema,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import {
  validatePngArtifact,
  type PngArtifactValidation,
} from '@allrice/storage';
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
  normalizeCloudPythonArguments,
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

import {
  assertSavedProjectAuthority,
  readProjectSource,
  isProjectSourceAuthorityError,
} from './saved-project-authority.ts';
import { type ProjectExecutionSelection } from './project-execution.ts';
import {
  resolvePlatformRepositoryExecutionProof,
  resolvePlatformRepositoryExecutionProofTx,
} from './platform-repair-verification.ts';

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
    if (!administration) {
      const [member] = await tx`select m.id from allrice_memberships m
        join allrice_organizations o on o.id=m.organization_id and o.archived_at is null
        join allrice_workspaces w on w.organization_id=o.id and w.id=${workspaceId} and w.archived_at is null
        where m.organization_id=${organizationId} and m.user_id=${context.actor.id} and m.active
          and m.role in ('admin','member') and (m.workspace_id is null or m.workspace_id=w.id) for share of m,o,w`;
      if (!member || !(await isPlatformAdmin(context, tx)))
        throw new RuntimePolicyError('membership_denied');
    }
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
  Object.assign(policyOptions, {
    assertFinalBinding: async ({
      transaction,
      binding,
    }: {
      transaction: Parameters<typeof checkCloudBindingAuthority>[0];
      binding: RuntimeActionBinding;
    }) => {
      await checkCloudBindingAuthority(transaction, context, binding);
    },
  });
  const policy = createRuntimePolicyAdmission(policyOptions);
  const ledger = createRuntimeOperationLedger({
    database,
    assertCreateReplayAuthority: async ({ transaction, binding }) => {
      const [stored] =
        await transaction`select payload from allrice_cloud_execution_inputs where operation_id=${binding.attempt.operationId}`;
      const [method] =
        await transaction`select id from allrice_runs where id=${binding.task.runId} and execution_spec ? 'employeeMethodSnapshotDigest'`;
      if (
        stored?.payload?.kind === 'project' ||
        stored?.payload?.origin?.toolName === 'workspace.project' ||
        method
      )
        await checkCloudBindingAuthority(transaction, context, binding);
    },
    assertReceiptEvidence: async ({ transaction, binding, receipt }) => {
      const [stored] =
        await transaction`select i.payload,a.outcome,a.artifacts from allrice_cloud_execution_inputs i
        left join allrice_cloud_execution_attempts a on a.operation_id=i.operation_id where i.operation_id=${binding.attempt.operationId}`;
      if (
        stored?.payload?.origin?.toolName === 'workspace.project' &&
        ['operation.outcome', 'operation.stopped'].includes(receipt.signal.type)
      ) {
        const result = stored.outcome;
        const typed = ProjectDependencyResolutionReceiptSchema.safeParse(
          result?.resolution,
        );
        const evidence = receipt.evidence as Record<string, unknown> | null;
        const success =
          receipt.signal.type === 'operation.outcome' &&
          receipt.signal.result.status === 'succeeded';
        const effects =
          receipt.signal.type === 'operation.outcome'
            ? receipt.signal.result.effects
            : receipt.signal.type === 'operation.stopped'
              ? receipt.signal.effects
              : 'none';
        if (
          !result?.stopped ||
          effects !== 'none' ||
          !runtimeContractEqual(evidence?.artifacts, []) ||
          evidence?.reason !== result.reason ||
          evidence?.exitCode !== result.exitCode ||
          evidence?.stopped !== true ||
          evidence?.errorCode !== result.errorCode ||
          !runtimeContractEqual(
            evidence?.resolution,
            typed.success
              ? projectResolutionReceiptSummary(typed.data)
              : undefined,
          ) ||
          (result.resolution &&
            (!typed.success || typed.data.exitCode !== result.exitCode)) ||
          (success &&
            (result.reason !== 'completed' ||
              result.exitCode !== 0 ||
              !typed.success ||
              typed.data.status !== 'resolved'))
        )
          throw new RuntimePolicyError('cloud_resolution_receipt_changed');
        return;
      }
      if (
        stored?.payload?.kind !== 'project' ||
        !['operation.outcome', 'operation.stopped'].includes(
          receipt.signal.type,
        )
      )
        return;
      const payload = CloudProjectCommandSchema.parse(stored.payload);
      const result = CloudProjectRunResultSchema.safeParse(stored.outcome);
      const evidence = receipt.evidence as {
        projectPreparation?: unknown;
        imageDigest?: unknown;
        stopped?: unknown;
        reason?: unknown;
        exitCode?: unknown;
        serviceStopReason?: unknown;
        artifacts?: unknown;
        network?: unknown;
        executionBudget?: unknown;
      } | null;
      const success =
        receipt.signal.type === 'operation.outcome' &&
        receipt.signal.result.status === 'succeeded';
      const effects =
        receipt.signal.type === 'operation.outcome'
          ? receipt.signal.result.effects
          : receipt.signal.type === 'operation.stopped'
            ? receipt.signal.effects
            : 'none';
      const published = stored.artifacts as {
        object: StorageObject;
        versionId: string;
        fileName: string;
      }[];
      const delivered = published.map((a) => ({
        objectId: a.object.id,
        versionId: a.versionId,
        fileName: a.fileName,
        checksum: a.object.checksum,
      }));
      if (
        effects !== (success && published.length ? 'applied' : 'none') ||
        !runtimeContractEqual(evidence?.artifacts, delivered) ||
        (success &&
          published.length !== (payload.arguments.outputs?.length ?? 0)) ||
        !result.success ||
        !cloudProjectResultMatchesPayload(payload, result.data) ||
        !runtimeContractEqual(
          evidence?.projectPreparation,
          result.data.projectPreparation,
        ) ||
        evidence?.imageDigest !== result.data.imageDigest ||
        evidence?.stopped !== true ||
        evidence?.reason !== result.data.reason ||
        evidence?.exitCode !== result.data.exitCode ||
        evidence?.serviceStopReason !== result.data.serviceStopReason ||
        !runtimeContractEqual(evidence?.network, result.data.network) ||
        !runtimeContractEqual(
          evidence?.executionBudget,
          result.data.executionBudget,
        ) ||
        (success &&
          (result.data.reason !== 'completed' || result.data.exitCode !== 0))
      )
        throw new RuntimePolicyError('cloud_project_receipt_changed');
    },
    persistLease: async ({ transaction, lease }) => {
      if (lease.snapshot.binding.action !== 'cloud.process.execute')
        throw new RuntimePolicyError('resource_adapter_not_registered');
      await transaction`insert into allrice_cloud_execution_attempts(operation_id,lease_token) values(${lease.snapshot.binding.attempt.operationId},${lease.leaseToken})`;
      const [input] =
        await transaction`select payload from allrice_cloud_execution_inputs where operation_id=${lease.snapshot.binding.attempt.operationId}`;
      if (input?.payload?.kind === 'project')
        await initializeProjectServiceLease(
          transaction,
          lease.snapshot,
          CloudProjectCommandSchema.parse(input.payload),
        );
    },
    resolveSandboxExecutionBudget: async ({ transaction, binding }) => {
      const [stored] =
        await transaction`select payload from allrice_cloud_execution_inputs where operation_id=${binding.attempt.operationId}`;
      const payload = CloudExecutionPayloadSchema.parse(stored?.payload);
      if (!payload.executionBudget)
        throw new RuntimePolicyError('sandbox_execution_not_enabled');
      return payload.executionBudget;
    },
    admission: async (input) => {
      // Physical capacity is acquired in the shared Office/cloud executor.
      // Holding a global admission lock here cannot account for Office slots
      // and turns normal resource waiting into an operation failure.
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
  return createCloudOperation(input, database);
}

/** Canonical managed resolver. No model supplied script/resource profile is
 * accepted; the ordinary scoped cloud grant and frozen tools still authorize it. */
export async function createCloudProjectResolutionOperation(
  input: { context: ExecutionContext; arguments: unknown; callId: string },
  database: Database = getDatabase(),
) {
  const request = ProjectDependencyResolveInputSchema.parse(input.arguments);
  const originalArguments = JSON.parse(
    JSON.stringify(input.arguments),
  ) as Record<string, unknown>;
  return createCloudOperation(
    { ...input, arguments: projectResolutionCloudArguments(request) },
    database,
    {
      origin: {
        toolName: 'workspace.project',
        callId: input.callId,
        purpose: 'project_dependency_resolution',
        argumentsDigest: digest(originalArguments),
        request,
      },
      originalArguments,
    },
  );
}

/** Preserve the canonical call; managed-local authorization is not cloud authority. */
export async function createCloudPythonOperation(
  input: { context: ExecutionContext; arguments: unknown; callId: string },
  database: Database = getDatabase(),
) {
  PythonExecuteArgsSchema.parse(input.arguments);
  const originalArguments = JSON.parse(
    JSON.stringify(input.arguments),
  ) as Record<string, unknown>;
  const origin: CloudPythonOrigin = {
    toolName: 'python.execute',
    callId: input.callId,
    purpose: 'python_charts',
    argumentsDigest: digest(originalArguments),
  };
  const [selection] = await database<
    {
      metadata: {
        requestDigest: string;
        choice: { location: string; status: string };
        localInputs: boolean;
      };
    }[]
  >`
    select metadata from allrice_audit_events where organization_id=${input.context.organizationId} and workspace_id=${input.context.workspaceId}
      and actor_id=${input.context.policySnapshot.subjectId} and action='execution.location' and resource_type='managed_python'
      and resource_id=${cloudStableId(`managed-python:${input.context.runId}:${input.callId}`)} order by occurred_at limit 1`;
  if (
    selection?.metadata.requestDigest !==
      digest({
        toolName: 'python.execute',
        arguments: originalArguments,
        purpose: 'python_charts',
      }) ||
    selection.metadata.choice.location !== 'cloud' ||
    selection.metadata.choice.status !== 'execute' ||
    selection.metadata.localInputs
  )
    throw new RuntimePolicyError('cloud_input_changed');
  return createCloudOperation(
    { ...input, arguments: normalizeCloudPythonArguments(originalArguments) },
    database,
    { origin, originalArguments },
  );
}

/** Saved-source cloud ingress: the selected target and original Worker are mandatory. */
export async function createCloudProjectOperation(
  input: {
    context: ExecutionContext;
    callId: string;
    projectSelection: ProjectExecutionSelection;
    worker: { attempt: number; leaseToken: string };
    storage: StoragePort;
  },
  database: Database = getDatabase(),
) {
  const ctx = input.context,
    selected = input.projectSelection;
  const args = ProjectRunnableInputSchema.parse(selected.originalArguments);
  if (
    !cloudExecutionEnabled() ||
    !ctx.workspaceId ||
    selected.choice.location !== 'cloud' ||
    selected.choice.status !== 'execute' ||
    selected.callId !== input.callId ||
    selected.runId !== ctx.runId ||
    selected.workerOrigin.attempt !== input.worker.attempt ||
    selected.workerOrigin.leaseTokenDigest !==
      createHash('sha256').update(input.worker.leaseToken).digest('hex')
  )
    throw new RuntimePolicyError('project_execution_origin_changed');
  const key = `cloud-project:${ctx.runId}:${input.callId}`,
    operationId = cloudStableId(key);
  if (selected.operationId !== operationId)
    throw new RuntimePolicyError('project_execution_origin_changed');
  const prepared = await database
    .begin(async (tx) => {
      const [run] = await tx<
        {
          session_id: string;
          employee_version_id: string;
          execution_spec: unknown;
          execution_snapshot: { sandboxExecutionPolicy?: unknown };
          policy_snapshot_id: string;
          payload: unknown;
          thread_generation: number;
          timeout_at: Date;
          lease_token: string;
        }[]
      >`
      select e.session_id,e.employee_version_id,e.execution_snapshot,r.execution_spec,r.policy_snapshot_id,p.payload,c.thread_generation,j.timeout_at,j.lease_token::text
      from allrice_runs r join allrice_employee_runs e on e.run_id=r.id and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id
      join allrice_jobs j on j.id=${ctx.jobId} and j.run_id=r.id and j.organization_id=r.organization_id and j.workspace_id=r.workspace_id and j.owner_id=r.owner_id
      join allrice_policy_snapshots p on p.id=r.policy_snapshot_id and p.organization_id=r.organization_id and p.subject_id=r.owner_id
      join allrice_conversation_runtimes c on c.session_id=e.session_id and c.organization_id=r.organization_id and c.workspace_id=r.workspace_id and c.owner_id=r.owner_id and c.active_run_id=r.id and c.state='running'
      where r.id=${ctx.runId} and r.organization_id=${ctx.organizationId} and r.workspace_id=${ctx.workspaceId} and r.owner_id=${ctx.policySnapshot.subjectId}
        and r.state='running' and r.policy_snapshot_id=${ctx.policySnapshot.id} and j.worker_id=${ctx.worker.id} and j.attempt=${input.worker.attempt}
        and j.lease_token=${input.worker.leaseToken} and j.status='running' and j.lease_expires_at>clock_timestamp()
        and j.timeout_at>clock_timestamp() and j.cancel_requested_at is null for share of j,r,e,c,p`;
      if (!run || run.session_id !== selected.sessionId)
        throw new RuntimePolicyError('cloud_worker_lease_changed');
      if (args.action === 'execute' && args.execution) {
        if (process.env.ALLRICE_SANDBOX_EXECUTION_V1_ENABLED !== '1')
          throw new RuntimePolicyError('sandbox_execution_not_enabled');
        if (
          !SandboxExecutionPolicySchema.safeParse(
            run.execution_snapshot?.sandboxExecutionPolicy,
          ).success
        )
          throw new RuntimePolicyError('sandbox_execution_upgrade_required');
      }
      const [grant] = await tx<
        { id: string; version: number; target_id: string; profile: unknown }[]
      >`
      select g.id,g.version,g.target_id,g.profile from allrice_cloud_execution_grants g
        join allrice_execution_targets t on t.id=g.target_id and t.organization_id=g.organization_id and t.workspace_id=g.workspace_id
      where g.id=${selected.grantId} and g.target_id=${selected.targetId} and g.organization_id=${ctx.organizationId}
        and g.workspace_id=${ctx.workspaceId} and g.owner_id=${ctx.policySnapshot.subjectId} and g.enabled and g.revoked_at is null
        and t.kind='cloud_sandbox' and t.state='online'
        and (t.metadata->>'healthManaged' is distinct from 'true' or t.last_heartbeat_at between clock_timestamp()-interval '120 seconds' and clock_timestamp())
      for share of g,t`;
      if (!grant) throw new RuntimePolicyError('cloud_grant_unavailable');
      const profile = CloudExecutionProfileSchema.parse(grant.profile);
      if (digest(profile) !== selected.profileDigest)
        throw new RuntimePolicyError('cloud_profile_changed');
      const source = await readProjectSource(
        tx,
        ctx,
        args.project.snapshot,
        input.storage,
      );
      await assertSavedProjectAuthority(
        tx,
        ctx,
        run.session_id,
        selected.workerOrigin,
        args.project,
        'cloud.process.execute',
      );
      const spec = args.projectPreparation;
      if (
        source.document.projectId !== args.project.projectId ||
        source.document.sourceDigest !== spec.sourceDigest ||
        source.document.files.find((f) => f.path === spec.lockPath)?.sha256 !==
          spec.lockChecksum
      )
        throw new RuntimePolicyError('cloud_input_changed');
      const imageDigest =
        spec.manager === 'uv' ? cloudPythonImageV1 : cloudToolchainImageV1;
      const projectSource = RuntimeSavedProjectSourceSchema.parse({
        version: 1,
        project: args.project,
        snapshot: source.document,
        architecture: cloudPlatform.architecture,
        origin: selected.workerOrigin,
        executionOrigin: {
          toolName: 'workspace.project',
          callId: input.callId,
          argumentsDigest: selected.argumentsDigest,
          selectionId: selected.selectionId,
        },
        cacheKey:
          'sha256:' +
          createHash('sha256')
            .update(
              JSON.stringify(
                projectRuntimeCacheIdentity({
                  spec,
                  scope: {
                    organizationId: ctx.organizationId,
                    workspaceId: ctx.workspaceId!,
                    ownerId: ctx.policySnapshot.subjectId,
                  },
                  image: imageDigest,
                  architecture: cloudPlatform.architecture,
                }),
              ),
            )
            .digest('hex'),
      });
      const commandArgs = {
        executable: args.executable,
        ...(args.action === 'execute' && args.network
          ? { network: args.network }
          : {}),
        ...(args.action === 'execute' && args.execution
          ? { execution: args.execution }
          : {}),
        args: args.args,
        path: args.path,
        projectPreparation: args.projectPreparation,
        ...('outputs' in args && args.outputs ? { outputs: args.outputs } : {}),
        ...(args.action === 'service_start'
          ? {
              background: {
                durationMs: 3_600_000,
                readiness: {
                  kind: 'http',
                  port: args.service.port,
                  path: args.service.path,
                  timeoutMs: args.service.readinessTimeoutMs,
                },
                stdin: {
                  mode: 'none',
                  maxRequests: 1,
                  maxBytes: 1,
                  requestTimeoutMs: 1000,
                },
                projectService: args.service,
              },
            }
          : {}),
        limits: args.limits,
      };
      const payload = CloudProjectCommandSchema.parse({
        kind: 'project',
        capability: 'cloud.process.execute',
        arguments: {
          ...commandArgs,
          projectSource,
          files: source.document.files.map(({ path, sha256 }) => ({
            path,
            sha256,
          })),
          imageDigest,
        },
        imageDigest,
        backend: profile.backend,
        runtime: profile.runtime,
        network: args.action === 'execute' ? (args.network ?? 'none') : 'none',
        ...(args.action === 'execute' && args.execution
          ? {
              executionBudget: sandboxExecutionBudgetSpec(
                args.execution,
                SandboxExecutionPolicySchema.parse(
                  run.execution_snapshot?.sandboxExecutionPolicy,
                ),
              ),
            }
          : {}),
      });
      // Canonical origin is checked again under ledger locks, not only at this preparation read.
      return { run, grant, profile, payload };
    })
    .catch((error: unknown) => {
      if (isProjectSourceAuthorityError(error))
        throw new RuntimePolicyError('cloud_input_not_authorized');
      throw error;
    });
  return finishCloudOperation({
    input,
    database,
    ...prepared,
    key,
    operationId,
    content: [args.project.snapshot],
    originalArguments: args as unknown as Record<string, unknown>,
    workerAttempt: input.worker.attempt,
  });
}

async function createCloudOperation(
  input: { context: ExecutionContext; arguments: unknown; callId: string },
  database: Database,
  canonical?: {
    origin: CloudPythonOrigin | CloudProjectResolutionOrigin;
    originalArguments: Record<string, unknown>;
  },
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
      execution_snapshot: { sandboxExecutionPolicy?: unknown };
      policy_snapshot_id: string;
      payload: unknown;
      session_id: string;
      employee_version_id: string;
      thread_generation: number;
      timeout_at: Date;
      lease_token: string;
    }[]
  >`select r.execution_spec,e.execution_snapshot,r.policy_snapshot_id,p.payload,e.session_id,e.employee_version_id,c.thread_generation,j.timeout_at,j.lease_token::text from allrice_runs r join allrice_employee_runs e on e.run_id=r.id and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id join allrice_jobs j on j.run_id=r.id and j.id=${ctx.jobId} and j.organization_id=r.organization_id and j.workspace_id=r.workspace_id and j.owner_id=r.owner_id join allrice_policy_snapshots p on p.id=r.policy_snapshot_id and p.organization_id=r.organization_id and p.subject_id=r.owner_id join allrice_conversation_runtimes c on c.session_id=e.session_id and c.organization_id=r.organization_id and c.workspace_id=r.workspace_id and c.owner_id=r.owner_id and c.active_run_id=r.id and c.state='running' where r.id=${ctx.runId} and r.organization_id=${ctx.organizationId} and r.workspace_id=${ctx.workspaceId} and r.owner_id=${owner} and r.state='running' and j.status='running' and j.worker_id=${ctx.worker.id} and j.lease_expires_at>clock_timestamp() and j.cancel_requested_at is null and j.timeout_at>clock_timestamp()`;
  if (!run || run.policy_snapshot_id !== ctx.policySnapshot.id)
    throw new RuntimePolicyError('run_or_frozen_configuration_changed');
  const priorRevision = args.outputs.some((output) => !!output.parentObjectId)
    ? (
        await database`select operation_id from allrice_cloud_execution_inputs where operation_id=${cloudStableId(`${canonical ? 'cloud-python' : 'cloud-command'}:${ctx.runId}:${input.callId}`)} and run_id=${ctx.runId} and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId} and owner_id=${owner}`
      )[0]
    : null;
  for (const output of args.outputs) {
    if (!output.parentObjectId) continue;
    await assertExplicitOutputParent(
      {
        context: ctx,
        sessionId: run.session_id,
        parentObjectId: output.parentObjectId,
        format:
          output.format === 'png'
            ? 'png'
            : output.format === 'json'
              ? 'json'
              : output.format === 'txt' &&
                  localFileMediaType(output.fileName) === 'text/markdown'
                ? 'markdown'
                : 'text',
      },
      database,
      false,
      !priorRevision,
    );
  }
  if (args.execution) {
    if (process.env.ALLRICE_SANDBOX_EXECUTION_V1_ENABLED !== '1')
      throw new RuntimePolicyError('sandbox_execution_not_enabled');
    if (
      !SandboxExecutionPolicySchema.safeParse(
        run.execution_snapshot?.sandboxExecutionPolicy,
      ).success
    )
      throw new RuntimePolicyError('sandbox_execution_upgrade_required');
  }
  const [grant] = await database<
    { id: string; version: number; target_id: string; profile: unknown }[]
  >`select g.id,g.version,g.target_id,g.profile from allrice_cloud_execution_grants g join allrice_execution_targets t on t.id=g.target_id and t.organization_id=g.organization_id and t.workspace_id=g.workspace_id where g.organization_id=${ctx.organizationId} and g.workspace_id=${ctx.workspaceId} and g.owner_id=${owner} and g.enabled and g.revoked_at is null and t.state='online' and t.kind='cloud_sandbox' and (t.metadata->>'healthManaged' is distinct from 'true' or t.last_heartbeat_at between clock_timestamp()-interval '120 seconds' and clock_timestamp()) order by g.created_at desc limit 1`;
  if (!grant) throw new RuntimePolicyError('cloud_runner_unavailable');
  const profile = CloudExecutionProfileSchema.parse(grant.profile),
    payload = CloudCommandSchema.parse({
      capability: 'cloud.process.execute',
      arguments: args,
      backend: profile.backend,
      imageDigest: cloudRuntimeImage(profile.imageDigest, args.language),
      runtime: profile.runtime,
      network: args.network ?? 'none',
      ...(canonical ? { origin: canonical.origin } : {}),
      ...(args.execution
        ? {
            executionBudget: sandboxExecutionBudgetSpec(
              args.execution,
              SandboxExecutionPolicySchema.parse(
                run.execution_snapshot.sandboxExecutionPolicy,
              ),
            ),
          }
        : {}),
    });
  // Frozen resource:read permission and current ready/owner scope; exact transfer
  // itself additionally requires the approval binding's dataScope below.
  for (const file of args.inputs) {
    const authorized = await getToolBrokerFile(ctx, file.objectId);
    if (authorized.object.checksum !== file.checksum)
      throw new RuntimePolicyError('cloud_input_changed');
  }
  const key = `${canonical?.origin.toolName === 'workspace.project' ? 'cloud-project-resolution' : canonical ? 'cloud-python' : 'cloud-command'}:${ctx.runId}:${input.callId}`,
    operationId = cloudStableId(key);
  return finishCloudOperation({
    input,
    database,
    run,
    grant,
    profile,
    payload,
    key,
    operationId,
    content: args.inputs.map((f) => ({
      kind: 'storage_object' as const,
      id: f.objectId,
      checksum: f.checksum,
    })),
    originalArguments: canonical?.originalArguments,
  });
}

/** Private fixed-case entry. No ordinary employee Run or chat identity is
 * fabricated, and no model-selected cloud grant or file scope is accepted. */
export async function createEmployeeMethodFileOperation(
  input: {
    context: ExecutionContext;
    arguments: unknown;
    callId: string;
    leaseToken: string;
    jobAttempt: number;
    storage: StoragePort;
  },
  database: Database = getDatabase(),
) {
  const args = EmployeeMethodFileStepSchema.parse(input.arguments);
  if (!input.callId || input.callId.length > 255)
    throw new RuntimePolicyError('invalid_tool_call');
  const key = `method-file:${input.context.runId}:${args.stage}`;
  const operationId = cloudStableId(key);
  const prepared = await prepareMethodFileStep(
    { ...input, arguments: args, operationId },
    database,
  );
  return finishCloudOperation({
    input,
    database,
    run: {
      ...prepared.run,
      session_id: null,
      employee_version_id: prepared.b.employee_version_id,
      thread_generation: 0,
    },
    grant: prepared.grant,
    profile: prepared.grant.profile,
    payload: prepared.payload,
    key,
    operationId,
    workerAttempt: input.jobAttempt,
    content: prepared.payload.arguments.inputs.map((f) => ({
      kind: 'storage_object' as const,
      id: f.objectId,
      checksum: f.checksum,
    })),
  });
}

async function finishCloudOperation<P extends CloudExecutionPayload>({
  input,
  database,
  run,
  grant,
  profile,
  payload,
  key,
  operationId,
  content,
  originalArguments,
  workerAttempt,
}: {
  input: { context: ExecutionContext; callId: string };
  database: Database;
  run: {
    session_id: string | null;
    employee_version_id: string;
    execution_spec: unknown;
    policy_snapshot_id: string;
    payload: unknown;
    thread_generation: number;
    timeout_at: Date;
    lease_token: string;
  };
  grant: { id: string; version: number; target_id: string };
  profile: unknown;
  payload: P;
  key: string;
  operationId: string;
  content: RuntimeContentRef[];
  originalArguments?: Record<string, unknown>;
  workerAttempt?: number;
}) {
  const ctx = input.context,
    owner = ctx.policySnapshot.subjectId;
  const repositoryProof =
    'kind' in payload
      ? undefined
      : await database.begin((tx) =>
          resolvePlatformRepositoryExecutionProofTx(
            tx,
            {
              organizationId: ctx.organizationId,
              workspaceId: ctx.workspaceId,
              ownerId: owner,
              runId: ctx.runId,
              jobId: ctx.jobId,
              workerId: ctx.worker.id,
              leaseToken: run.lease_token,
              operationId,
            },
            payload,
          ),
        );
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
    command: cloudCommandBinding(payload, repositoryProof),
    baseline: content,
    dataScope: cloudInputTransferScopes(content, operationId, {
      command: payload,
      grantId: grant.id,
      grantVersion: grant.version,
    }),
  });
  await database`insert into allrice_cloud_execution_inputs(operation_id,organization_id,workspace_id,owner_id,run_id,grant_id,job_id,worker_id,job_lease_token,binding,payload,original_arguments) values(${operationId},${ctx.organizationId},${ctx.workspaceId},${owner},${ctx.runId},${grant.id},${ctx.jobId},${ctx.worker.id},${run.lease_token},${database.json(binding)},${database.json(payload)},${originalArguments ? database.json(originalArguments as Parameters<Database['json']>[0]) : null}) on conflict do nothing`;
  const [stored] = await database<
    {
      binding: unknown;
      payload: unknown;
      job_id: string;
      worker_id: string;
      job_lease_token: string;
      original_arguments: unknown | null;
    }[]
  >`select binding,payload,original_arguments,job_id,worker_id,job_lease_token::text from allrice_cloud_execution_inputs where operation_id=${operationId}`;
  if (
    !runtimeContractEqual(stored?.binding, binding) ||
    !runtimeContractEqual(stored?.payload, payload) ||
    !runtimeContractEqual(
      stored?.original_arguments,
      originalArguments ?? null,
    ) ||
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
            ? isCompiledRepositoryExecution(repositoryProof)
              ? repositoryProof.timeoutMs
              : payload.executionBudget
                ? payload.executionBudget.policy.maxExecutionMs
                : payload.arguments.limits.timeoutMs
            : b.metric === 'output_bytes'
              ? ('kind' in payload
                  ? payload.arguments.outputs?.length
                    ? projectArtifactLimits.bytes
                    : 0
                  : payload.arguments.limits.artifactBytes) +
                payload.arguments.limits.outputBytes
              : 0,
    })),
  });
  await linkTaskOperationCall(
    database,
    binding.attempt.operationId,
    input.callId,
  );
  if (snapshot.status === 'waiting_user')
    await requestRuntimeActionApproval(
      ledger.policyOptions,
      binding,
      undefined,
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
    jobAttempt: workerAttempt,
    callId: input.callId,
  };
}

export async function loadCloudCommandInputs(
  context: ExecutionContext,
  payload: CloudCommand,
  storage: StoragePort,
  database: Database = getDatabase(),
) {
  const method = await database.begin(async (tx) => {
    const proof = await methodFileProof(tx, context, payload);
    return proof ? methodFileInputs(tx, proof) : undefined;
  });
  const repositoryProof = await resolvePlatformRepositoryExecutionProof(
    context,
    payload,
    database,
  );
  const files: (
    { path: string; contentBase64: string } | RuntimeInputSource
  )[] = [];
  let total = 0;
  for (const input of payload.arguments.inputs) {
    const file = method?.object
      ? { object: method.object }
      : await getToolBrokerFile(context, input.objectId);
    if (file.object.id !== input.objectId)
      throw new RuntimePolicyError('cloud_input_changed');
    if (!repositoryProof && payload.origin?.toolName !== 'workspace.project') {
      if (file.object.checksum !== input.checksum)
        throw new RuntimePolicyError('cloud_input_changed');
      files.push({
        path: input.path,
        sizeBytes: file.object.sizeBytes,
        checksum: input.checksum,
        async open(signal) {
          signal.throwIfAborted();
          return storage.get(file.object);
        },
      });
      continue;
    }
    const reader = (await storage.get(file.object)).getReader();
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const c = await reader.read();
        if (c.done) break;
        total += c.value.length;
        if (total > (repositoryProof?.inputLimit ?? 2_000_000)) {
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
    payload: CloudExecutionPayload;
    artifacts: {
      path: string;
      contentBase64: string;
      png?: PngArtifactValidation;
    }[];
  },
  storage: StoragePort,
  database: Database = getDatabase(),
) {
  const { context: ctx, binding, payload } = input;
  // Authority checks validate the stored command. Bind the actual publication
  // input too, including lineage, even when returning an existing receipt.
  if (digest(payload) !== binding.inputDigest)
    throw new RuntimePolicyError('cloud_binding_changed');
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

    const [methodRun] =
      await tx`select id from allrice_runs where id=${ctx.runId} and execution_spec ? 'employeeMethodSnapshotDigest'`;
    const explicitRevision = payload.arguments.outputs?.some(
      (output) => !!output.parentObjectId,
    );
    if (existing.length && !methodRun && !explicitRevision) return existing;
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
    const projectParents = new Map<string, 'document' | 'file'>();
    const assertProjectParents = async (requireLatest = false) => {
      for (const output of payload.arguments.outputs ?? []) {
        if (!output.parentObjectId) continue;
        const parent = await (
          'kind' in payload
            ? assertProjectOutputParent
            : assertExplicitOutputParent
        )(
          {
            context: ctx,
            sessionId: binding.task.chatSessionId!,
            parentObjectId: output.parentObjectId,
            format:
              'kind' in payload
                ? (output.format as 'html' | 'json' | 'text' | 'zip')
                : output.format === 'png'
                  ? 'png'
                  : output.format === 'json'
                    ? 'json'
                    : output.format === 'txt' &&
                        localFileMediaType(output.fileName) === 'text/markdown'
                      ? 'markdown'
                      : 'text',
          },
          tx,
          true,
          requireLatest,
        );
        if ('kind' in payload)
          projectParents.set(output.path, parent.kind as 'document' | 'file');
      }
    };
    await assertProjectParents();
    const method = !('kind' in payload)
      ? await methodFileProof(
          tx,
          ctx,
          payload,
          binding.attempt.operationId,
          binding,
        )
      : undefined;
    // Exact cached revisions may be historical, but not revoked/deleted/expired.
    if (existing.length) {
      if (explicitRevision) {
        const outputs = payload.arguments.outputs ?? [];
        if (existing.length !== outputs.length)
          throw new RuntimePolicyError('cloud_result_unconfirmed');
        for (const [index, output] of outputs.entries()) {
          const cached = existing[index]!;
          const live = await assertExplicitOutputParent(
            {
              context: ctx,
              sessionId: binding.task.chatSessionId!,
              parentObjectId: cached.object.id,
              format:
                'kind' in payload
                  ? (output.format as 'html' | 'json' | 'text' | 'zip')
                  : output.format === 'png'
                    ? 'png'
                    : output.format === 'json'
                      ? 'json'
                      : output.format === 'txt' &&
                          localFileMediaType(output.fileName) ===
                            'text/markdown'
                        ? 'markdown'
                        : 'text',
            },
            tx,
            true,
          );
          if (
            live.id !== cached.versionId ||
            live.checksum !== cached.object.checksum ||
            live.run_id !== ctx.runId ||
            live.operation_id !== binding.attempt.operationId ||
            cached.fileName !== output.fileName
          )
            throw new RuntimePolicyError('cloud_result_unconfirmed');
        }
        await assertAdmission({
          transaction: tx,
          binding,
          phase: 'heartbeat',
          now: new Date(),
        });
      }
      return existing;
    }
    // Every writer shares the quota gate already held above, including generic
    // registerToolBrokerExport. A new project child must name the current tip.
    await assertProjectParents(true);
    const published: {
      object: StorageObject;
      fileName: string;
      versionId: string;
    }[] = [];
    let artifactBytes = 0;
    const projectArtifacts =
      'kind' in payload
        ? ProjectCollectedArtifactsSchema.parse(input.artifacts)
        : null;
    for (const output of payload.arguments.outputs ?? []) {
      // Also fence two outputs in one operation from forking the same old tip.
      if (output.parentObjectId)
        await (
          'kind' in payload
            ? assertProjectOutputParent
            : assertExplicitOutputParent
        )(
          {
            context: ctx,
            sessionId: binding.task.chatSessionId!,
            parentObjectId: output.parentObjectId,
            format:
              'kind' in payload
                ? (output.format as 'html' | 'json' | 'text' | 'zip')
                : output.format === 'png'
                  ? 'png'
                  : output.format === 'json'
                    ? 'json'
                    : output.format === 'txt' &&
                        localFileMediaType(output.fileName) === 'text/markdown'
                      ? 'markdown'
                      : 'text',
          },
          tx,
          true,
          true,
        );
      const artifact = input.artifacts.find((a) => a.path === output.path);
      if (!artifact) throw new RuntimePolicyError('cloud_artifact_missing');
      const bytes = Buffer.from(artifact.contentBase64, 'base64');
      artifactBytes += bytes.length;
      if (
        artifactBytes >
        ('kind' in payload
          ? projectArtifactLimits.bytes
          : payload.arguments.limits.artifactBytes)
      )
        throw new RuntimePolicyError('cloud_artifact_limit');
      if (projectArtifacts) {
        const proof = projectArtifacts.find((a) => a.path === output.path);
        if (
          !proof ||
          bytes.length !== proof.sizeBytes ||
          bytes.toString('base64') !== proof.contentBase64 ||
          'sha256:' + createHash('sha256').update(bytes).digest('hex') !==
            proof.checksum
        )
          throw new RuntimePolicyError('cloud_artifact_invalid');
      }
      if (output.format === 'png') {
        try {
          validatePngArtifact(bytes, artifact.png);
        } catch {
          throw new RuntimePolicyError('cloud_artifact_invalid');
        }
      }
      const isMarkdown =
        output.format === 'txt' &&
        localFileMediaType(output.fileName) === 'text/markdown';
      const object = StorageObjectSchema.parse({
        ...createToolBrokerExportObject({
          context: ctx,
          mediaType:
            output.format === 'png'
              ? 'image/png'
              : output.format === 'json'
                ? 'application/json'
                : output.format === 'csv'
                  ? 'text/csv'
                  : output.format === 'html'
                    ? 'text/html'
                    : output.format === 'zip'
                      ? 'application/zip'
                      : isMarkdown
                        ? 'text/markdown'
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
          ...(method
            ? {
                platformTestRunId: method.b.test_id,
                methodFileOperationId: binding.attempt.operationId,
              }
            : { sessionId: binding.task.chatSessionId! }),
          fileName: output.fileName,
          ...('parentObjectId' in output && output.parentObjectId
            ? { parentObjectId: output.parentObjectId }
            : {}),
          format:
            output.format === 'png'
              ? 'png'
              : output.format === 'json'
                ? 'json'
                : output.format === 'html'
                  ? 'html'
                  : output.format === 'zip'
                    ? 'zip'
                    : isMarkdown
                      ? 'markdown'
                      : 'text',
          object,
          ...('kind' in payload
            ? {
                changeSummary: `项目版本 ${payload.arguments.projectSource.project.snapshot.id}；源码 ${payload.arguments.projectSource.snapshot.sourceDigest}；操作 ${binding.attempt.operationId}`,
              }
            : {}),
        },
        tx,
      );
      await tx`insert into allrice_workbench_artifacts(version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,execution,request_id,request_digest) values(${version.id},${ctx.organizationId},${ctx.workspaceId},${ctx.policySnapshot.subjectId},${ctx.runId},${projectParents.get(output.path) ?? 'file'},${tx.json({ kind: 'tool_result', runId: ctx.runId, operationId: binding.attempt.operationId, stepId: null })},${tx.json(binding.execution)},${`cloud:${binding.attempt.operationId}:${output.path}`},${digest({ objectId: object.id, checksum: object.checksum })})`;
      if (method)
        await recordMethodFilePublication(
          tx,
          method,
          { object, versionId: version.id },
          bytes,
        );
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
    await assertProjectParents();
    const [stillCurrent] =
      await tx`select root_run_id from allrice_runtime_roots where root_run_id=${binding.task.rootRunId} and cancel_request_id is null and deadline_at>clock_timestamp()`;
    if (!stillCurrent)
      throw new RuntimePolicyError('cloud_publication_revoked');
    await tx`update allrice_cloud_execution_attempts set artifacts=${tx.json(published)} where operation_id=${binding.attempt.operationId}`;
    return published;
  });
}
