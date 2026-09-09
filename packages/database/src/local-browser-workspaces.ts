import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  BrowserProfileSchema,
  BrowserUrlSchema,
  LocalBrowserClaimSchema,
  LocalBrowserWorkspaceSchema,
  LocalBrowserHeartbeatSchema,
  UuidSchema,
  localBrowserControllerLeaseMs,
  type BridgeDevice,
  type ExecutionContext,
  type LocalBrowserWorkspace,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import {
  browserIdentity,
  currentBrowserWorkspace,
  lockBrowserWorkspaceGrant,
  type BrowserWorkspaceRow,
} from './browser-control-authority.ts';
import { browserPrincipal } from './browser-control.ts';
import { cloudStableId } from './cloud-execution.ts';
import {
  RuntimePolicyError,
  runtimePolicyDigest as digest,
} from './runtime-policy.ts';
import {
  assertCurrentLocalBrowserDevice,
  localBrowserEnabled,
  localBrowserPrincipal,
  pendingLocalBrowserRevocations,
} from './local-browser-grants.ts';

export type LocalControllerIdentity = {
  workspaceId: string;
  controllerLeaseToken: string;
};
export type LocalWorkspaceRow = {
  browser_workspace_id: string;
  device_id: string;
  grant_id: string;
  controller_id: string | null;
  controller_lease_token: string | null;
  lease_expires_at: Date | null;
  released_at: Date | null;
  logical_profile_id: string;
  persist_login: boolean;
};

