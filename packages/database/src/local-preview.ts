import { randomUUID } from 'node:crypto';
import {
  BrowserProfileSchema,
  ExecutionContextSchema,
  LocalPreviewTargetSchema,
  UuidSchema,
  localPreviewOrigin,
  type ExecutionContext,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import {
  browserIdentity,
  readCurrentBrowserWorkspace,
} from './browser-control-authority.ts';
import { browserPrincipal, createBrowserOperation } from './browser-control.ts';
import {
  currentLocalPreviewService,
  localPreviewEnabled,
} from './local-preview-authority.ts';
import { cloudStableId } from './cloud-execution.ts';
import {
  RuntimePolicyError,
  runtimePolicyDigest as digest,
  type RuntimePolicyPrincipal,
} from './runtime-policy.ts';

export async function createLocalPreviewWorkspace(
  input: {
    context: ExecutionContext;
    processId: string;
    jobAttempt: number;
    jobLeaseToken: string;
  },
  db = getDatabase(),
) {
  const processId = UuidSchema.parse(input.processId),
    ctx = browserPrincipal(input.context);
  const endpointId = cloudStableId(`local-preview:${processId}`),
    workspaceId = cloudStableId(`local-preview-browser:${processId}`),
    grantId = cloudStableId(`local-preview-grant:${processId}`);
  await db.begin(async (tx) => {
    await browserIdentity(tx, ctx);
    await tx`select pg_advisory_xact_lock(hashtextextended(${processId},911))`;
    const s = await currentLocalPreviewService(tx, {
      principal: ctx,
      processId,
      context: input.context,
    });
    if (
      s.job_attempt !== input.jobAttempt ||
      s.job_lease_token !== input.jobLeaseToken
    )
      throw new RuntimePolicyError('local_preview_job_changed');
    const [prior] =
      await tx`select id from allrice_local_preview_endpoints where id=${endpointId}`;
    if (prior) return; // Neither recreate closed/unknown browsers nor repeat navigation.
    const b = s.snapshot.binding,
      profileId = randomUUID();
    const target = LocalPreviewTargetSchema.parse({
      version: 1,
      endpointId,
      scope: b.task.scope,
      ownerId: b.requestedBy.id,
      deviceId: s.device.id,
      runId: b.task.runId,
      rootRunId: b.task.rootRunId,
      browserWorkspaceId: workspaceId,
      browserProfileId: profileId,
      browserGrantId: grantId,
      processId,
      attemptId: b.attempt.attemptId,
      generation: b.attempt.generation,
      fence: b.attempt.fence,
      processInputDigest: b.inputDigest,
      folderGrantId: b.execution.grantId,
      folderGrantVersion: b.execution.grantVersion,
      containerId: s.container_id,
      imageDigest: s.command.arguments.imageDigest,
      port: s.command.arguments.background!.readiness.port,
      hardDeadlineAt: s.hard_deadline_at.toISOString(),
    });
    const profile = BrowserProfileSchema.parse({
      version: 1,
      origins: [localPreviewOrigin(endpointId)],
      allowUploads: false,
      allowDownloads: false,
      allowHumanCredentials: false,
      lifetimeMs: Math.max(
        10000,
        Math.min(300000, s.hard_deadline_at.getTime() - s.clock.getTime()),
      ),
    });
    const expiresAt = new Date(
      Math.min(
        s.hard_deadline_at.getTime(),
        s.clock.getTime() + profile.lifetimeMs,
      ),
    );
    await tx`insert into allrice_browser_control_grants(id,organization_id,workspace_id,owner_id,target_id,version,profile,enabled,transport)
      values(${grantId},${ctx.organizationId},${ctx.workspaceId},${ctx.actor.id},${b.execution.targetId},1,${tx.json(profile)},true,'local')`;
    await tx`insert into allrice_local_browser_grants(grant_id,organization_id,workspace_id,owner_id,device_id,logical_profile_id,persist_login,purpose)
      values(${grantId},${ctx.organizationId},${ctx.workspaceId},${ctx.actor.id},${s.device.id},${randomUUID()},false,'local_preview')`;
    await tx`insert into allrice_browser_workspaces(id,organization_id,workspace_id,owner_id,run_id,session_id,job_id,worker_id,job_lease_token,job_attempt,
      task_id,grant_id,grant_version,profile_id,profile,execution_context,expires_at,transport)
      values(${workspaceId},${ctx.organizationId},${ctx.workspaceId},${ctx.actor.id},${b.task.runId},${s.session_id},${s.job_id},${s.worker_id},
        ${s.job_lease_token},${s.job_attempt},null,${grantId},1,${profileId},${tx.json(profile)},${tx.json(input.context as never)},${expiresAt},'local')`;
    await tx`insert into allrice_local_browser_workspaces(browser_workspace_id,organization_id,workspace_id,owner_id,device_id,grant_id,request_digest)
      values(${workspaceId},${ctx.organizationId},${ctx.workspaceId},${ctx.actor.id},${s.device.id},${grantId},${digest(target)})`;
    await tx`insert into allrice_local_preview_endpoints(id,organization_id,workspace_id,owner_id,device_id,run_id,process_id,browser_workspace_id,browser_grant_id,endpoint_lease_id,target)
      values(${endpointId},${ctx.organizationId},${ctx.workspaceId},${ctx.actor.id},${s.device.id},${b.task.runId},${processId},${workspaceId},${grantId},${randomUUID()},${tx.json(target)})`;
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
      values(${ctx.organizationId},${ctx.workspaceId},${ctx.actor.id},'local.preview.created','browser_workspace',${workspaceId},'recorded','derived_from_approved_live_service',
        ${tx.json({ processId, endpointId, targetDigest: digest(target) })})`;
  });
  return readCurrentBrowserWorkspace(ctx, workspaceId, db);
}

export type LocalPreviewSummary = {
  workspaceId: string;
  endpointId: string;
  previewUrl: string;
  pending: boolean;
  operationId?: string;
};
export async function requestLocalPreviewNavigation(
  ctx: RuntimePolicyPrincipal,
  workspaceId: string,
  db = getDatabase(),
): Promise<LocalPreviewSummary> {
  const w = await readCurrentBrowserWorkspace(ctx, workspaceId, db);
  if (!w.preview) throw new RuntimePolicyError('local_preview_not_owned');
  const endpointId = w.preview.target.endpointId,
    previewUrl = localPreviewOrigin(endpointId);
  const summary = { workspaceId, endpointId, previewUrl };
  const requestId = cloudStableId(`local-preview-navigation:${endpointId}`),
    operationId = cloudStableId(
      `browser-operation:${workspaceId}:${requestId}`,
    );
  const [prior] = await db<
    {
      payload: unknown;
      operation_id: string | null;
      status: string | null;
      approval_id: string | null;
    }[]
  >`select i.payload,o.id as operation_id,o.snapshot->>'status' as status,a.id as approval_id
    from allrice_browser_operation_inputs i left join allrice_runtime_operations o on o.id=i.operation_id
    left join allrice_approval_requests a on a.resource_id=o.id and a.resource_type='runtime_operation' and a.organization_id=o.organization_id and a.workspace_id=o.workspace_id and a.actor_id=${ctx.actor.id}
    where i.operation_id=${operationId} and i.browser_workspace_id=${workspaceId}`;
  if (
    prior?.operation_id &&
    (prior.status !== 'waiting_user' || prior.approval_id)
  )
    return { ...summary, pending: false, operationId };
  if (w.state !== 'agent' || w.acknowledged_fence !== w.control_fence)
    return { ...summary, pending: true };
  const op = await createBrowserOperation(
    ctx,
    prior?.payload ?? {
      version: 1,
      workspaceId,
      profileId: w.profile_id,
      actor: 'agent',
      fence: w.control_fence,
      observationId: null,
      action: { type: 'navigate', url: previewUrl },
    },
    requestId,
    db,
  );
  return {
    ...summary,
    pending: false,
    operationId: op.snapshot.binding.attempt.operationId,
  };
}

/** An HTTP user supplies a process identity, never a Worker identity or token.
 * Current tenant ownership, frozen native tool and all existing service gates
 * are identical to the Worker entry above. */
export async function requestLocalPreviewFromUser(
  ctx: RequestContext,
  processId: string,
  db = getDatabase(),
) {
  if (!localPreviewEnabled())
    throw new RuntimePolicyError('local_preview_disabled');
  const derived = await db.begin(async (tx) => {
    await browserIdentity(tx, ctx);
    const [row] = await tx<
      {
        run_id: string;
        job_id: string;
        worker_id: string;
        lease_token: string;
        attempt: number;
        started_at: Date;
        policy_id: string;
        policy_version: number;
        policy_payload: Record<string, unknown>;
        policy_created: Date;
        policy_expires: Date;
      }[]
    >`
      select r.id as run_id,j.id as job_id,j.worker_id,j.lease_token,j.attempt,j.claimed_at as started_at,
      p.id as policy_id,p.version as policy_version,p.payload as policy_payload,p.issued_at as policy_created,p.expires_at as policy_expires
      from allrice_runtime_operations op join allrice_runs r on r.id=op.run_id and r.organization_id=op.organization_id and r.workspace_id=op.workspace_id
      join allrice_jobs j on j.run_id=r.id and j.organization_id=r.organization_id and j.workspace_id=r.workspace_id and j.owner_id=r.owner_id
      join allrice_policy_snapshots p on p.id=r.policy_snapshot_id and p.organization_id=r.organization_id and p.subject_id=r.owner_id
      where op.id=${UuidSchema.parse(processId)} and r.organization_id=${ctx.organizationId} and r.workspace_id=${ctx.workspaceId} and r.owner_id=${ctx.actor.id}
      and r.state='running' and j.status='running' and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp() and j.cancel_requested_at is null`;
    if (!row) throw new RuntimePolicyError('local_preview_not_owned');
    return {
      context: ExecutionContextSchema.parse({
        executionId: randomUUID(),
        runId: row.run_id,
        jobId: row.job_id,
        worker: { type: 'worker', id: row.worker_id },
        delegatedBy: ctx.actor,
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        policySnapshot: {
          ...row.policy_payload,
          id: row.policy_id,
          organizationId: ctx.organizationId,
          subjectId: ctx.actor.id,
          version: row.policy_version,
          issuedAt: row.policy_created.toISOString(),
          expiresAt: row.policy_expires.toISOString(),
        },
        startedAt: row.started_at.toISOString(),
      }),
      processId,
      jobAttempt: row.attempt,
      jobLeaseToken: row.lease_token,
    };
  });
  const w = await createLocalPreviewWorkspace(derived, db);
  return requestLocalPreviewNavigation(ctx, w.id, db);
}

export async function readLocalPreviewSummary(
  processId: string,
  db = getDatabase(),
): Promise<LocalPreviewSummary | null> {
  const [e] = await db<
    { id: string; browser_workspace_id: string; owner_id: string }[]
  >`select id,browser_workspace_id,owner_id from allrice_local_preview_endpoints where process_id=${processId}`;
  if (!e) return null;
  const operationId = cloudStableId(
    `browser-operation:${e.browser_workspace_id}:${cloudStableId(`local-preview-navigation:${e.id}`)}`,
  );
  const [op] =
    await db`select o.id,o.snapshot->>'status' as status,a.id as approval_id
    from allrice_runtime_operations o left join allrice_approval_requests a
      on a.resource_id=o.id and a.resource_type='runtime_operation'
      and a.organization_id=o.organization_id and a.workspace_id=o.workspace_id
      and a.actor_id=${e.owner_id}
    where o.id=${operationId}`;
  const pending = !op || (op.status === 'waiting_user' && !op.approval_id);
  return {
    workspaceId: e.browser_workspace_id,
    endpointId: e.id,
    previewUrl: localPreviewOrigin(e.id),
    pending,
    ...(!pending ? { operationId } : {}),
  };
}
