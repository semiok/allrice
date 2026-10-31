import type { TransactionSql } from 'postgres';
import { getDatabase } from './core/client.ts';
import {
  EmployeeExecutionSnapshotSchema,
  EmployeeManifestSchema,
  PolicySnapshotSchema,
  RuntimePolicyControlsSchema,
  RuntimeTaskRefSchema,
  runtimeContractEqual,
  runtimeFeatureEnabled,
  type RuntimeScope,
} from '@allrice/contracts';
import { assertWorkbenchSession } from './artifact-review.ts';
import { employeeManifestChecksum } from './employees/employee-config.ts';
import { verifiedRuntimePackageChecksum } from './platform-employees/runtime-package.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import {
  finalDeliveryUnavailable,
  markFinalDeliveryRootLocked,
} from './final-delivery-commit.ts';

/** Worker-held incarnation, never accepted from a model, HTTP or native RPC. */
export interface RunDeliveryAuthority {
  scope: RuntimeScope;
  rootRunId: string;
  worker: {
    jobId: string;
    workerId: string;
    leaseToken: string;
    generation: number;
    attempt: number;
  };
}

/** Shared tenant/member/employee/Run/lease admission. Action-specific policy
 * remains with each tool or delivery endpoint. */
async function assertRunAuthority(
  tx: TransactionSql,
  input: RunDeliveryAuthority,
  lock: boolean,
) {
  const { scope, rootRunId, worker } = input;
  if (lock) {
    // Queue completion/publication use this existing pre-root mutex. Cloud
    // admission holds runtime_root before Run/policy/Job (with or without a
    // task clock). Join that order before taking Job, or a control can hold Job
    // while waiting for policy and deadlock the cloud admission waiting for Job.
    await tx`select pg_advisory_xact_lock(hashtextextended(${rootRunId.toLowerCase()},703))`;
    await tx`select root_run_id from allrice_runtime_roots
      where root_run_id=${rootRunId} and organization_id=${scope.organizationId}
        and workspace_id=${scope.workspaceId} for update`;
  }
  // Job precedes run/session, matching queue completion. These locks also
  // exclude publication's SHARE job/run and UPDATE session locks.
  const [job] =
    await tx`select id,owner_id from allrice_jobs where id=${worker.jobId}
    and run_id=${rootRunId} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
    and worker_id=${worker.workerId} and lease_token=${worker.leaseToken} and attempt=${worker.attempt}
    and status='running' and cancel_requested_at is null and drain_reason is null
    and lease_expires_at>clock_timestamp() and timeout_at>clock_timestamp() ${lock ? tx`for update` : tx``}`;
  if (!job) finalDeliveryUnavailable();
  // Admission takes user NO KEY UPDATE before Session UPDATE. Take user SHARE
  // before the join locks the Session, or each transaction can wait on the other.
  // The owner comes from the locked job; assertWorkbenchSession still checks
  // current tenant/member authority below.
  await tx`select id from allrice_users where id=${job.owner_id} ${lock ? tx`for share` : tx``}`;
  const [policy] =
    await tx`select version,controls from allrice_runtime_policy_controls
    where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} ${lock ? tx`for share` : tx``}`;
  const controls = RuntimePolicyControlsSchema.safeParse(policy?.controls);
  if (
    !controls.success ||
    controls.data.version !== policy?.version ||
    !controls.data.enabled
  )
    finalDeliveryUnavailable();
  const [row] = await tx<
    {
      owner_id: string;
      session_id: string;
      assistant_message_id: string;
      employee_id: string;
      employee_version_id: string;
      employee_assignment_id: string;
      manifest: unknown;
      config_checksum: string;
      version: number;
      execution_snapshot: unknown;
      execution_spec: unknown;
      policy_snapshot_id: string;
      policy_payload: unknown;
      policy_expires_at: Date;
      lease_expires_at: Date;
      timeout_at: Date;
      thread_id: string;
      active_turn_id: string | null;
    }[]
  >`select r.owner_id,e.session_id,e.assistant_message_id,v.employee_id,e.employee_version_id,e.employee_assignment_id,
      v.manifest,v.config_checksum,v.version,e.execution_snapshot,r.execution_spec,r.policy_snapshot_id,
      p.payload policy_payload,p.expires_at policy_expires_at,j.lease_expires_at,j.timeout_at,c.thread_id,c.active_turn_id
    from allrice_jobs j
    join allrice_runs r on r.id=j.run_id and r.organization_id=j.organization_id and r.workspace_id=j.workspace_id and r.owner_id=j.owner_id
    join allrice_employee_runs e on e.run_id=r.id and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id
    join allrice_employee_versions v on v.id=e.employee_version_id and v.organization_id=e.organization_id and v.workspace_id=e.workspace_id
    join allrice_employees employee on employee.id=v.employee_id and employee.organization_id=e.organization_id and employee.workspace_id=e.workspace_id and employee.status='active'
    join allrice_employee_assignments a on a.id=e.employee_assignment_id and a.employee_id=v.employee_id and a.organization_id=e.organization_id and a.workspace_id=e.workspace_id and a.user_id=e.owner_id and a.active
    join allrice_policy_snapshots p on p.id=r.policy_snapshot_id and p.organization_id=r.organization_id and p.subject_id=r.owner_id
    join allrice_chat_sessions s on s.id=e.session_id and s.organization_id=e.organization_id and s.workspace_id=e.workspace_id and s.owner_id=e.owner_id
    join allrice_conversation_runtimes c on c.session_id=e.session_id and c.organization_id=e.organization_id and c.workspace_id=e.workspace_id and c.owner_id=e.owner_id
      and c.active_run_id=r.id and c.worker_id=j.worker_id and c.state='running' and c.thread_generation=${worker.generation}
    join allrice_native_session_bindings n on n.native_session_id=c.thread_id and n.organization_id=e.organization_id
      and n.workspace_id=e.workspace_id and n.owner_id=e.owner_id and n.context_kind='chat' and n.context_id=e.session_id
      and n.storage_context_key=e.session_id::text and n.profile_id='restricted'
    where j.id=${worker.jobId} and r.state='running' and r.project_id is not distinct from ${scope.projectId}::uuid
      and s.project_id is not distinct from r.project_id and s.archived_at is null
      and p.expires_at>clock_timestamp() and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp()
      and not exists(select 1 from allrice_platform_employee_tenant_assignments d where d.tenant_employee_id=employee.id
        and d.organization_id=e.organization_id and d.workspace_id=e.workspace_id and not d.active)
    ${lock ? tx`for update of r,c for share of j,e,v,employee,a,p,s,n` : tx``}`;
  if (!row) finalDeliveryUnavailable();
  await assertWorkbenchSession(
    tx,
    { actor: { type: 'user', id: row.owner_id }, ...scope },
    row.session_id,
    true,
    lock ? 'share' : false,
  );
  const snapshot = EmployeeExecutionSnapshotSchema.parse(
    row.execution_snapshot,
  );
  const manifest = EmployeeManifestSchema.parse(row.manifest);
  const frozenPolicy = PolicySnapshotSchema.pick({
    memberships: true,
    grants: true,
  }).parse(row.policy_payload);
  if (
    snapshot.schemaVersion !== 2 ||
    manifest.schemaVersion !== 2 ||
    snapshot.runtimePolicy.harness !== 'dsh' ||
    snapshot.employee.id !== row.employee_id ||
    snapshot.employee.versionId !== row.employee_version_id ||
    snapshot.employee.revision !== row.version ||
    snapshot.employee.definitionChecksum !== row.config_checksum ||
    (manifest.runtimePackage
      ? verifiedRuntimePackageChecksum(manifest.runtimePackage)
      : employeeManifestChecksum(manifest)) !== row.config_checksum ||
    !runtimeContractEqual(snapshot.employee.definition, manifest) ||
    snapshot.assignment.id !== row.employee_assignment_id ||
    snapshot.assignment.userId !== row.owner_id ||
    snapshot.tenantContext.organizationId !== scope.organizationId ||
    snapshot.tenantContext.workspaceId !== scope.workspaceId ||
    snapshot.tenantContext.actorId !== row.owner_id ||
    snapshot.tenantContext.policySnapshotId !== row.policy_snapshot_id ||
    snapshot.capabilitySnapshot.resolvedForActorId !== row.owner_id ||
    !snapshot.capabilitySnapshot.grantedCapabilities.includes('model:invoke') ||
    !snapshot.capabilitySnapshot.grantedCapabilities.every(
      (c) =>
        manifest.capabilities.includes(c) &&
        !manifest.securityPolicy.deniedCapabilities.includes(c),
    ) ||
    !frozenPolicy.memberships.some(
      (m) =>
        m.userId === row.owner_id &&
        m.organizationId === scope.organizationId &&
        (m.workspaceId === null || m.workspaceId === scope.workspaceId) &&
        m.active &&
        ['admin', 'member'].includes(m.role),
    ) ||
    !frozenPolicy.grants.some(
      (g) =>
        g.resourceType === 'job' &&
        g.action === 'job:execute' &&
        (g.workspaceId === null || g.workspaceId === scope.workspaceId),
    )
  )
    finalDeliveryUnavailable();
  if (manifest.runtimePackage) {
    const packaged = manifest.runtimePackage.runtimeManifest;
    if (
      packaged.provider !== manifest.runtimePolicy.provider ||
      packaged.model !== manifest.runtimePolicy.model ||
      !runtimeContractEqual(
        [...packaged.toolNames].sort(),
        [...manifest.capabilityBindings.toolNames].sort(),
      ) ||
      !runtimeContractEqual(
        [...packaged.deniedCapabilities].sort(),
        [...manifest.securityPolicy.deniedCapabilities].sort(),
      )
    )
      finalDeliveryUnavailable();
  }
  if (scope.projectId !== null) {
    const [project] =
      await tx`select id from allrice_projects where id=${scope.projectId} and organization_id=${scope.organizationId}
      and workspace_id=${scope.workspaceId} and archived_at is null and (owner_id=${row.owner_id} or visibility in ('workspace','organization')) ${lock ? tx`for share` : tx``}`;
    if (!project) finalDeliveryUnavailable();
  }
  const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() now`;
  const deadlines = [
    row.lease_expires_at,
    row.timeout_at,
    row.policy_expires_at,
  ];
  if (!clock || deadlines.some((d) => d <= clock.now))
    finalDeliveryUnavailable();
  const authority = {
    task: RuntimeTaskRefSchema.parse({
      scope,
      runId: rootRunId,
      rootRunId,
      parentRunId: null,
      chatSessionId: row.session_id,
      frozenConfiguration: {
        employeeVersionId: row.employee_version_id,
        digest: runtimePolicyDigest(row.execution_spec),
      },
    }),
    nativeSessionId: row.thread_id,
    ownerId: row.owner_id,
    activeTurnId: row.active_turn_id,
    assistantMessageId: row.assistant_message_id,
    deadlines,
    validUntil: Math.min(...deadlines.map((deadline) => deadline.getTime())),
  };
  return { authority, controls: controls.data };
}

/** The existing admission predicate, inside a command's atomic claim/insert. */
export async function assertNativeRunAuthorityTransaction(
  tx: TransactionSql,
  input: RunDeliveryAuthority,
) {
  return (await assertRunAuthority(tx, input, true)).authority;
}

/** Delivery retains its feature/mode gates and publication locking contract. */
export async function assertRunDeliveryAuthority(
  tx: TransactionSql,
  input: RunDeliveryAuthority,
) {
  if (!runtimeFeatureEnabled('ALLRICE_WORKBENCH_ENABLED'))
    finalDeliveryUnavailable();
  const { controls, authority } = await assertRunAuthority(tx, input, true);
  if (controls.mode !== 'execute') finalDeliveryUnavailable();
  markFinalDeliveryRootLocked(tx, input.rootRunId);
  return authority;
}

/** Tool-seam admission is read-only; it grants no action or delivery rights. */
export async function assertNativeRunAuthority(input: RunDeliveryAuthority) {
  return getDatabase().begin(
    'read only',
    async (tx) => (await assertRunAuthority(tx, input, false)).authority,
  );
}