export async function createLocalBrowserWorkspace(
  input: {
    context: ExecutionContext;
    callId: string;
    grantId: string;
    url: string;
    jobAttempt: number;
    jobLeaseToken: string;
  },
  db = getDatabase(),
) {
  if (!localBrowserEnabled())
    throw new RuntimePolicyError('local_browser_disabled');
  const ctx = browserPrincipal(input.context),
    id = cloudStableId(`local-browser:${input.context.runId}:${input.callId}`);
  const url = BrowserUrlSchema.parse(input.url),
    grantId = UuidSchema.parse(input.grantId);
  if (!input.callId || input.callId.length > 255)
    throw new RuntimePolicyError('invalid_tool_call');
  const requestDigest = digest({
    runId: input.context.runId,
    jobId: input.context.jobId,
    callId: input.callId,
    grantId,
    url,
  });
  await db.begin(async (tx) => {
    await browserIdentity(tx, ctx);
    const [prior] =
      await tx`select request_digest from allrice_local_browser_workspaces where browser_workspace_id=${id}
      and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId} and owner_id=${ctx.actor.id}`;
    if (prior) {
      if (prior.request_digest !== requestDigest)
        throw new RuntimePolicyError('idempotency_conflict');
      return;
    }
    const [run] = await tx<
      { session_id: string; timeout_at: Date }[]
    >`select e.session_id,j.timeout_at from allrice_employee_runs e
      join allrice_runs r on r.id=e.run_id and r.organization_id=e.organization_id and r.workspace_id=e.workspace_id and r.owner_id=e.owner_id
      join allrice_conversation_runtimes c on c.session_id=e.session_id and c.organization_id=e.organization_id and c.workspace_id=e.workspace_id and c.owner_id=e.owner_id
      join allrice_jobs j on j.id=${input.context.jobId} and j.run_id=e.run_id and j.organization_id=e.organization_id and j.workspace_id=e.workspace_id and j.owner_id=e.owner_id
      join allrice_employee_assignments a on a.id=e.employee_assignment_id and a.organization_id=e.organization_id and a.workspace_id=e.workspace_id and a.user_id=e.owner_id
      where e.run_id=${input.context.runId} and e.organization_id=${ctx.organizationId} and e.workspace_id=${ctx.workspaceId} and e.owner_id=${ctx.actor.id}
        and r.state='running' and r.policy_snapshot_id=${input.context.policySnapshot.id} and c.active_run_id=r.id and c.state='running'
        and a.active and a.employee_version_id=e.employee_version_id
        and j.status='running' and j.worker_id=${input.context.worker.id} and j.lease_token=${input.jobLeaseToken} and j.attempt=${input.jobAttempt}
        and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp() and j.cancel_requested_at is null
        and e.execution_snapshot->'capabilitySnapshot'->'bindings'->'toolNames' ? 'local.browser.workspace'
        and e.execution_snapshot->'capabilitySnapshot'->'grantedCapabilities' ? 'network:outbound'
      for share of e,r,c,j,a`;
    if (!run)
      throw new RuntimePolicyError('local_browser_frozen_authority_denied');
    const [grant] = await tx<
      { version: number; profile: unknown; device_id: string }[]
    >`select g.version,g.profile,l.device_id
      from allrice_browser_control_grants g join allrice_local_browser_grants l on l.grant_id=g.id
        and l.organization_id=g.organization_id and l.workspace_id=g.workspace_id and l.owner_id=g.owner_id
      join allrice_bridge_devices d on d.id=l.device_id and d.organization_id=l.organization_id and d.workspace_id=l.workspace_id and d.owner_id=l.owner_id
      join allrice_execution_targets t on t.id=g.target_id and t.organization_id=g.organization_id and t.workspace_id=g.workspace_id
      where g.id=${grantId} and g.organization_id=${ctx.organizationId} and g.workspace_id=${ctx.workspaceId} and g.owner_id=${ctx.actor.id}
        and g.enabled and g.revoked_at is null and g.transport='local' and l.cleanup_requested_at is null and l.purpose='public'
        and d.revoked_at is null and d.last_seen_at>clock_timestamp()-interval '90 seconds'
        and t.kind='rice_bridge' and t.state='online' and t.target_key='bridge.'||d.id::text
      for update of g,l`;
    if (!grant) throw new RuntimePolicyError('local_browser_grant_denied');
    const profile = BrowserProfileSchema.parse(grant.profile);
    if (!profile.origins.includes(new URL(url).origin))
      throw new RuntimePolicyError('browser_origin_denied');
    const [busy] =
      await tx`select browser_workspace_id from allrice_local_browser_workspaces where grant_id=${grantId} and released_at is null limit 1`;
    if (busy) throw new RuntimePolicyError('local_browser_profile_busy');
    await tx`insert into allrice_browser_workspaces(id,organization_id,workspace_id,owner_id,run_id,session_id,job_id,worker_id,job_lease_token,job_attempt,
      task_id,grant_id,grant_version,profile_id,profile,execution_context,expires_at,transport)
      values(${id},${ctx.organizationId},${ctx.workspaceId},${ctx.actor.id},${input.context.runId},${run.session_id},${input.context.jobId},${input.context.worker.id},
        ${input.jobLeaseToken},${input.jobAttempt},null,${grantId},${grant.version},${randomUUID()},${tx.json(profile)},${tx.json(input.context as never)},
        least(${run.timeout_at},clock_timestamp()+${profile.lifetimeMs}*interval '1 millisecond'),'local')`;
    await tx`insert into allrice_local_browser_workspaces(browser_workspace_id,organization_id,workspace_id,owner_id,device_id,grant_id,request_digest)
      values(${id},${ctx.organizationId},${ctx.workspaceId},${ctx.actor.id},${grant.device_id},${grantId},${requestDigest})`;
    await currentBrowserWorkspace(tx, ctx, id);
  });
  return db.begin((tx) => currentBrowserWorkspace(tx, ctx, id));
}

/** Common lock order is browser workspace first, local controller second. */
export async function lockLocalBrowserController(
  tx: postgres.TransactionSql,
  device: BridgeDevice,
  input: LocalControllerIdentity,
  admit = true,
): Promise<{ local: LocalWorkspaceRow; workspace: BrowserWorkspaceRow }> {
  await assertCurrentLocalBrowserDevice(tx, device, admit);
  await lockBrowserWorkspaceGrant(
    tx,
    localBrowserPrincipal(device),
    UuidSchema.parse(input.workspaceId),
  );
  const [w] = await tx<
    BrowserWorkspaceRow[]
  >`select w.* from allrice_browser_workspaces w
    where w.id=${UuidSchema.parse(input.workspaceId)} and w.organization_id=${device.organizationId} and w.workspace_id=${device.workspaceId}
      and w.owner_id=${device.ownerId} and w.transport='local' for update`;
  const [local] = await tx<
    LocalWorkspaceRow[]
  >`select l.*,g.logical_profile_id,g.persist_login from allrice_local_browser_workspaces l
    join allrice_local_browser_grants g on g.grant_id=l.grant_id
    where l.browser_workspace_id=${input.workspaceId} and l.organization_id=${device.organizationId} and l.workspace_id=${device.workspaceId}
      and l.owner_id=${device.ownerId} and l.device_id=${device.id} and l.controller_lease_token=${UuidSchema.parse(input.controllerLeaseToken)} for share of l,g`;
  if (!w || !local)
    throw new RuntimePolicyError('local_browser_controller_denied');
  if (!admit) return { local, workspace: w };
  const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
  if (
    !local.lease_expires_at ||
    local.lease_expires_at <= clock!.now ||
    local.released_at
  )
    throw new RuntimePolicyError('local_browser_lease_lost');
  return {
    local,
    workspace: await currentBrowserWorkspace(
      tx,
      localBrowserPrincipal(device),
      w.id,
    ),
  };
}

