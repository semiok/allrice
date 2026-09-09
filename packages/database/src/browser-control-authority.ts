import type postgres from 'postgres';
import {
  BrowserCommandSchema,
  BrowserObservationSchema,
  BrowserProfileSchema,
  browserObservationCurrent,
  browserOriginAllowed,
  RuntimeActionBindingSchema,
  runtimeContractEqual,
  type ExecutionContext,
  type RuntimeActionBinding,
  type BrowserProfile,
  type BrowserObservation,
  type BrowserWorkspaceState,
} from '@allrice/contracts';
import {
  RuntimePolicyError,
  runtimePolicyDigest as digest,
  type RuntimePolicyPrincipal,
} from './runtime-policy.ts';
import { getDatabase } from './core/client.ts';

export const browserControlEnabled = () =>
  process.env.ALLRICE_BROWSER_CONTROL_ENABLED === '1' &&
  process.env.ALLRICE_RUNTIME_POLICY_ENABLED === '1';
export type BrowserWorkspaceRow = {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  run_id: string;
  session_id: string;
  job_id: string;
  worker_id: string;
  job_lease_token: string;
  job_attempt: number;
  task_id: string | null;
  transport: 'cloud' | 'local';
  device_id: string | null;
  grant_id: string;
  grant_version: number;
  target_id: string;
  profile_id: string;
  profile: BrowserProfile;
  execution_context: ExecutionContext;
  state: BrowserWorkspaceState;
  desired_control: 'agent' | 'human' | 'paused' | 'closed';
  control_fence: number;
  acknowledged_fence: number;
  observation: BrowserObservation | null;
  expires_at: Date;
  stopped_at: Date | null;
  last_heartbeat_at: Date | null;
  execution_spec: unknown;
  policy_payload: unknown;
  policy_snapshot_id: string;
  employee_version_id: string;
  thread_generation: number;
  clock: Date;
  target_kind: string;
  target_state: string;
  target_capabilities: string[];
};
/** Same current identity check for HTTP and Worker. Never accepts stale membership arrays. */
export async function browserIdentity(
  tx: postgres.TransactionSql,
  ctx: RuntimePolicyPrincipal,
  admin = false,
) {
  if (ctx.actor.type !== 'user' || !ctx.workspaceId)
    throw new RuntimePolicyError('browser_identity_denied');
  const rows = await tx<
    { role: string }[]
  >`select m.role from allrice_memberships m
    join allrice_users u on u.id=m.user_id and u.status='active'
    join allrice_organizations o on o.id=m.organization_id and o.archived_at is null
    join allrice_workspaces w on w.id=${ctx.workspaceId} and w.organization_id=o.id and w.archived_at is null
    where m.organization_id=${ctx.organizationId} and m.user_id=${ctx.actor.id} and m.active
    and (m.workspace_id is null or m.workspace_id=${ctx.workspaceId}) for share of m,u,o,w`;
  if (
    !rows.some((r) =>
      admin ? r.role === 'admin' : ['member', 'admin'].includes(r.role),
    )
  )
    throw new RuntimePolicyError('membership_denied');
}
/** Mandatory before every action, request send and control acknowledgment. DB failure denies. */
export async function currentBrowserWorkspace(
  tx: postgres.TransactionSql,
  ctx: RuntimePolicyPrincipal,
  id: string,
): Promise<BrowserWorkspaceRow> {
  if (!browserControlEnabled())
    throw new RuntimePolicyError('browser_control_disabled');
  await browserIdentity(tx, ctx);
  await lockBrowserWorkspaceGrant(tx, ctx, id);
  const [w] = await tx<
    BrowserWorkspaceRow[]
  >`select w.*,g.target_id,t.kind as target_kind,t.state as target_state,t.capabilities as target_capabilities,
    r.execution_spec,r.policy_snapshot_id,p.payload as policy_payload,
    e.employee_version_id,c.thread_generation,clock_timestamp() as clock
    from allrice_browser_workspaces w join allrice_browser_control_grants g on g.id=w.grant_id
    and g.organization_id=w.organization_id and g.workspace_id=w.workspace_id and g.owner_id=w.owner_id
    join allrice_execution_targets t on t.id=g.target_id and t.organization_id=w.organization_id and t.workspace_id=w.workspace_id
    join allrice_runs r on r.id=w.run_id and r.organization_id=w.organization_id and r.workspace_id=w.workspace_id and r.owner_id=w.owner_id
    join allrice_employee_runs e on e.run_id=r.id and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id
    join allrice_employee_assignments a on a.id=e.employee_assignment_id and a.organization_id=e.organization_id and a.workspace_id=e.workspace_id and a.user_id=e.owner_id and a.active
    join allrice_employees pe on pe.id=a.employee_id and pe.organization_id=w.organization_id and pe.workspace_id=w.workspace_id and pe.status='active'
    join allrice_conversation_runtimes c on c.session_id=e.session_id and c.organization_id=e.organization_id and c.workspace_id=e.workspace_id and c.owner_id=e.owner_id
    join allrice_jobs j on j.id=w.job_id and j.run_id=w.run_id and j.organization_id=w.organization_id and j.workspace_id=w.workspace_id and j.owner_id=w.owner_id
    join allrice_policy_snapshots p on p.id=r.policy_snapshot_id and p.organization_id=w.organization_id and p.subject_id=w.owner_id
    where w.id=${id} and w.organization_id=${ctx.organizationId} and w.workspace_id=${ctx.workspaceId} and w.owner_id=${ctx.actor.id}
    and w.state not in ('closed','unknown') and w.expires_at>clock_timestamp()
    and g.enabled and g.revoked_at is null and g.version=w.grant_version and g.profile=w.profile
    and g.transport=w.transport and t.state='online'
    and r.state='running' and c.active_run_id=r.id and c.state='running' and e.session_id=w.session_id
    and j.status='running' and j.worker_id=w.worker_id and j.lease_token=w.job_lease_token and j.attempt=w.job_attempt
    and j.cancel_requested_at is null and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp()
    and p.expires_at>clock_timestamp()
    and e.execution_snapshot->'capabilitySnapshot'->'bindings'->'toolNames' ?
      case when w.transport='local' then 'local.browser.workspace' else 'browser.workspace' end
    and (w.transport<>'local' or e.execution_snapshot->'capabilitySnapshot'->'grantedCapabilities' ? 'network:outbound')
    for share of w,g,t,r,e,a,pe,c,j,p`;
  if (!w) throw new RuntimePolicyError('browser_authority_unavailable');
  w.device_id = null;
  if (w.transport === 'local') {
    if (
      process.env.ALLRICE_LOCAL_BROWSER_ENABLED !== '1' ||
      w.target_kind !== 'rice_bridge' ||
      w.task_id !== null
    )
      throw new RuntimePolicyError('browser_authority_unavailable');
    const [local] = await tx<
      { device_id: string }[]
    >`select l.device_id from allrice_local_browser_workspaces l
      join allrice_local_browser_grants g on g.grant_id=l.grant_id and g.device_id=l.device_id
        and g.organization_id=l.organization_id and g.workspace_id=l.workspace_id and g.owner_id=l.owner_id
      join allrice_bridge_devices d on d.id=l.device_id and d.organization_id=l.organization_id and d.workspace_id=l.workspace_id and d.owner_id=l.owner_id
      join allrice_execution_targets t on t.id=${w.target_id} and t.target_key='bridge.'||d.id::text and t.metadata->>'bridgeDeviceId'=d.id::text
      where l.browser_workspace_id=${w.id} and l.organization_id=${w.organization_id} and l.workspace_id=${w.workspace_id}
        and l.owner_id=${w.owner_id} and l.grant_id=${w.grant_id} and l.released_at is null and g.cleanup_requested_at is null
        and d.revoked_at is null and d.last_seen_at>clock_timestamp()-interval '90 seconds'
        and ((l.controller_lease_token is null and ${w.state}='starting') or l.lease_expires_at>clock_timestamp())
      for share of l,g,d`;
    if (!local) throw new RuntimePolicyError('browser_authority_unavailable');
    w.device_id = local.device_id;
  } else {
    if (
      w.target_kind !== 'cloud_sandbox' ||
      !w.target_capabilities.includes('browser.navigate') ||
      !w.task_id
    )
      throw new RuntimePolicyError('browser_authority_unavailable');
    const [task] = await tx`select id from allrice_managed_browser_tasks
      where id=${w.task_id} and job_id=${w.job_id} and job_attempt=${w.job_attempt} and run_id=${w.run_id}
        and status='running' and cancel_requested_at is null for share`;
    if (!task) throw new RuntimePolicyError('browser_authority_unavailable');
  }
  w.profile = BrowserProfileSchema.parse(w.profile);
  w.observation = w.observation
    ? BrowserObservationSchema.parse(w.observation)
    : null;
  return w;
}
/** Grant-before-workspace matches revocation and prevents a control/heartbeat
 * transaction from deadlocking against a concurrent grant withdrawal. */
