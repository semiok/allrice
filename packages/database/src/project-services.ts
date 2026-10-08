import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import {
  ProjectServiceConfigSchema,
  ProjectServiceViewSchema,
  ProjectServiceSourceUpdateSchema,
  ProjectServiceSourceReceiptSchema,
  ProjectServiceTargetSchema,
  ProjectServiceUserActionSchema,
  ProjectServiceControlInputSchema,
  RuntimeLocalCommandSchema,
  CloudProjectCommandSchema,
  type CloudProjectCommand,
  RuntimeOperationSnapshotSchema,
  RuntimePolicyControlsSchema,
  RuntimeActionApprovalRequestSchema,
  evaluateRuntimePolicy,
  matchesRuntimeActionApproval,
  runtimeContractEqual,
  projectServiceLimits,
  EmployeeExecutionSnapshotSchema,
  RuntimeLocalCommandProfileSchema,
  isLocalCommandProfileForPlatform,
  type RuntimeOperationSnapshot,
  type RuntimeLocalCommand,
  type RequestContext,
  type ExecutionContext,
  type StoragePort,
  type ProjectServiceView,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import {
  RuntimePolicyError,
  runtimePolicyDigest,
  assertRuntimePolicyIdentity,
  operationWorkAutomation,
} from './runtime-policy.ts';
import {
  assertWorkbenchSession,
  assertPublishingRun,
} from './artifact-review.ts';
import { readProjectSource } from './saved-project-authority.ts';
import { checkContinuingCloudProjectAuthority } from './cloud-authority.ts';
import { bridgeSettingsView } from './bridge-settings.ts';
import { isPlatformQualityServiceAuthorized } from './platform-quality.ts';

type DB = ReturnType<typeof getDatabase>;
type Principal = Pick<
  RequestContext,
  'organizationId' | 'workspaceId' | 'actor'
>;
type Row = {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  run_id: string;
  session_id: string;
  backend: 'local' | 'cloud';
  device_id: string | null;
  project_ref: unknown;
  source_digest: string;
  configuration: unknown;
  expires_at: Date;
  hard_deadline_at: Date;
  heartbeat_at: Date | null;
  stop_requested: boolean;
  pending_update: unknown | null;
  update_count: number;
};
const json = (tx: TransactionSql, value: unknown) =>
  tx.json(JSON.parse(JSON.stringify(value)));
export type ProjectServiceStopReason =
  | 'authority_check_failed'
  | 'service_not_current'
  | 'policy_expired'
  | 'run_not_continuing'
  | 'platform_quality_unavailable'
  | 'owner_or_membership_unavailable'
  | 'policy_identity_unavailable'
  | 'operation_not_continuing'
  | 'worker_lease_changed'
  | 'project_capability_unavailable'
  | 'policy_disabled'
  | 'approval_unavailable'
  | 'local_authority_missing_or_stale'
  | 'local_profile_invalid'
  | 'local_profile_unavailable'
  | 'local_runtime_changed'
  | 'bridge_settings_disabled'
  | 'service_configuration_changed'
  | 'cloud_authority_unavailable'
  | 'hard_deadline_reached';

// Internal metadata only: keep public error types/codes and strict wire events.
const stopReasons = new WeakMap<object, ProjectServiceStopReason>();
export function projectServiceStopReason(
  error: unknown,
): ProjectServiceStopReason {
  return typeof error === 'object' && error !== null
    ? (stopReasons.get(error) ?? 'authority_check_failed')
    : 'authority_check_failed';
}
function denied(reason?: ProjectServiceStopReason): never {
  const error = new RuntimePolicyError('project_service_unavailable');
  if (reason) stopReasons.set(error, reason);
  throw error;
}
async function diagnoseAuthority<T>(
  reason: ProjectServiceStopReason,
  check: () => Promise<T>,
): Promise<T> {
  try {
    return await check();
  } catch (error) {
    if (typeof error === 'object' && error !== null)
      stopReasons.set(error, reason);
    throw error;
  }
}

/** Called under the existing root -> operation lock, before any physical start.
 * No lifetime is extended by retries, page refreshes or device heartbeats. */
export async function initializeProjectServiceLease(
  tx: TransactionSql,
  snapshot: RuntimeOperationSnapshot,
  command: RuntimeLocalCommand | CloudProjectCommand,
) {
  const config = command.arguments.background?.projectService;
  if (!config) return null;
  const b = snapshot.binding,
    source = command.arguments.projectSource;
  if (!source || command.arguments.projectPreparation?.manager !== 'pnpm')
    denied();
  const [origin] = await tx<
    { session_id: string }[]
  >`select session_id from allrice_employee_runs
    where run_id=${b.task.runId} and organization_id=${b.task.scope.organizationId}
      and workspace_id=${b.task.scope.workspaceId} and owner_id=${b.requestedBy.id}`;
  if (!origin) denied();
  await tx`insert into allrice_project_services(id,organization_id,workspace_id,owner_id,run_id,session_id,
      backend,device_id,project_ref,source_digest,configuration,expires_at,hard_deadline_at)
    values(${b.attempt.operationId},${b.task.scope.organizationId},${b.task.scope.workspaceId},${b.requestedBy.id},
      ${b.task.runId},${origin.session_id},${b.execution.targetKind === 'cloud_sandbox' ? 'cloud' : 'local'},${b.execution.deviceId},${json(tx, source.project)},
      ${source.snapshot.sourceDigest},${json(tx, config)},clock_timestamp()+${config.leaseMs}*interval '1 millisecond',
      clock_timestamp()+${projectServiceLimits.maximumLifetimeMs}*interval '1 millisecond') on conflict(id) do nothing`;
  const [row] = await tx<
    Row[]
  >`select * from allrice_project_services where id=${b.attempt.operationId} for update`;
  if (
    !row ||
    row.run_id !== b.task.runId ||
    row.owner_id !== b.requestedBy.id ||
    row.organization_id !== b.task.scope.organizationId ||
    row.workspace_id !== b.task.scope.workspaceId ||
    row.backend !==
      (b.execution.targetKind === 'cloud_sandbox' ? 'cloud' : 'local') ||
    row.device_id !== b.execution.deviceId ||
    !runtimeContractEqual(
      ProjectServiceConfigSchema.parse(row.configuration),
      config,
    )
  )
    denied();
  return row;
}

/** Lease-owned authority is deliberately independent of an ended Job/root.
 * It does not authorize another operation, renew an agent budget or resurrect a
 * Run. Current owner, assignment, settings, policy, grant and exact backend remain mandatory. */
export async function currentProjectService(
  tx: TransactionSql,
  id: string,
  principal?: Principal,
  requireHeartbeat = false,
) {
  const [row] = await tx<
    (Row & {
      snapshot: unknown;
      bridge_payload: unknown;
      cloud_payload: unknown;
      clock: Date;
      run_state: string;
      policy_expires: Date;
      execution_snapshot: unknown;
      active_job: boolean;
    })[]
  >`
    select s.*,o.snapshot,o.bridge_payload,ci.payload as cloud_payload,clock_timestamp() as clock,r.state as run_state,
      p.expires_at as policy_expires,e.execution_snapshot,
      exists(select 1 from allrice_jobs j join allrice_conversation_runtimes c on c.session_id=e.session_id
        and c.organization_id=r.organization_id and c.workspace_id=r.workspace_id and c.owner_id=r.owner_id
        where j.run_id=r.id and j.status='running' and j.cancel_requested_at is null
          and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp()
          and c.active_run_id=r.id and c.state='running') as active_job
    from allrice_project_services s join allrice_runtime_operations o on o.id=s.id
    left join allrice_cloud_execution_inputs ci on ci.operation_id=s.id
    join allrice_runs r on r.id=s.run_id and r.organization_id=s.organization_id and r.workspace_id=s.workspace_id and r.owner_id=s.owner_id
    join allrice_employee_runs e on e.run_id=r.id and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id
    join allrice_employee_assignments a on a.id=e.employee_assignment_id and a.organization_id=s.organization_id and a.workspace_id=s.workspace_id and a.user_id=s.owner_id and a.active
    join allrice_employees employee on employee.id=a.employee_id and employee.organization_id=s.organization_id and employee.workspace_id=s.workspace_id and employee.status='active'
    join allrice_policy_snapshots p on p.id=r.policy_snapshot_id and p.organization_id=s.organization_id and p.subject_id=s.owner_id
    where s.id=${id} and not s.stop_requested and s.expires_at>clock_timestamp() and s.hard_deadline_at>clock_timestamp()
      and (${!requireHeartbeat} or s.heartbeat_at between clock_timestamp()-interval '5 seconds' and clock_timestamp())`;
  if (!row) denied('service_not_current');
  if (row.policy_expires <= row.clock) denied('policy_expired');
  if (!(
    row.run_state === 'succeeded' ||
    (row.run_state === 'running' && row.active_job)
  ))
    denied('run_not_continuing');
  if (!(await isPlatformQualityServiceAuthorized(tx, row)))
    denied('platform_quality_unavailable');
  const actor: Principal = {
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    actor: { type: 'user', id: row.owner_id },
  };
  if (
    principal &&
    (principal.actor.type !== 'user' ||
      principal.actor.id !== row.owner_id ||
      principal.organizationId !== row.organization_id ||
      principal.workspaceId !== row.workspace_id)
  )
    denied('owner_or_membership_unavailable');
  await diagnoseAuthority('owner_or_membership_unavailable', () =>
    assertWorkbenchSession(tx, actor, row.session_id, false, 'share'),
  );
  const snapshot = RuntimeOperationSnapshotSchema.parse(row.snapshot),
    binding = snapshot.binding;
  await diagnoseAuthority('policy_identity_unavailable', () =>
    assertRuntimePolicyIdentity(tx, { ...actor, requestId: id }),
  );
  if (
    snapshot.status !== 'running' ||
    snapshot.cancelRequestId ||
    binding.requestedBy.id !== row.owner_id ||
    binding.task.scope.organizationId !== row.organization_id ||
    binding.task.scope.workspaceId !== row.workspace_id ||
    binding.task.runId !== row.run_id ||
    binding.attempt.operationId !== id
  )
    denied('operation_not_continuing');
  const command =
      row.backend === 'cloud'
        ? CloudProjectCommandSchema.parse(row.cloud_payload)
        : RuntimeLocalCommandSchema.parse(row.bridge_payload),
    origin = command.arguments.projectSource?.origin;
  if (!origin) denied();
  if (row.run_state === 'running') {
    const [job] = await tx<
      { lease_token: string }[]
    >`select lease_token from allrice_jobs
      where id=${origin.jobId} and run_id=${row.run_id} and organization_id=${row.organization_id} and workspace_id=${row.workspace_id}
        and owner_id=${row.owner_id} and worker_id=${origin.workerId} and attempt=${origin.attempt} and status='running'
        and cancel_requested_at is null and lease_expires_at>clock_timestamp() and timeout_at>clock_timestamp()`;
    if (
      !job ||
      createHash('sha256').update(job.lease_token).digest('hex') !==
        origin.leaseTokenDigest
    )
      denied('worker_lease_changed');
  }
  const frozen = EmployeeExecutionSnapshotSchema.parse(row.execution_snapshot);
  if (
    !frozen.capabilitySnapshot.bindings.toolNames.includes('workspace.project')
  )
    denied('project_capability_unavailable');
  const [policy] = await tx<
    { version: number; controls: unknown }[]
  >`select version,controls from allrice_runtime_policy_controls
    where organization_id=${row.organization_id} and workspace_id=${row.workspace_id}`;
  const controls = RuntimePolicyControlsSchema.safeParse(policy?.controls);
  if (
    !controls.success ||
    controls.data.version !== policy?.version ||
    controls.data.mode !== 'execute'
  )
    denied('policy_disabled');
  const decision = evaluateRuntimePolicy(
    controls.data,
    binding,
    undefined,
    (await operationWorkAutomation(tx, id))?.settings,
  );
  if (decision.effect === 'deny') denied('policy_disabled');
  const approvals = await tx<
    {
      runtime_request: unknown;
      runtime_response: unknown;
      runtime_consumed_at: Date | null;
      runtime_revoked_at: Date | null;
      runtime_expires_at: Date;
      runtime_control_version: number;
      status: string;
      runtime_binding_digest: string;
    }[]
  >`select * from allrice_approval_requests
    where organization_id=${row.organization_id} and workspace_id=${row.workspace_id}
      and resource_type='runtime_operation' and resource_id=${id}`;
  if (approvals.length > 1 || (decision.effect === 'ask' && !approvals.length))
    denied('approval_unavailable');
  for (const a of approvals) {
    const r = RuntimeActionApprovalRequestSchema.safeParse(a.runtime_request);
    if (
      !r.success ||
      a.runtime_binding_digest !== runtimePolicyDigest(binding) ||
      a.runtime_control_version !== controls.data.version ||
      a.status !== 'approved' ||
      a.runtime_revoked_at ||
      !a.runtime_consumed_at ||
      a.runtime_expires_at <= row.clock ||
      !matchesRuntimeActionApproval(
        {
          request: r.data,
          response: a.runtime_response,
          consumedAt: null,
          revokedAt: null,
        },
        {
          trustedScope: binding.task.scope,
          task: binding.task,
          respondentId: row.owner_id,
          activeTurn: null,
          now: row.clock.toISOString(),
          binding,
        },
      )
    )
      denied('approval_unavailable');
  }
  if (row.backend === 'local') {
    const [local] = await tx<
      {
        platform: string;
        profile: unknown;
        metadata: Record<string, unknown>;
      }[]
    >`select d.platform,p.profile,t.metadata
      from allrice_bridge_devices d join allrice_bridge_runtime_profiles p on p.device_id=d.id and p.organization_id=d.organization_id and p.workspace_id=d.workspace_id
      join allrice_bridge_managed_runtime_grants g on g.id=${binding.execution.grantId} and g.device_id=d.id and g.organization_id=d.organization_id and g.workspace_id=d.workspace_id and g.owner_id=d.owner_id
      join allrice_execution_targets t on t.id=${binding.execution.targetId} and t.organization_id=d.organization_id and t.workspace_id=d.workspace_id and t.target_key='bridge.'||d.id::text
      where d.id=${row.device_id} and d.organization_id=${row.organization_id} and d.workspace_id=${row.workspace_id} and d.owner_id=${row.owner_id}
        and d.revoked_at is null and d.last_seen_at between clock_timestamp()-interval '90 seconds' and clock_timestamp()
        and g.revoked_at is null and g.runtime_generation=${binding.execution.grantVersion} and ('sha256:'||g.root_fingerprint)=${binding.execution.scopeDigest}
        and t.kind='rice_bridge' and t.state='online' and p.reported_at between clock_timestamp()-interval '90 seconds' and clock_timestamp()`;
    if (!local) denied('local_authority_missing_or_stale');
    const profile = RuntimeLocalCommandProfileSchema.safeParse(local.profile);
    if (!profile.success) denied('local_profile_invalid');
    if (!profile.data.available) denied('local_profile_unavailable');
    if (
      !isLocalCommandProfileForPlatform(local.platform, profile.data) ||
      !profile.data.features?.includes('project_services') ||
      !profile.data.projectPreparation?.available ||
      profile.data.imageDigest !== command.arguments.imageDigest
    )
      denied('local_runtime_changed');
    const settings = bridgeSettingsView(local.metadata).settings;
    if (!settings.localCommand || !settings.development)
      denied('bridge_settings_disabled');
    if (
      !command.arguments.background?.projectService ||
      !runtimeContractEqual(
        command.arguments.background.projectService,
        row.configuration,
      )
    )
      denied('service_configuration_changed');
  } else {
    if (
      !command.arguments.background?.projectService ||
      !runtimeContractEqual(
        command.arguments.background.projectService,
        row.configuration,
      )
    )
      denied();
    await checkContinuingCloudProjectAuthority(
      tx,
      { ...actor, requestId: id },
      binding,
    );
  }
  return { row, snapshot, command };
}

/** Ready, currently authorized services are continuing deliverables rather
 * than unresolved agent actions. Their physical reservations remain unsettled
 * until actual stop; this grants neither another operation nor extra budget. */
export async function continuingProjectServiceIds(
  tx: TransactionSql,
  rootRunId: string,
) {
  const rows = await tx<
    { id: string }[]
  >`select s.id from allrice_project_services s
    left join allrice_local_services l on l.operation_id=s.id
    left join allrice_cloud_execution_attempts c on c.operation_id=s.id
    where s.run_id=${rootRunId} and ((s.backend='local' and l.ready and not l.stop_requested and l.container_id is not null) or (s.backend='cloud' and c.service_ready and c.container_id is not null and c.outcome is null and c.cleanup_confirmed_at is null))
      and not s.stop_requested and s.expires_at>clock_timestamp() and s.hard_deadline_at>clock_timestamp()`;
  const ids: string[] = [];
  for (const candidate of rows) {
    try {
      const { snapshot } = await currentProjectService(
        tx,
        candidate.id,
        undefined,
        true,
      );
      if (
        snapshot.binding.task.rootRunId === rootRunId &&
        snapshot.binding.task.runId === rootRunId
      )
        ids.push(candidate.id);
    } catch (error) {
      if (!(error instanceof RuntimePolicyError)) throw error;
    }
  }
  return ids;
}

/** User intentions use the ledger lock order but never claim physical stop. */
async function ownedLocked(tx: TransactionSql, p: Principal, id: string) {
  const [ref] = await tx<
    Row[]
  >`select * from allrice_project_services where id=${id} and organization_id=${p.organizationId}
    and workspace_id=${p.workspaceId!} and owner_id=${p.actor.id}`;
  if (!ref || p.actor.type !== 'user') denied();
  if (!(await isPlatformQualityServiceAuthorized(tx, ref))) denied();
  await tx`select root_run_id from allrice_runtime_roots where root_run_id=${ref.run_id} for update`;
  await tx`select id from allrice_runtime_operations where id=${id} for update`;
  await tx`select version from allrice_runtime_policy_controls where organization_id=${p.organizationId} and workspace_id=${p.workspaceId!} for update`;
  await assertWorkbenchSession(tx, p, ref.session_id, false, 'share');
  const [row] = await tx<
    Row[]
  >`select * from allrice_project_services where id=${id} for update`;
  if (!row) denied();
  return row;
}
export async function projectServiceUserAction(
  p: Principal,
  id: string,
  raw: unknown,
  db: DB = getDatabase(),
  authorizeControl?: (tx: TransactionSql) => Promise<unknown>,
) {
  const action = ProjectServiceUserActionSchema.parse(raw);
  await db.begin(async (tx) => {
    const row = await ownedLocked(tx, p, id);
    await authorizeControl?.(tx);
    if (action.action === 'stop') {
      await tx`update allrice_project_services set stop_requested=true where id=${id}`;
      await tx`update allrice_local_services set stop_requested=true,state='stopping' where operation_id=${id}`;
    } else if (action.action === 'renew') {
      const [prior] = await tx<
        { payload: unknown }[]
      >`select payload from allrice_project_service_controls where service_id=${id} and request_id=${action.requestId}`;
      if (prior) {
        if (!runtimeContractEqual(prior.payload, action)) denied();
        return;
      }
      await currentProjectService(tx, id, p, true);
      const [expiry] = await tx<
        { at: Date }[]
      >`select least(${row.hard_deadline_at}::timestamptz,greatest(${row.expires_at}::timestamptz,clock_timestamp()+${action.leaseMs}*interval '1 millisecond')) as at`;
      if (!expiry) denied();
      await tx`update allrice_project_services set expires_at=${expiry.at} where id=${id}`;
      await tx`insert into allrice_project_service_controls(service_id,request_id,payload,result) values(${id},${action.requestId},${json(tx, action)},${json(tx, { expiresAt: expiry.at.toISOString() })})`;
    } else if (action.action === 'preview')
      await currentProjectService(tx, id, p, true);
    await authorizeControl?.(tx);
  });
  return readProjectService(p, id, db);
}

export async function readProjectService(
  p: Principal,
  id: string,
  db: DB = getDatabase(),
): Promise<ProjectServiceView> {
  return db.begin(async (tx) => {
    const [r] = await tx<
      (Row & { snapshot: unknown; ready: boolean })[]
    >`select s.*,o.snapshot,case when s.backend='cloud' then c.service_ready else l.ready end as ready from allrice_project_services s
      join allrice_runtime_operations o on o.id=s.id left join allrice_local_services l on l.operation_id=s.id
      left join allrice_cloud_execution_attempts c on c.operation_id=s.id
      where s.id=${id} and s.organization_id=${p.organizationId} and s.workspace_id=${p.workspaceId!} and s.owner_id=${p.actor.id}`;
    if (!r || p.actor.type !== 'user') denied();
    if (!(await isPlatformQualityServiceAuthorized(tx, r))) denied();
    await assertWorkbenchSession(tx, p, r.session_id, false, 'share');
    const snap = RuntimeOperationSnapshotSchema.parse(r.snapshot),
      stopped = ['succeeded', 'failed', 'canceled'].includes(snap.status);
    const stopRequested = r.stop_requested || snap.cancelRequestId !== null;
    const state = stopped
      ? snap.status === 'failed'
        ? 'failed'
        : 'stopped'
      : snap.status === 'unknown'
        ? 'unknown'
        : stopRequested || r.expires_at.getTime() <= Date.now()
          ? 'stopping'
          : r.heartbeat_at && r.heartbeat_at.getTime() < Date.now() - 5000
            ? 'offline'
            : r.ready
              ? 'ready'
              : 'starting';
    return ProjectServiceViewSchema.parse({
      version: 1,
      id: r.id,
      runId: r.run_id,
      sessionId: r.session_id,
      backend: r.backend,
      state,
      project: r.project_ref,
      sourceDigest: r.source_digest,
      expiresAt: r.expires_at.toISOString(),
      hardDeadlineAt: r.hard_deadline_at.toISOString(),
      lastSeenAt: r.heartbeat_at?.toISOString() ?? null,
      stopRequested,
      stopped,
      updatePending: r.pending_update !== null,
      canRenew: state === 'ready' && r.expires_at < r.hard_deadline_at,
    });
  });
}

export async function projectServiceWorkerControl(
  ctx: ExecutionContext,
  sessionId: string,
  raw: unknown,
  worker: { attempt: number; leaseToken: string },
  storage: StoragePort,
  db: DB = getDatabase(),
) {
  const args = ProjectServiceControlInputSchema.parse(raw),
    p: Principal = {
      organizationId: ctx.organizationId,
      workspaceId: ctx.workspaceId,
      actor: { type: 'user', id: ctx.policySnapshot.subjectId },
    };
  const authorizeControl = async (tx: TransactionSql) => {
    if (Date.parse(ctx.policySnapshot.expiresAt) <= Date.now()) denied();
    await assertPublishingRun(tx, ctx, sessionId, 'workspace.project');
    const [lease] =
      await tx`select id from allrice_jobs where id=${ctx.jobId} and run_id=${ctx.runId}
      and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId!} and owner_id=${ctx.policySnapshot.subjectId}
      and worker_id=${ctx.worker.id} and attempt=${worker.attempt} and lease_token=${worker.leaseToken}
      and status='running' and cancel_requested_at is null and lease_expires_at>clock_timestamp() and timeout_at>clock_timestamp() for share`;
    if (!lease) denied();
  };
  if (args.action !== 'service_sync') {
    return projectServiceUserAction(
      p,
      args.serviceId,
      args.action === 'service_status'
        ? { action: 'status' }
        : args.action === 'service_stop'
          ? { action: 'stop' }
          : {
              action: 'renew',
              requestId: args.requestId,
              leaseMs: args.leaseMs,
            },
      db,
      authorizeControl,
    );
  }
  await db.begin(async (tx) => {
    const row = await ownedLocked(tx, p, args.serviceId);
    const [prior] = await tx<
      { payload: unknown }[]
    >`select payload from allrice_project_service_controls where service_id=${row.id} and request_id=${args.requestId}`;
    if (prior) {
      if (!runtimeContractEqual(prior.payload, args)) denied();
      return;
    }
    await authorizeControl(tx);
    const { command } = await currentProjectService(tx, row.id, p, true);
    if (
      row.pending_update ||
      row.update_count >= projectServiceLimits.maximumUpdates ||
      !runtimeContractEqual(row.project_ref, args.expectedProject) ||
      args.project.projectId !== args.expectedProject.projectId
    )
      denied();
    const loaded = await readProjectSource(
      tx,
      ctx,
      args.project.snapshot,
      storage,
    );
    const prep = command.arguments.projectPreparation!;
    if (
      loaded.document.projectId !== args.project.projectId ||
      loaded.document.files.find((f) => f.path === prep.lockPath)?.sha256 !==
        prep.lockChecksum
    )
      denied();
    // Updating package manifests/configuration would silently change dependency
    // installation or executable permission. Restart explicitly for those changes.
    for (const old of [
      ...command.arguments.projectSource!.snapshot.files,
      ...loaded.document.files,
    ])
      if (
        /(^|\/)(package\.json|pnpm-lock\.yaml|\.npmrc|\.pnpmfile\.cjs|(?:vite|next)\.config\.[a-z]+)$/.test(
          old.path,
        ) &&
        loaded.document.files.find((f) => f.path === old.path)?.sha256 !==
          command.arguments.projectSource!.snapshot.files.find(
            (f) => f.path === old.path,
          )?.sha256
      )
        denied();
    const update = ProjectServiceSourceUpdateSchema.parse({
      updateId: args.requestId,
      expectedDigest: row.source_digest,
      project: args.project,
      snapshot: loaded.document,
    });
    await tx`update allrice_project_services set pending_update=${json(tx, update)},update_count=update_count+1 where id=${row.id}`;
    await tx`insert into allrice_project_service_controls(service_id,request_id,payload,result) values(${row.id},${args.requestId},${json(tx, args)},${json(tx, { accepted: true })})`;
    await authorizeControl(tx);
  });
  return readProjectService(p, args.serviceId, db);
}

/** Receipt-only source updates cannot extend the lease or invent a new version. */
export async function applyProjectServiceSourceReceipt(
  tx: TransactionSql,
  id: string,
  raw: unknown,
) {
  const receipt = ProjectServiceSourceReceiptSchema.parse(raw);
  const [row] = await tx<
    Row[]
  >`select * from allrice_project_services where id=${id} for update`;
  if (!row) denied();
  if (!row.pending_update) {
    const [prior] = await tx<
      { result: unknown }[]
    >`select result from allrice_project_service_controls where service_id=${id} and request_id=${receipt.updateId}`;
    if (
      runtimeContractEqual(prior?.result, {
        applied: true,
        sourceDigest: receipt.sourceDigest,
      })
    )
      return;
    denied();
  }
  const update = ProjectServiceSourceUpdateSchema.parse(row.pending_update);
  if (
    update.updateId !== receipt.updateId ||
    update.snapshot.sourceDigest !== receipt.sourceDigest
  )
    denied();
  await tx`update allrice_project_service_controls set result=${json(tx, { applied: true, sourceDigest: receipt.sourceDigest })} where service_id=${id} and request_id=${receipt.updateId}`;
  await tx`update allrice_project_services set project_ref=${json(tx, update.project)},source_digest=${receipt.sourceDigest},pending_update=null where id=${id}`;
}

export async function projectServicePreviewTarget(
  p: Principal,
  id: string,
  db: DB = getDatabase(),
) {
  return db.begin(async (tx) => {
    const { row, snapshot, command } = await currentProjectService(
      tx,
      id,
      p,
      true,
    );
    const [local] = await tx<
      { container_id: string; ready: boolean }[]
    >`select container_id,ready from allrice_local_services where operation_id=${id} and ready and not stop_requested and ${row.backend === 'local'}
      union all select container_id,service_ready as ready from allrice_cloud_execution_attempts where operation_id=${id} and service_ready and outcome is null and cleanup_confirmed_at is null and ${row.backend === 'cloud'}`;
    if (!local?.container_id || !local.ready) denied();
    return ProjectServiceTargetSchema.parse({
      serviceId: id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      ownerId: row.owner_id,
      backend: row.backend,
      deviceId: row.device_id,
      operationId: id,
      attemptId: snapshot.binding.attempt.attemptId,
      containerId: local.container_id,
      imageDigest: command.arguments.imageDigest,
      port: ProjectServiceConfigSchema.parse(row.configuration).port,
      expiresAt: row.expires_at.toISOString(),
      hardDeadlineAt: row.hard_deadline_at.toISOString(),
    });
  });
}
const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export async function createProjectPreviewAccess(
  ctx: RequestContext,
  id: string,
  db: DB = getDatabase(),
) {
  if (!ctx.sessionId) denied();
  await projectServicePreviewTarget(ctx, id, db);
  const token = randomBytes(32).toString('base64url');
  await db.begin(async (tx) => {
    const [session] =
      await tx`select id from allrice_sessions where id=${ctx.sessionId!} and user_id=${ctx.actor.id} and revoked_at is null and expires_at>clock_timestamp()`;
    if (!session) denied();
    await tx`insert into allrice_project_preview_access(id,service_id,user_session_id,token_hash,expires_at)
      select ${randomUUID()},id,${ctx.sessionId!},${tokenHash(token)},least(hard_deadline_at,clock_timestamp()+interval '30 minutes') from allrice_project_services where id=${id}`;
  });
  return token;
}
export async function resolveProjectPreviewAccess(
  id: string,
  token: string,
  db: DB = getDatabase(),
) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) denied();
  const [p] = await db<
    { organization_id: string; workspace_id: string; owner_id: string }[]
  >`select s.organization_id,s.workspace_id,s.owner_id
    from allrice_project_preview_access a join allrice_project_services s on s.id=a.service_id
    join allrice_sessions u on u.id=a.user_session_id and u.user_id=s.owner_id
    where a.service_id=${id} and a.token_hash=${tokenHash(token)} and a.expires_at>clock_timestamp() and u.revoked_at is null and u.expires_at>clock_timestamp()`;
  if (!p) denied();
  return projectServicePreviewTarget(
    {
      organizationId: p.organization_id,
      workspaceId: p.workspace_id,
      actor: { type: 'user', id: p.owner_id },
    },
    id,
    db,
  );
}