function publicWorkspace(
  w: BrowserWorkspaceRow,
  local: Pick<
    LocalWorkspaceRow,
    'logical_profile_id' | 'persist_login' | 'device_id'
  >,
  revoked = false,
): LocalBrowserWorkspace {
  return LocalBrowserWorkspaceSchema.parse({
    id: w.id,
    scope: {
      organizationId: w.organization_id,
      workspaceId: w.workspace_id,
      projectId: null,
    },
    ownerId: w.owner_id,
    deviceId: local.device_id,
    runId: w.run_id,
    rootRunId: w.run_id,
    sessionId: w.session_id,
    profileId: w.profile_id,
    logicalProfileId: local.logical_profile_id,
    grantId: w.grant_id,
    grantRevision: w.grant_version,
    persistLogin: local.persist_login,
    profile: w.profile,
    fence: w.control_fence,
    acknowledgedFence: w.acknowledged_fence,
    state: w.state,
    desiredControl: w.desired_control,
    expiresAt: w.expires_at.toISOString(),
    revoked,
    ...(w.preview && !revoked ? { preview: w.preview } : {}),
  });
}

export async function claimLocalBrowserWorkspace(
  device: BridgeDevice,
  controllerId: string,
  acceptWork: boolean,
  db = getDatabase(),
  acceptPreview = false,
) {
  const revocations = await pendingLocalBrowserRevocations(device, db);
  if (!localBrowserEnabled() || !acceptWork)
    return LocalBrowserClaimSchema.parse({
      lease: null,
      workspace: null,
      revocations,
    });
  const selected = await db.begin(async (tx) => {
    await assertCurrentLocalBrowserDevice(tx, device);
    const rows = await tx<
      (LocalWorkspaceRow & { id: string })[]
    >`select l.*,w.id,g.logical_profile_id,g.persist_login
      from allrice_browser_workspaces w join allrice_local_browser_workspaces l on l.browser_workspace_id=w.id
      join allrice_local_browser_grants g on g.grant_id=l.grant_id
      where l.device_id=${device.id} and l.organization_id=${device.organizationId} and l.workspace_id=${device.workspaceId} and l.owner_id=${device.ownerId}
        and (g.purpose='public' or (${acceptPreview} and g.purpose='local_preview'))
        and l.released_at is null and w.expires_at>clock_timestamp() and w.state not in ('closed','unknown','close_pending')
        and ((l.controller_lease_token is null and w.state='starting') or (l.controller_id=${UuidSchema.parse(controllerId)} and l.lease_expires_at>clock_timestamp()))
      order by w.created_at limit 8`;
    for (const candidate of rows) {
      await lockBrowserWorkspaceGrant(
        tx,
        localBrowserPrincipal(device),
        candidate.id,
      );
      const [local] = await tx<
        (LocalWorkspaceRow & { id: string })[]
      >`select l.*,w.id,g.logical_profile_id,g.persist_login
        from allrice_browser_workspaces w join allrice_local_browser_workspaces l on l.browser_workspace_id=w.id
        join allrice_local_browser_grants g on g.grant_id=l.grant_id where w.id=${candidate.id} and l.device_id=${device.id}
          and l.released_at is null and w.state not in ('closed','unknown','close_pending')
          and ((l.controller_lease_token is null and w.state='starting') or (l.controller_id=${controllerId} and l.lease_expires_at>clock_timestamp()))
        for update of w,l skip locked`;
      if (!local) continue;
      let w: BrowserWorkspaceRow;
      try {
        w = await currentBrowserWorkspace(
          tx,
          localBrowserPrincipal(device),
          local.id,
        );
      } catch (error) {
        if (
          error instanceof RuntimePolicyError &&
          error.code === 'browser_authority_unavailable'
        )
          continue;
        throw error;
      }
      const token = local.controller_lease_token ?? randomUUID();
      const [lease] = await tx<
        { lease_expires_at: Date }[]
      >`update allrice_local_browser_workspaces
        set controller_id=coalesce(controller_id,${controllerId}),controller_lease_token=coalesce(controller_lease_token,${token}),
          claimed_at=coalesce(claimed_at,clock_timestamp()),lease_expires_at=least(${w.expires_at},clock_timestamp()+${localBrowserControllerLeaseMs}*interval '1 millisecond')
        where browser_workspace_id=${w.id} returning lease_expires_at`;
      return {
        workspace: publicWorkspace(w, local),
        lease: {
          workspaceId: w.id,
          token,
          expiresAt: lease!.lease_expires_at.toISOString(),
        },
      };
    }
    return { workspace: null, lease: null };
  });
  return LocalBrowserClaimSchema.parse({ ...selected, revocations });
}