export async function lockBrowserWorkspaceGrant(
  tx: postgres.TransactionSql,
  ctx: RuntimePolicyPrincipal,
  id: string,
) {
  await tx`select g.id from allrice_browser_control_grants g join allrice_browser_workspaces w on w.grant_id=g.id
    where w.id=${id} and w.organization_id=${ctx.organizationId} and w.workspace_id=${ctx.workspaceId} and w.owner_id=${ctx.actor.id}
      and g.organization_id=w.organization_id and g.workspace_id=w.workspace_id and g.owner_id=w.owner_id for share of g`;
  // Short local-controller requests may publish/ACK after admission. Serialize
  // them before taking shared input locks, avoiding lock-upgrade deadlocks.
  await tx`select id from allrice_browser_workspaces where id=${id} and organization_id=${ctx.organizationId}
    and workspace_id=${ctx.workspaceId} and owner_id=${ctx.actor.id} and transport='local' for update`;
}
export function browserCommandBinding(
  payload: unknown,
  profile: BrowserProfile,
  transport: 'cloud' | 'local' = 'cloud',
) {
  return {
    executableDigest: digest(
      transport === 'local'
        ? 'local-browser-control-v1'
        : 'managed-browser-control-v1',
    ),
    argumentsDigest: digest(payload),
    workingDirectoryDigest: digest(
      transport === 'local'
        ? 'device-owned-dedicated-browser-profile'
        : 'isolated-temporary-browser-profile',
    ),
    effectiveEnvironmentDigest: digest('no-imported-cookies'),
    networkPolicyDigest: digest(profile.origins),
    toolchainDigest: digest(
      transport === 'local'
        ? 'local-chromium-pinned-proxy-v1'
        : 'managed-chromium-pinned-proxy-v1',
    ),
    budgetDigest: digest({
      timeoutMs: profile.lifetimeMs,
      maximumFileBytes: profile.maximumFileBytes,
    }),
  };
}
export async function checkBrowserBindingAuthority(
  tx: postgres.TransactionSql,
  ctx: RuntimePolicyPrincipal,
  binding: RuntimeActionBinding,
) {
  const [stored] = await tx<
    {
      binding: unknown;
      payload: unknown;
      browser_workspace_id: string;
      observation: unknown;
    }[]
  >`
    select binding,payload,browser_workspace_id,observation from allrice_browser_operation_inputs where operation_id=${binding.attempt.operationId}`;
  if (
    !stored ||
    !runtimeContractEqual(
      RuntimeActionBindingSchema.parse(stored.binding),
      binding,
    )
  )
    throw new RuntimePolicyError('browser_input_changed');
  const payload = BrowserCommandSchema.parse(stored.payload),
    w = await currentBrowserWorkspace(tx, ctx, stored.browser_workspace_id);
  if (
    payload.workspaceId !== w.id ||
    payload.profileId !== w.profile_id ||
    payload.fence !== w.control_fence ||
    w.acknowledged_fence !== w.control_fence ||
    w.state !== payload.actor ||
    binding.execution.targetKind !==
      (w.transport === 'local' ? 'rice_bridge' : 'cloud_sandbox') ||
    binding.execution.deviceId !== w.device_id ||
    binding.execution.targetId !== w.target_id ||
    binding.execution.grantId !== w.grant_id ||
    binding.execution.grantVersion !== w.grant_version ||
    binding.execution.scopeDigest !== digest(w.profile) ||
    binding.execution.workCopy.id !== w.profile_id ||
    binding.execution.workCopy.kind !==
      (w.transport === 'local' ? 'local_copy' : 'cloud_copy') ||
    binding.task.runId !== w.run_id ||
    binding.task.chatSessionId !== w.session_id ||
    binding.task.scope.organizationId !== w.organization_id ||
    binding.task.scope.workspaceId !== w.workspace_id ||
    binding.requestedBy.id !== w.owner_id ||
    binding.requestedBy.type !== 'user' ||
    binding.policy.snapshotId !== w.policy_snapshot_id ||
    binding.policy.digest !== digest(w.policy_payload) ||
    binding.task.frozenConfiguration.digest !== digest(w.execution_spec) ||
    binding.task.frozenConfiguration.employeeVersionId !==
      w.employee_version_id ||
    binding.attempt.generation !== w.thread_generation ||
    binding.attempt.fence !== 1 ||
    binding.inputDigest !== digest(payload) ||
    !runtimeContractEqual(
      binding.command,
      browserCommandBinding(payload, w.profile, w.transport),
    )
  )
    throw new RuntimePolicyError('browser_control_changed');
  const action = payload.action;
  if (
    binding.action !==
    (w.transport === 'local'
      ? action.type === 'observe'
        ? 'local.browser.observe'
        : 'local.browser.act'
      : action.type === 'observe'
        ? 'cloud.browser.observe'
        : 'cloud.browser.act')
  )
    throw new RuntimePolicyError('browser_action_changed');
  if (
    action.type !== 'observe' &&
    action.type !== 'navigate' &&
    action.type !== 'request'
  ) {
    const obs = w.observation;
    if (
      !obs ||
      payload.observationId !== obs.id ||
      !runtimeContractEqual(stored.observation, obs) ||
      !browserObservationCurrent(obs, {
        profileId: w.profile_id,
        fence: w.control_fence,
        now: w.clock.getTime(),
      })
    )
      throw new RuntimePolicyError('browser_observation_stale');
    const element = obs.elements.find((e) => e.id === action.elementId);
    if (
      !element ||
      (element.sensitive &&
        action.type !== 'sensitive_fill' &&
        action.type !== 'click')
    )
      throw new RuntimePolicyError('browser_element_denied');
  }
  if (
    (action.type === 'navigate' || action.type === 'request') &&
    !browserOriginAllowed(action.url, w.profile)
  )
    throw new RuntimePolicyError('browser_origin_denied');
  if (
    action.type === 'sensitive_fill' &&
    (payload.actor !== 'human' || !w.profile.allowHumanCredentials)
  )
    throw new RuntimePolicyError('browser_sensitive_input_denied');
  if (action.type === 'download' && !w.profile.allowDownloads)
    throw new RuntimePolicyError('browser_download_denied');
  if (action.type === 'upload' && !w.profile.allowUploads)
    throw new RuntimePolicyError('browser_upload_denied');
  if (
    action.type !== 'upload' &&
    (binding.baseline.length || binding.dataScope.length)
  )
    throw new RuntimePolicyError('browser_data_scope_changed');
  if (action.type === 'upload') {
    const content = {
      kind: 'storage_object',
      id: action.objectId,
      checksum: action.checksum,
    };
    if (
      !runtimeContractEqual(binding.baseline, [content]) ||
      !runtimeContractEqual(binding.dataScope, [
        {
          content,
          sourceTargetId: null,
          purpose: 'execution_input',
          destination:
            w.transport === 'local' ? 'local_write' : 'cloud_execution',
          authorizationId: binding.attempt.operationId,
          authorizationVersion: 1,
        },
      ])
    )
      throw new RuntimePolicyError('browser_upload_scope_changed');
    const [file] =
      await tx`select id from allrice_storage_objects where id=${action.objectId} and organization_id=${w.organization_id}
      and workspace_id=${w.workspace_id} and owner_id=${w.owner_id} and checksum=${action.checksum} and deleted_at is null
      and size_bytes<=${w.profile.maximumFileBytes} for share`;
    if (!file) throw new RuntimePolicyError('browser_upload_unavailable');
  }
  if (action.type === 'request') {
    const [parent] =
      await tx`select o.id from allrice_runtime_operations o join allrice_browser_operation_inputs i on i.operation_id=o.id
      where o.id=${action.parentOperationId} and i.browser_workspace_id=${w.id} and o.snapshot->>'status'='running'
      and i.payload->>'actor'=${payload.actor} and (i.payload->>'fence')::integer=${payload.fence} for share of o,i`;
    if (!parent)
      throw new RuntimePolicyError('browser_request_parent_unavailable');
  }
  return { binding, payload, workspace: w };
}
export async function readCurrentBrowserWorkspace(
  ctx: RuntimePolicyPrincipal,
  id: string,
  database = getDatabase(),
) {
  return database.begin((tx) => currentBrowserWorkspace(tx, ctx, id));
}
