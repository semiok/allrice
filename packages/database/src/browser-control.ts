import { randomUUID } from 'node:crypto';
import {
  BrowserCommandSchema,
  BrowserControlRequestSchema,
  BrowserObservationSchema,
  browserObservationIsFresh,
  BrowserProfileSchema,
  browserOriginAllowed,
  LocalPreviewTargetSchema,
  localPreviewOrigin,
  RuntimeActionBindingSchema,
  RuntimeOperationSnapshotSchema,
  RuntimeActionApprovalSnapshotSchema,
  UuidSchema,
  runtimeContractEqual,
  type BrowserCommand,
  type BrowserObservation,
  type BrowserProfile,
  type ExecutionContext,
  type RequestContext,
  type RuntimeActionBinding,
  type RuntimeActionApprovalSnapshot,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import {
  requireTenantManagementScope,
  type TenantManagementOptions,
} from './tenant-management-scope.ts';
import { browserGrantOriginDenial } from './browser-control-origin.ts';
import {
  createManagedBrowserTask,
  startManagedBrowserTask,
} from './execution/p1-runtime.ts';
import {
  browserControlEnabled,
  browserIdentity,
  browserCommandBinding,
  checkBrowserBindingAuthority,
  currentBrowserWorkspace,
  lockBrowserWorkspaceGrant,
  readCurrentBrowserWorkspace,
  type BrowserWorkspaceRow,
} from './browser-control-authority.ts';
import {
  RuntimePolicyError,
  runtimePolicyDigest as digest,
  createRuntimePolicyAdmission,
  requestRuntimeActionApproval,
  getRuntimeActionApproval,
  type RuntimePolicyPrincipal,
} from './runtime-policy.ts';
import { createRuntimeOperationLedger } from './runtime-ledger/ledger.ts';
import { ensureRuntimeOperationRoot } from './runtime-ledger/root-service.ts';
import { cloudStableId } from './cloud-execution.ts';
import {
  sealBrowserDirectInput,
  openBrowserDirectInput,
  type BrowserSecretScope,
} from './browser-control-secret.ts';
export {
  browserControlEnabled,
  readCurrentBrowserWorkspace,
} from './browser-control-authority.ts';
export const browserPrincipal = (
  c: ExecutionContext,
): RuntimePolicyPrincipal => ({
  actor: { type: 'user', id: c.policySnapshot.subjectId },
  organizationId: c.organizationId,
  workspaceId: c.workspaceId,
  requestId: randomUUID(),
});

export async function installBrowserControlGrant(
  ctx: RequestContext,
  input: {
    targetId: string;
    ownerId: string;
    profile: unknown;
    enabled: boolean;
  },
  db = getDatabase(),
  administration?: TenantManagementOptions,
) {
  const profile = BrowserProfileSchema.parse(input.profile),
    id = randomUUID();
  for (const origin of profile.origins) {
    const denial = browserGrantOriginDenial(origin);
    if (denial) throw new RuntimePolicyError(denial);
  }
  return db.begin(async (tx) => {
    const organizationId = administration?.organizationId ?? ctx.organizationId,
      workspaceId = administration?.workspaceId ?? ctx.workspaceId;
    if (administration) {
      if (input.ownerId !== administration.subjectId)
        throw new RuntimePolicyError('membership_denied');
      await requireTenantManagementScope(ctx, administration, tx);
    } else await browserIdentity(tx, ctx, true);
    const [valid] =
      await tx`select t.id from allrice_execution_targets t join allrice_memberships m on m.organization_id=t.organization_id
      and (m.workspace_id is null or m.workspace_id=t.workspace_id) and m.user_id=${UuidSchema.parse(input.ownerId)} and m.active
      where t.id=${UuidSchema.parse(input.targetId)} and t.organization_id=${organizationId} and t.workspace_id=${workspaceId}
      and t.kind='cloud_sandbox' and t.state<>'revoked' and t.capabilities ? 'browser.navigate' for share of t,m`;
    if (!valid) throw new RuntimePolicyError('browser_target_denied');
    await tx`insert into allrice_browser_control_grants(id,organization_id,workspace_id,owner_id,target_id,version,profile,enabled)
      values(${id},${organizationId},${workspaceId},${input.ownerId},${input.targetId},1,${tx.json(profile)},${input.enabled})`;
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
      values(${organizationId},${workspaceId},${ctx.actor.id},'browser.grant.installed','execution_target',${input.targetId},'recorded',${administration?.reason ?? 'explicit_admin_grant'},${tx.json({ grantId: id, ownerId: input.ownerId, profileDigest: digest(profile), enabled: input.enabled })})`;
    return { id, version: 1, profile };
  });
}
export async function revokeBrowserControlGrant(
  ctx: RequestContext,
  id: string,
  db = getDatabase(),
  administration?: TenantManagementOptions & { expectedVersion: number },
) {
  return db.begin(async (tx) => {
    const organizationId = administration?.organizationId ?? ctx.organizationId,
      workspaceId = administration?.workspaceId ?? ctx.workspaceId,
      ownerId = administration?.subjectId ?? ctx.actor.id;
    if (administration) {
      await requireTenantManagementScope(ctx, administration, tx);
      const [current] =
        await tx`select id from allrice_browser_control_grants where id=${UuidSchema.parse(id)} and organization_id=${organizationId} and workspace_id=${workspaceId} and owner_id=${ownerId} and version=${administration.expectedVersion} and enabled and revoked_at is null for update`;
      if (!current) throw new RuntimePolicyError('browser_grant_unavailable');
    } else await browserIdentity(tx, ctx, true);
    const changed =
      await tx`update allrice_browser_control_grants set enabled=false,revoked_at=coalesce(revoked_at,clock_timestamp())
      where id=${UuidSchema.parse(id)} and organization_id=${organizationId} and workspace_id=${workspaceId} and transport='cloud' returning id,owner_id`;
    if (!changed.length)
      throw new RuntimePolicyError('browser_grant_unavailable');
    // Requested != stopped. Controller confirms physical close independently.
    await tx`update allrice_browser_workspaces set desired_control='closed',state='close_pending',control_fence=control_fence+1
      where grant_id=${id} and state not in ('closed','unknown','close_pending')`;
    await tx`update allrice_browser_direct_inputs set envelope=null,consumed_at=coalesce(consumed_at,clock_timestamp())
      where browser_workspace_id in(select id from allrice_browser_workspaces where grant_id=${id})`;
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata) values(${organizationId},${workspaceId},${ctx.actor.id},'browser.grant.revoked','browser_grant',${id},'recorded',${administration?.reason ?? 'explicit_admin_revoke'},${tx.json({ ownerId: changed[0]!.owner_id, physicalStopConfirmed: false })})`;
    return { requested: true };
  });
}
export async function createBrowserWorkspace(
  input: {
    context: ExecutionContext;
    callId: string;
    url: string;
    jobAttempt: number;
    jobLeaseToken: string;
  },
  db = getDatabase(),
) {
  if (!browserControlEnabled())
    throw new RuntimePolicyError('browser_control_disabled');
  const ctx = browserPrincipal(input.context),
    id = cloudStableId(`browser:${input.context.runId}:${input.callId}`);
  const [prior] = await db<
    { id: string }[]
  >`select id from allrice_browser_workspaces where id=${id}`;
  if (prior) return readCurrentBrowserWorkspace(ctx, id, db);
  const grant = await db.begin(async (tx) => {
    await browserIdentity(tx, ctx);
    const [run] =
      await tx`select run_id from allrice_employee_runs where run_id=${input.context.runId} and organization_id=${ctx.organizationId}
      and workspace_id=${ctx.workspaceId} and owner_id=${ctx.actor.id} and execution_snapshot->'capabilitySnapshot'->'bindings'->'toolNames' ? 'browser.workspace' for share`;
    if (!run) throw new RuntimePolicyError('browser_frozen_tool_denied');
    const [count] = await tx<
      { n: number }[]
    >`select count(*)::int as n from allrice_browser_workspaces where run_id=${input.context.runId} and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId}`;
    if ((count?.n ?? 0) >= 8)
      throw new RuntimePolicyError('browser_workspace_limit');
    const [g] = await tx<
      {
        id: string;
        version: number;
        profile: BrowserProfile;
        target_id: string;
      }[]
    >`select g.id,g.version,g.profile,g.target_id from allrice_browser_control_grants g
      join allrice_execution_targets t on t.id=g.target_id and t.organization_id=g.organization_id and t.workspace_id=g.workspace_id
      where g.organization_id=${ctx.organizationId} and g.workspace_id=${ctx.workspaceId} and g.owner_id=${ctx.actor.id}
        and g.transport='cloud' and g.enabled and g.revoked_at is null and t.state='online'
        and (t.metadata->>'healthManaged' is distinct from 'true' or t.last_heartbeat_at between clock_timestamp()-interval '120 seconds' and clock_timestamp())
      order by g.created_at desc limit 1 for share of g,t`;
    if (!g) throw new RuntimePolicyError('browser_grant_unavailable');
    const profile = BrowserProfileSchema.parse(g.profile);
    if (
      !browserOriginAllowed(input.url, profile) ||
      browserGrantOriginDenial(input.url)
    )
      throw new RuntimePolicyError('browser_origin_denied');
    return { ...g, profile };
  });
  const lease = { attempt: input.jobAttempt, leaseToken: input.jobLeaseToken };
  const task = await createManagedBrowserTask(
    input.context,
    {
      runId: input.context.runId,
      targetId: grant.target_id,
      startUrl: input.url,
      allowedDomains:
        grant.profile.network === 'public_https'
          ? [new URL(input.url).hostname]
          : grant.profile.origins.map((o) => new URL(o).hostname),
      steps: [],
      toolCallId: input.callId,
    },
    lease,
  );
  const started = await startManagedBrowserTask({
    context: input.context,
    taskId: task.id,
    lease,
  });
  await db.begin(async (tx) => {
    const [run] = await tx<
      { session_id: string }[]
    >`select e.session_id from allrice_employee_runs e join allrice_runs r on r.id=e.run_id
      and r.organization_id=e.organization_id and r.workspace_id=e.workspace_id and r.owner_id=e.owner_id
      where e.run_id=${input.context.runId} and e.organization_id=${ctx.organizationId} and e.workspace_id=${ctx.workspaceId} and e.owner_id=${ctx.actor.id}
      and r.state='running' and e.execution_snapshot->'capabilitySnapshot'->'bindings'->'toolNames' ? 'browser.workspace' for share of e,r`;
    if (!run) throw new RuntimePolicyError('browser_frozen_tool_denied');
    await tx`insert into allrice_browser_workspaces(id,organization_id,workspace_id,owner_id,run_id,session_id,job_id,worker_id,job_lease_token,job_attempt,
      task_id,grant_id,grant_version,profile_id,profile,execution_context,expires_at)
      values(${id},${ctx.organizationId},${ctx.workspaceId},${ctx.actor.id},${input.context.runId},${run.session_id},${input.context.jobId},${input.context.worker.id},
      ${input.jobLeaseToken},${input.jobAttempt},${task.id},${grant.id},${grant.version},${randomUUID()},${tx.json(grant.profile)},${tx.json(input.context as never)},
      least(${started.deadlineAt}::timestamptz,clock_timestamp()+${grant.profile.lifetimeMs}*interval '1 millisecond')) on conflict(id) do nothing`;
  });
  return readCurrentBrowserWorkspace(ctx, id, db);
}
export function createBrowserOperationLedger(
  ctx: RuntimePolicyPrincipal,
  db = getDatabase(),
) {
  const policyOptions = {
    context: ctx,
    resolveCurrentBinding: async ({
      transaction,
      binding,
    }: {
      transaction: Parameters<typeof checkBrowserBindingAuthority>[0];
      binding: RuntimeActionBinding;
    }) =>
      (await checkBrowserBindingAuthority(transaction, ctx, binding)).binding,
  };
  const ledger = createRuntimeOperationLedger({
    database: db,
    admission: createRuntimePolicyAdmission(policyOptions),
    persistLease: async ({ transaction, lease }) => {
      if (
        ![
          'cloud.browser.act',
          'cloud.browser.observe',
          'local.browser.act',
          'local.browser.observe',
        ].includes(lease.snapshot.binding.action)
      )
        throw new RuntimePolicyError('resource_adapter_not_registered');
      await transaction`update allrice_browser_operation_inputs set lease_token=${lease.leaseToken} where operation_id=${lease.snapshot.binding.attempt.operationId} and lease_token is null`;
    },
  });
  return Object.assign(ledger, { policyOptions });
}
/** trustedRequest permits ONLY the Worker's intercepted network request, never HTTP/model arguments. */
export async function createBrowserOperation(
  ctx: RuntimePolicyPrincipal,
  raw: unknown,
  requestId: string,
  db = getDatabase(),
  trustedRequest = false,
) {
  const payload = BrowserCommandSchema.parse(raw);
  UuidSchema.parse(requestId);
  if (payload.action.type === 'request' && !trustedRequest)
    throw new RuntimePolicyError('browser_request_source_denied');
  const w = await readCurrentBrowserWorkspace(ctx, payload.workspaceId, db),
    key = `browser-operation:${w.id}:${requestId}`,
    operationId = cloudStableId(key);
  const content =
    payload.action.type === 'upload'
      ? [
          {
            kind: 'storage_object' as const,
            id: payload.action.objectId,
            checksum: payload.action.checksum,
          },
        ]
      : [];
  const binding = RuntimeActionBindingSchema.parse({
    task: {
      scope: {
        organizationId: w.organization_id,
        workspaceId: w.workspace_id,
        projectId: null,
      },
      chatSessionId: w.session_id,
      runId: w.run_id,
      rootRunId: w.run_id,
      parentRunId: null,
      frozenConfiguration: {
        employeeVersionId: w.employee_version_id,
        digest: digest(w.execution_spec),
      },
    },
    // A new one-shot ledger attempt always starts at fence 1. Browser control
    // fencing is a separate monotonic protocol bound in the immutable payload.
    attempt: {
      operationId,
      attemptId: cloudStableId(`${key}:attempt`),
      attemptNumber: 1,
      generation: w.thread_generation,
      fence: 1,
    },
    requestedBy: { type: 'user', id: w.owner_id },
    policy: {
      snapshotId: w.policy_snapshot_id,
      digest: digest(w.policy_payload),
    },
    execution: {
      targetId: w.target_id,
      targetKind: w.transport === 'local' ? 'rice_bridge' : 'cloud_sandbox',
      deviceId: w.device_id,
      grantId: w.grant_id,
      grantVersion: w.grant_version,
      scopeDigest: digest(w.profile),
      workCopy: {
        id: w.profile_id,
        kind: w.transport === 'local' ? 'local_copy' : 'cloud_copy',
      },
    },
    action:
      w.transport === 'local'
        ? payload.action.type === 'observe'
          ? 'local.browser.observe'
          : 'local.browser.act'
        : payload.action.type === 'observe'
          ? 'cloud.browser.observe'
          : 'cloud.browser.act',
    inputDigest: digest(payload),
    command: browserCommandBinding(payload, w.profile, w.transport),
    baseline: content,
    dataScope: content.map((c) => ({
      content: c,
      sourceTargetId: null,
      purpose: 'execution_input',
      destination: w.transport === 'local' ? 'local_write' : 'cloud_execution',
      authorizationId: operationId,
      authorizationVersion: 1,
    })),
  });
  await db`insert into allrice_browser_operation_inputs(operation_id,browser_workspace_id,binding,payload,observation)
    values(${operationId},${w.id},${db.json(binding)},${db.json(payload)},${w.observation ? db.json(w.observation) : null}) on conflict(operation_id) do nothing`;
  const ledger = createBrowserOperationLedger(ctx, db);
  const budgets = await ensureRuntimeOperationRoot(
    ledger,
    binding.task,
    w.expires_at.toISOString(),
    db,
  );
  const snapshot = await ledger.createOperation({
    ...(w.transport === 'local' ? { localBrowserPayload: payload } : {}),
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
            ? 15000
            : b.metric === 'output_bytes'
              ? 1000000
              : 0,
    })),
  });
  if (snapshot.status === 'waiting_user')
    await requestRuntimeActionApproval(
      ledger.policyOptions,
      binding,
      120000,
      db,
    );
  return { snapshot, payload, ledger, workspace: w };
}
export async function requestBrowserControl(
  ctx: RuntimePolicyPrincipal,
  id: string,
  raw: unknown,
  db = getDatabase(),
) {
  const request = BrowserControlRequestSchema.parse(raw);
  return db.begin(async (tx) => {
    await browserIdentity(tx, ctx);
    await lockBrowserWorkspaceGrant(tx, ctx, id);
    const [w] = await tx<
      BrowserWorkspaceRow[]
    >`select * from allrice_browser_workspaces where id=${UuidSchema.parse(id)} and organization_id=${ctx.organizationId}
      and workspace_id=${ctx.workspaceId} and owner_id=${ctx.actor.id} for update`;
    if (!w) throw new RuntimePolicyError('browser_not_owned');
    const [prior] = await tx<
      { request: unknown; resulting_fence: number }[]
    >`select request,resulting_fence from allrice_browser_control_requests where workspace_id=${id} and request_id=${request.requestId}`;
    if (prior) {
      if (!runtimeContractEqual(prior.request, request))
        throw new RuntimePolicyError('idempotency_conflict');
      return { fence: prior.resulting_fence, requested: true };
    }
    if (
      w.control_fence !== request.expectedFence ||
      ['closed', 'unknown'].includes(w.state)
    )
      throw new RuntimePolicyError('browser_control_changed');
    const current =
      request.control !== 'closed'
        ? await currentBrowserWorkspace(tx, ctx, id)
        : null;
    if (
      request.control === 'agent' &&
      (!w.observation ||
        request.observationId !== w.observation.id ||
        Date.parse(w.observation.expiresAt) <= current!.clock.getTime())
    )
      throw new RuntimePolicyError('browser_observation_stale');
    const fence = w.control_fence + 1,
      state = {
        human: 'takeover_pending',
        agent: 'resume_pending',
        paused: 'pause_pending',
        closed: 'close_pending',
      }[request.control];
    await tx`update allrice_browser_workspaces set desired_control=${request.control},control_fence=${fence},state=${state} where id=${id}`;
    if (w.transport === 'local' && request.control === 'closed') {
      const [unclaimed] =
        await tx`update allrice_local_browser_workspaces set released_at=coalesce(released_at,clock_timestamp())
        where browser_workspace_id=${id} and controller_lease_token is null returning browser_workspace_id`;
      // Server proof that no controller was ever issued this workspace is
      // sufficient to close an unallocated intent, not a physical stop claim.
      if (unclaimed)
        await tx`update allrice_browser_workspaces set state='closed',stopped_at=clock_timestamp() where id=${id}`;
    }
    await tx`update allrice_browser_direct_inputs set envelope=null,consumed_at=coalesce(consumed_at,clock_timestamp()) where browser_workspace_id=${id}`;
    await tx`insert into allrice_browser_control_requests(workspace_id,request_id,request,resulting_fence) values(${id},${request.requestId},${tx.json(request)},${fence})`;
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
      values(${ctx.organizationId},${ctx.workspaceId},${ctx.actor.id},'browser.control.requested','browser_workspace',${id},'recorded','intent_not_stop_confirmation',${tx.json({ control: request.control, fence, requestId: request.requestId })})`;
    return { fence, requested: true };
  });
}
export async function acknowledgeBrowserControl(
  ctx: RuntimePolicyPrincipal,
  id: string,
  fence: number,
  observation: BrowserObservation | null,
  db = getDatabase(),
) {
  return db.begin(async (tx) => {
    const w = await currentBrowserWorkspace(tx, ctx, id);
    if (w.control_fence !== fence || w.desired_control === 'closed')
      throw new RuntimePolicyError('browser_control_changed');
    const obs = observation
      ? BrowserObservationSchema.parse(observation)
      : null;
    if (obs && (obs.profileId !== w.profile_id || obs.fence !== fence))
      throw new RuntimePolicyError('browser_observation_changed');
    if (obs && !browserObservationIsFresh(obs, w.clock.getTime()))
      throw new RuntimePolicyError('browser_observation_stale');
    await tx`update allrice_browser_workspaces set state=desired_control,acknowledged_fence=control_fence,observation=${obs ? tx.json(obs) : null},last_heartbeat_at=clock_timestamp()
      where id=${id} and control_fence=${fence}`;
  });
}
export async function recordBrowserObservation(
  ctx: RuntimePolicyPrincipal,
  id: string,
  observation: BrowserObservation,
  db = getDatabase(),
) {
  await db.begin(async (tx) => {
    const w = await currentBrowserWorkspace(tx, ctx, id),
      obs = BrowserObservationSchema.parse(observation);
    if (w.control_fence !== obs.fence || w.profile_id !== obs.profileId)
      throw new RuntimePolicyError('browser_control_changed');
    if (!browserObservationIsFresh(obs, w.clock.getTime()))
      throw new RuntimePolicyError('browser_observation_stale');
    await tx`update allrice_browser_workspaces set observation=${tx.json(obs)},last_heartbeat_at=clock_timestamp() where id=${id} and control_fence=${obs.fence}`;
  });
}
const secretScope = (
  w: BrowserWorkspaceRow,
  input: {
    id: string;
    fence: number;
    observation_id: string;
    element_id: string;
    expires_at: Date;
  },
): BrowserSecretScope => ({
  organizationId: w.organization_id,
  tenantWorkspaceId: w.workspace_id,
  browserWorkspaceId: w.id,
  profileId: w.profile_id,
  actorId: w.owner_id,
  inputId: input.id,
  fence: input.fence,
  observationId: input.observation_id,
  elementId: input.element_id,
  expiresAt: input.expires_at.toISOString(),
});
export async function createBrowserDirectInput(
  ctx: RequestContext,
  id: string,
  input: {
    fence: number;
    observationId: string;
    elementId: string;
    value: string;
  },
  db = getDatabase(),
) {
  return db.begin(async (tx) => {
    const w = await currentBrowserWorkspace(tx, ctx, id);
    if (
      w.state !== 'human' ||
      w.acknowledged_fence !== input.fence ||
      w.control_fence !== input.fence ||
      !w.profile.allowHumanCredentials ||
      w.observation?.id !== input.observationId ||
      !w.observation.elements.some(
        (e) => e.id === input.elementId && e.sensitive,
      ) ||
      Date.parse(w.observation.expiresAt) <= w.clock.getTime()
    )
      throw new RuntimePolicyError('browser_sensitive_input_denied');
    const record = {
      id: randomUUID(),
      fence: input.fence,
      observation_id: input.observationId,
      element_id: input.elementId,
      expires_at: new Date(w.clock.getTime() + 60000),
    };
    const envelope = sealBrowserDirectInput(
      input.value,
      secretScope(w, record),
    );
    await tx`insert into allrice_browser_direct_inputs(id,browser_workspace_id,owner_id,fence,observation_id,element_id,envelope,expires_at)
      values(${record.id},${id},${ctx.actor.id},${input.fence},${input.observationId},${input.elementId},${tx.json(envelope)},${record.expires_at})`;
    return { inputId: record.id, expiresAt: record.expires_at.toISOString() };
  });
}
/** Irreversibly consume before returning plaintext to the owned controller. No restart replay. */
export async function consumeBrowserDirectInput(
  ctx: RuntimePolicyPrincipal,
  id: string,
  command: BrowserCommand,
  db = getDatabase(),
) {
  if (command.action.type !== 'sensitive_fill')
    throw new RuntimePolicyError('browser_sensitive_input_denied');
  const inputId = command.action.inputId,
    elementId = command.action.elementId;
  const consumed = await db.begin(async (tx) => {
    const w = await currentBrowserWorkspace(tx, ctx, id);
    if (
      w.state !== 'human' ||
      w.control_fence !== command.fence ||
      w.acknowledged_fence !== command.fence ||
      w.profile_id !== command.profileId
    )
      throw new RuntimePolicyError('browser_control_changed');
    const [record] = await tx<
      {
        id: string;
        fence: number;
        observation_id: string;
        element_id: string;
        expires_at: Date;
        envelope: unknown;
      }[]
    >`select * from allrice_browser_direct_inputs
      where id=${inputId} and browser_workspace_id=${id} and owner_id=${ctx.actor.id} and fence=${command.fence} and observation_id=${command.observationId}
      and element_id=${elementId} and envelope is not null and consumed_at is null and expires_at>clock_timestamp() for update`;
    if (!record)
      throw new RuntimePolicyError('browser_direct_input_unavailable');
    await tx`update allrice_browser_direct_inputs set envelope=null,consumed_at=clock_timestamp() where id=${record.id}`;
    return { record, scope: secretScope(w, record), now: w.clock.getTime() };
  });
  return openBrowserDirectInput(
    consumed.record.envelope,
    consumed.scope,
    consumed.now,
  );
}
export type BrowserWorkspaceView = {
  transport: 'cloud' | 'local';
  localDeviceName: string | null;
  persistLogin: boolean;
  preview: {
    processId: string;
    endpointId: string;
    url: string;
    port: number;
    hardDeadlineAt: string;
  } | null;
  id: string;
  runId: string;
  profileId: string;
  state: BrowserWorkspaceRow['state'];
  desiredControl: string;
  fence: number;
  acknowledgedFence: number;
  expiresAt: string;
  stoppedAt: string | null;
  observation: BrowserObservation | null;
  profile: BrowserProfile;
  available: boolean;
  operations: {
    snapshot: ReturnType<typeof RuntimeOperationSnapshotSchema.parse>;
    command: BrowserCommand;
    approval: RuntimeActionApprovalSnapshot | null;
    result: unknown;
    available: boolean;
  }[];
};
export async function listBrowserWorkspaces(
  ctx: RequestContext,
  runId: string,
  db = getDatabase(),
): Promise<BrowserWorkspaceView[]> {
  const rows = await db.begin(async (tx) => {
    await browserIdentity(tx, ctx);
    const [run] =
      await tx`select id from allrice_runs where id=${UuidSchema.parse(runId)} and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId} and owner_id=${ctx.actor.id}`;
    if (!run) throw new RuntimePolicyError('run_not_owned');
    return tx<
      (BrowserWorkspaceRow & {
        preview_target: unknown;
        local_device_name: string | null;
        persist_login: boolean;
      })[]
    >`select w.*,d.name as local_device_name,coalesce(l.persist_login,false) as persist_login,x.target as preview_target from allrice_browser_workspaces w
      left join allrice_local_browser_grants l on l.grant_id=w.grant_id and l.organization_id=w.organization_id and l.workspace_id=w.workspace_id and l.owner_id=w.owner_id
      left join allrice_bridge_devices d on d.id=l.device_id and d.organization_id=l.organization_id and d.workspace_id=l.workspace_id and d.owner_id=l.owner_id
      left join allrice_local_preview_endpoints x on x.browser_workspace_id=w.id and x.organization_id=w.organization_id and x.workspace_id=w.workspace_id and x.owner_id=w.owner_id
      where w.run_id=${runId} and w.organization_id=${ctx.organizationId} and w.workspace_id=${ctx.workspaceId} and w.owner_id=${ctx.actor.id} order by w.created_at limit 8`;
  });
  const views: BrowserWorkspaceView[] = [];
  for (const w of rows) {
    let available = false;
    try {
      await readCurrentBrowserWorkspace(ctx, w.id, db);
      available = true;
    } catch {
      /* history remains visible */
    }
    const ops = await db<
      {
        snapshot: unknown;
        payload: unknown;
        result: unknown;
        approval_id: string | null;
      }[]
    >`select o.snapshot,i.payload,i.result,a.id as approval_id from allrice_browser_operation_inputs i
      join allrice_runtime_operations o on o.id=i.operation_id left join allrice_approval_requests a on a.resource_type='runtime_operation' and a.resource_id=o.id
      where i.browser_workspace_id=${w.id} order by i.created_at limit 100`;
    const operations: BrowserWorkspaceView['operations'] = [];
    for (const op of ops) {
      const snapshot = RuntimeOperationSnapshotSchema.parse(op.snapshot),
        command = BrowserCommandSchema.parse(op.payload);
      let opAvailable = false;
      try {
        await db.begin((tx) =>
          checkBrowserBindingAuthority(tx, ctx, snapshot.binding),
        );
        opAvailable = true;
      } catch {
        /* projection is not authority */
      }
      operations.push({
        snapshot,
        command,
        approval: op.approval_id
          ? RuntimeActionApprovalSnapshotSchema.parse(
              await getRuntimeActionApproval(ctx, op.approval_id, db),
            )
          : null,
        result: op.result,
        available: opAvailable,
      });
    }
    const preview = w.preview_target
      ? LocalPreviewTargetSchema.parse(w.preview_target)
      : null;
    views.push({
      preview: preview
        ? {
            processId: preview.processId,
            endpointId: preview.endpointId,
            url: localPreviewOrigin(preview.endpointId),
            port: preview.port,
            hardDeadlineAt: preview.hardDeadlineAt,
          }
        : null,
      transport: w.transport,
      localDeviceName: w.local_device_name ?? null,
      persistLogin: Boolean(w.persist_login),
      id: w.id,
      runId: w.run_id,
      profileId: w.profile_id,
      state: w.state,
      desiredControl: w.desired_control,
      fence: w.control_fence,
      acknowledgedFence: w.acknowledged_fence,
      expiresAt: w.expires_at.toISOString(),
      stoppedAt: w.stopped_at?.toISOString() ?? null,
      observation: w.observation,
      profile: BrowserProfileSchema.parse(w.profile),
      available,
      operations,
    });
  }
  return views;
}
/** Called only once actual browser close settled; false explicitly means unconfirmed stop. */
export async function recordBrowserStopped(
  id: string,
  workerId: string,
  jobLeaseToken: string,
  confirmed: boolean,
  db = getDatabase(),
) {
  await db.begin(async (tx) => {
    const changed =
      await tx`update allrice_browser_workspaces set state=${confirmed ? 'closed' : 'unknown'},desired_control='closed',control_fence=control_fence+1,
      stopped_at=${confirmed ? new Date() : null} where id=${id} and worker_id=${workerId} and job_lease_token=${jobLeaseToken} and state not in ('closed','unknown') returning id`;
    if (!changed.length) return;
    await tx`update allrice_browser_direct_inputs set envelope=null,consumed_at=coalesce(consumed_at,clock_timestamp()) where browser_workspace_id=${id}`;
  });
}