export async function heartbeatLocalBrowserWorkspace(
  device: BridgeDevice,
  input: LocalControllerIdentity,
  db = getDatabase(),
) {
  return db.begin(async (tx) => {
    const { local, workspace: raw } = await lockLocalBrowserController(
      tx,
      device,
      input,
      false,
    );
    let w: BrowserWorkspaceRow;
    try {
      if (!localBrowserEnabled())
        throw new RuntimePolicyError('browser_authority_unavailable');
      w = await currentBrowserWorkspace(
        tx,
        localBrowserPrincipal(device),
        input.workspaceId,
      );
    } catch (error) {
      if (!(error instanceof RuntimePolicyError)) throw error;
      // Cleanup/fact delivery survives feature-off, revocation and Run end.
      return LocalBrowserHeartbeatSchema.parse({
        workspace: publicWorkspace(
          { ...raw, desired_control: 'closed' },
          local,
          true,
        ),
        lease: {
          workspaceId: input.workspaceId,
          token: input.controllerLeaseToken,
          expiresAt: (local.lease_expires_at ?? new Date(0)).toISOString(),
        },
      });
    }
    const [updated] = await tx<
      { lease_expires_at: Date }[]
    >`update allrice_local_browser_workspaces
      set lease_expires_at=least(${w.expires_at},clock_timestamp()+${localBrowserControllerLeaseMs}*interval '1 millisecond')
      where browser_workspace_id=${w.id} and controller_lease_token=${input.controllerLeaseToken} and lease_expires_at>clock_timestamp() and released_at is null
      returning lease_expires_at`;
    if (!updated) throw new RuntimePolicyError('local_browser_lease_lost');
    await tx`update allrice_browser_workspaces set last_heartbeat_at=clock_timestamp() where id=${w.id}`;
    return LocalBrowserHeartbeatSchema.parse({
      workspace: publicWorkspace(w, local),
      lease: {
        workspaceId: w.id,
        token: input.controllerLeaseToken,
        expiresAt: updated.lease_expires_at.toISOString(),
      },
    });
  });
}

export async function recordLocalBrowserStopped(
  device: BridgeDevice,
  input: LocalControllerIdentity & { confirmed: boolean },
  db = getDatabase(),
) {
  return db.begin(async (tx) => {
    const { workspace: w } = await lockLocalBrowserController(
      tx,
      device,
      input,
      false,
    );
    // Only confirmed physical close releases the logical profile. Unknown may
    // later become closed when the exact original controller reconciles it.
    if (w.state === 'closed') return { confirmed: true };
    await tx`update allrice_browser_workspaces set state=${input.confirmed ? 'closed' : 'unknown'},desired_control='closed',control_fence=control_fence+1,
      stopped_at=case when ${input.confirmed} then clock_timestamp() else null end where id=${w.id}`;
    if (input.confirmed)
      await tx`update allrice_local_browser_workspaces set released_at=coalesce(released_at,clock_timestamp()) where browser_workspace_id=${w.id}`;
    await tx`update allrice_browser_direct_inputs set envelope=null,consumed_at=coalesce(consumed_at,clock_timestamp()) where browser_workspace_id=${w.id}`;
    return { confirmed: input.confirmed };
  });
}
