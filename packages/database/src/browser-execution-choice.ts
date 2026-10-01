import {
  BrowserProfileSchema,
  BrowserUrlSchema,
  browserOriginAllowed,
  ExecutionChoiceSchema,
  ExecutionLocationSchema,
  resolveExecutionChoice,
  type ExecutionContext,
  type ExecutionLocation,
  type ExecutionChoice,
  type BridgeReadinessState,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { bridgeCapabilityReadinessView } from './bridge-settings.ts';
import { browserIdentity } from './browser-control-authority.ts';
import { browserPrincipal } from './browser-control.ts';
import { cloudStableId } from './cloud-execution.ts';
import { localBrowserEnabled } from './local-browser-grants.ts';
import { RuntimePolicyError, runtimePolicyDigest } from './runtime-policy.ts';

/** Narrow explicit instructions, also read from the original stored message.
 * Local object references below are authoritative even when a model omits flags. */
export function executionRequestConstraints(text: string) {
  const localOnly =
    /(?:不(?:要|得|能)?上传|禁止上传|不要传到云端|不得传到云端|local[- ]only|do not upload|don['’]t upload)/i.test(
      text,
    );
  const localAccount =
    /(?<!不|别|使|不要)(?:用|使用|打开)(?:我(?:的)?电脑上(?:已(?:经)?登录的)?(?:浏览器|账号)|已(?:经)?登录的本地浏览器|本地浏览器)|(?<!don't |do not )(?:use|using) (?:my )?(?:logged[- ]in |signed[- ]in |local )browser/i.test(
      text,
    );
  const local =
    localAccount ||
    /(?:只(?:能|在|使用)?(?:本地|我的电脑|这台电脑)|在(?:本地|我的电脑|这台电脑|这台\s*Mac)(?:上)?(?:执行|运行|处理)|(?:run|execute|process) (?:only )?(?:locally|on my (?:computer|mac)))/i.test(
      text,
    );
  const cloud =
    /(?<!不|别|使|不要)(?:用|使用|打开)(?:已授权的)?云端浏览器|(?<!don't |do not )(?:use|using) (?:the )?cloud browser/i.test(
      text,
    ) ||
    /(?:只(?:能|在|使用)?云端|在云端(?:执行|运行|处理)|(?:run|execute|process) (?:only )?in (?:the )?cloud)/i.test(
      text,
    );
  return {
    location: (local ? 'local' : cloud ? 'cloud' : 'auto') as ExecutionLocation,
    localOnly: localOnly || localAccount,
  };
}

/** Choose once per tool call in existing audit history, then keep that device
 * and location. It does not provision grants or execute browser actions. */
export async function selectBrowserExecution(
  input: {
    context: ExecutionContext;
    callId: string;
    url: string;
    jobAttempt: number;
    jobLeaseToken: string;
    location?: ExecutionLocation;
    requireLocalInputs?: boolean;
  },
  db = getDatabase(),
) {
  const ctx = browserPrincipal(input.context),
    url = BrowserUrlSchema.parse(input.url);
  const requested = ExecutionLocationSchema.parse(input.location ?? 'auto');
  if (!input.callId || input.callId.length > 255)
    throw new RuntimePolicyError('invalid_tool_call');
  const id = cloudStableId(`browser:${input.context.runId}:${input.callId}`);
  const requestDigest = runtimePolicyDigest({
    url,
    location: requested,
    requireLocalInputs: input.requireLocalInputs ?? false,
  });
  return db.begin(async (tx) => {
    await browserIdentity(tx, ctx);
    // Existing job row serializes duplicate selection without a new queue/table.
    const [run] = await tx<
      {
        text: string;
        local_tool: boolean;
        timeout_at: Date;
        local_device: string | null;
      }[]
    >`select coalesce(m.content->>'text','') as text,j.timeout_at,
      e.execution_snapshot->'capabilitySnapshot'->'bindings'->'toolNames' ? 'local.browser.workspace' as local_tool,
      coalesce((select o.snapshot->'binding'->'execution'->>'deviceId' from allrice_runtime_operations o
        where o.run_id=r.id and o.organization_id=r.organization_id and o.workspace_id=r.workspace_id
          and o.snapshot->'binding'->'execution'->>'targetKind'='rice_bridge'
          and o.snapshot->'binding'->>'action' in ('local.fs.read','local.fs.write','local.fs.changeset','local.process.execute','local.mcp.call')
        order by o.created_at desc limit 1),
        (select b.device_id::text from allrice_bridge_commands b where b.organization_id=r.organization_id
          and b.workspace_id=r.workspace_id and b.owner_id=r.owner_id
          and b.idempotency_key like ${`tool:${input.context.runId}:%`} order by b.created_at desc limit 1)) as local_device
      from allrice_runs r join allrice_employee_runs e on e.run_id=r.id and e.organization_id=r.organization_id
        and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id
      join allrice_jobs j on j.id=${input.context.jobId} and j.run_id=r.id and j.organization_id=r.organization_id
        and j.workspace_id=r.workspace_id and j.owner_id=r.owner_id
      join allrice_messages m on m.id=e.user_message_id and m.organization_id=r.organization_id
        and m.workspace_id=r.workspace_id and m.owner_id=r.owner_id
      where r.id=${input.context.runId} and r.organization_id=${ctx.organizationId} and r.workspace_id=${ctx.workspaceId}
        and r.owner_id=${ctx.actor.id} and r.state='running' and r.policy_snapshot_id=${input.context.policySnapshot.id}
        and j.status='running' and j.worker_id=${input.context.worker.id} and j.attempt=${input.jobAttempt}
        and j.lease_token=${input.jobLeaseToken} and j.lease_expires_at>clock_timestamp()
        and j.timeout_at>clock_timestamp() and j.cancel_requested_at is null
        and e.execution_snapshot->'capabilitySnapshot'->'bindings'->'toolNames' ? 'browser.workspace'
      for update of j`;
    if (!run) throw new RuntimePolicyError('browser_frozen_tool_denied');
    const constraints = executionRequestConstraints(run.text);
    const location =
      constraints.location === 'auto' ? requested : constraints.location;
    const localInputs =
      !!run.local_device || constraints.localOnly || input.requireLocalInputs;
    const [prior] = await tx<
      {
        reason: string;
        metadata: {
          requestDigest: string;
          choice: ExecutionChoice;
          deviceId: string | null;
        };
      }[]
    >`select reason,metadata from allrice_audit_events where organization_id=${ctx.organizationId}
      and workspace_id=${ctx.workspaceId} and actor_id=${ctx.actor.id} and action='execution.location'
      and resource_type='browser_workspace' and resource_id=${id} order by occurred_at limit 1`;
    if (prior && prior.metadata.requestDigest !== requestDigest)
      throw new RuntimePolicyError('idempotency_conflict');
    const [existing] = await tx<
      {
        transport: 'local' | 'cloud';
        state: string;
        device_id: string | null;
        grant_id: string;
        active: boolean;
      }[]
    >`
      select w.transport,w.state,l.device_id,w.grant_id,
        w.state in ('starting','agent','human') and w.desired_control<>'closed' and w.expires_at>clock_timestamp() as active
      from allrice_browser_workspaces w left join allrice_local_browser_workspaces l on l.browser_workspace_id=w.id
        and l.organization_id=w.organization_id and l.workspace_id=w.workspace_id and l.owner_id=w.owner_id
      where w.id=${id} and w.organization_id=${ctx.organizationId}
        and w.workspace_id=${ctx.workspaceId} and w.owner_id=${ctx.actor.id} and w.run_id=${input.context.runId}`;
    const boundDevice =
      existing?.device_id ?? prior?.metadata.deviceId ?? run.local_device;
    const devices =
      localBrowserEnabled() && run.local_tool
        ? await tx<
            {
              id: string;
              protocol_version: number;
              online: boolean;
              metadata: Record<string, unknown>;
              grant_id: string | null;
              profile: unknown;
              busy: boolean;
            }[]
          >`select d.id,d.protocol_version,
      coalesce(d.last_seen_at between clock_timestamp()-interval '90 seconds' and clock_timestamp(),false) and t.state='online' as online,
      coalesce(t.metadata,'{}'::jsonb) as metadata,g.id as grant_id,g.profile,
      exists(select 1 from allrice_local_browser_workspaces w where w.grant_id=g.id and w.released_at is null
        and w.browser_workspace_id<>${id}) as busy
      from allrice_bridge_devices d join allrice_execution_targets t on t.target_key='bridge.'||d.id::text
        and t.organization_id=d.organization_id and t.workspace_id=d.workspace_id and t.kind='rice_bridge'
      left join allrice_local_browser_grants l on l.device_id=d.id and l.organization_id=d.organization_id
        and l.workspace_id=d.workspace_id and l.owner_id=d.owner_id and l.purpose='public' and l.cleanup_requested_at is null
      left join allrice_browser_control_grants g on g.id=l.grant_id and g.organization_id=l.organization_id
        and g.workspace_id=l.workspace_id and g.owner_id=l.owner_id and g.transport='local' and g.enabled and g.revoked_at is null
      where d.organization_id=${ctx.organizationId} and d.workspace_id=${ctx.workspaceId} and d.owner_id=${ctx.actor.id}
        and d.revoked_at is null and (${boundDevice}::uuid is null or d.id=${boundDevice}::uuid)
        and (${existing?.grant_id ?? null}::uuid is null or g.id=${existing?.grant_id ?? null}::uuid)
      order by d.last_seen_at desc nulls last`
        : [];
    const candidates = devices.map((d) => {
      let state = bridgeCapabilityReadinessView(
        d.metadata,
        'local.browser',
        d.online,
      ).state;
      const profile = BrowserProfileSchema.safeParse(d.profile);
      if (d.protocol_version === 1) state = 'unsupported';
      else if (d.online && !d.metadata.environment && d.grant_id)
        state = 'ready'; // old v2 explicit grant
      if (
        d.grant_id &&
        (!profile.success || !browserOriginAllowed(url, profile.data))
      )
        state = 'unsupported';
      if (!d.grant_id && state === 'ready') state = 'unsupported';
      // Reading/adopting this call's existing workspace needs no new profile.
      // A busy heartbeat includes our own live browser; never wait on ourselves.
      if (
        existing?.active &&
        existing.transport === 'local' &&
        state === 'busy'
      )
        state = 'ready';
      if (d.busy && state === 'ready') state = 'busy';
      return { ...d, state };
    });
    const rank: BridgeReadinessState[] = [
      'ready',
      'busy',
      'preparing',
      'paused',
      'unsupported',
      'offline',
    ];
    candidates.sort((a, b) => rank.indexOf(a.state) - rank.indexOf(b.state));
    const device = candidates[0];
    const cloudGrants = await tx<
      { profile: unknown }[]
    >`select g.profile from allrice_browser_control_grants g
      join allrice_execution_targets t on t.id=g.target_id and t.organization_id=g.organization_id and t.workspace_id=g.workspace_id
      where g.organization_id=${ctx.organizationId} and g.workspace_id=${ctx.workspaceId} and g.owner_id=${ctx.actor.id}
        and g.transport='cloud' and g.enabled and g.revoked_at is null and t.state='online'
        and (t.metadata->>'healthManaged' is distinct from 'true' or t.last_heartbeat_at between clock_timestamp()-interval '120 seconds' and clock_timestamp())`;
    const cloudAvailable = cloudGrants.some((g) => {
      const p = BrowserProfileSchema.safeParse(g.profile);
      return p.success && browserOriginAllowed(url, p.data);
    });
    const oldChoice = prior
      ? ExecutionChoiceSchema.parse(prior.metadata.choice)
      : null;
    const boundLocation =
      existing?.transport ??
      (oldChoice?.location === 'none' ? undefined : oldChoice?.location);
    const choice: ExecutionChoice =
      existing && !existing.active && existing.state !== 'unknown'
        ? {
            location: existing.transport,
            status: 'unavailable',
            reason: 'bound_execution',
          }
        : resolveExecutionChoice({
            location,
            local: device?.state ?? null,
            cloudAvailable,
            localInputs,
            boundLocation,
            outcomeUnknown: existing?.state === 'unknown',
          });
    if (!prior && choice.status !== 'unavailable')
      await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
        values(${ctx.organizationId},${ctx.workspaceId},${ctx.actor.id},'execution.location','browser_workspace',${id},'recorded',${choice.reason},
        ${tx.json({ requestDigest, choice, deviceId: choice.location === 'local' ? (device?.id ?? null) : null, callId: input.callId, runId: input.context.runId, localInputs: !!localInputs })})`;
    return {
      choice,
      deviceId: existing?.device_id ?? device?.id ?? null,
      grantId: existing?.grant_id ?? device?.grant_id ?? null,
      deadlineAt: run.timeout_at.toISOString(),
      workspaceId: id,
      selectionReason: prior?.reason ?? choice.reason,
    };
  });
}
