import {
  employeePublicationPolicy,
  RuntimePolicyControlsSchema,
  BrowserProfileSchema,
  CloudExecutionProfileSchema,
  UuidSchema,
} from '@allrice/contracts';
import type postgres from 'postgres';
import { prepareTenantCloudGrants } from './employees/development-cloud-grants.ts';
import { getDatabase } from './core/client.ts';

type Scope = { organizationId: string; workspaceId: string };
type Tx = postgres.TransactionSql;

/** Materialize the existing workspace deployment + current membership relation.
 * Called by membership/publication writes, never by a readiness GET. Assignment
 * IDs remain stable so withdrawal does not delete or rebind historical chats. */
export async function synchronizeTenantEmployeeAccess(tx: Tx, scope: Scope) {
  const { organizationId, workspaceId } = scope;
  await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-deployments:${organizationId}:${workspaceId}`},0))`;
  const deployments = await tx`
    select d.*, e.status employee_status from allrice_platform_employee_tenant_assignments d
    join allrice_employees e on e.id=d.tenant_employee_id
    where d.organization_id=${organizationId} and d.workspace_id=${workspaceId}
    order by d.is_default desc,d.assigned_at,d.id`;
  if (!deployments.length) return;
  await prepareManagedCloudTargets(tx, scope);
  await tx`update allrice_employee_assignments a set active=false,is_default=false,updated_at=clock_timestamp()
    where a.organization_id=${organizationId} and a.workspace_id=${workspaceId} and (a.active or a.is_default)
      and exists(select 1 from allrice_platform_employee_tenant_assignments d
        join allrice_employees e on e.id=d.tenant_employee_id
        where d.organization_id=a.organization_id and d.workspace_id=a.workspace_id and d.tenant_employee_id=a.employee_id
          and (not d.active or e.status<>'active' or not exists(
            select 1 from allrice_memberships m join allrice_users u on u.id=m.user_id and u.status='active'
            where m.organization_id=a.organization_id and m.user_id=a.user_id and m.active and m.role in ('admin','member')
              and (m.workspace_id is null or m.workspace_id=a.workspace_id))))`;
  for (const d of deployments.filter(
    (d) => d.active && d.employee_status === 'active',
  )) {
    await tx`insert into allrice_employee_assignments
      (organization_id,workspace_id,employee_id,employee_version_id,user_id,is_default,active,assigned_by)
      select ${organizationId},${workspaceId},${d.tenant_employee_id},${d.tenant_employee_version_id},m.user_id,false,true,null
      from allrice_memberships m join allrice_users u on u.id=m.user_id and u.status='active'
      where m.organization_id=${organizationId} and (m.workspace_id is null or m.workspace_id=${workspaceId})
        and m.active and m.role in ('admin','member') group by m.user_id
      on conflict(organization_id,workspace_id,user_id,employee_id) do update
        set employee_version_id=excluded.employee_version_id,is_default=allrice_employee_assignments.active and allrice_employee_assignments.is_default,active=true,updated_at=clock_timestamp()
        where not allrice_employee_assignments.active
          or allrice_employee_assignments.employee_version_id<>excluded.employee_version_id`;
    // Preserve an existing personal default; new members inherit the workspace default.
    await tx`update allrice_employee_assignments a set is_default=true,updated_at=clock_timestamp()
      where a.organization_id=${organizationId} and a.workspace_id=${workspaceId} and a.employee_id=${d.tenant_employee_id}
        and a.active and not a.is_default and not exists(select 1 from allrice_employee_assignments other
          where other.organization_id=a.organization_id and other.workspace_id=a.workspace_id and other.user_id=a.user_id and other.active and other.is_default)`;
  }
  await tx`update allrice_chat_sessions s set employee_version_id=a.employee_version_id,updated_at=clock_timestamp()
    from allrice_employee_assignments a where s.employee_assignment_id=a.id
      and s.organization_id=${organizationId} and s.workspace_id=${workspaceId} and a.active
      and s.employee_version_id<>a.employee_version_id
      and exists(select 1 from allrice_platform_employee_tenant_assignments d where d.tenant_employee_id=a.employee_id
        and d.organization_id=a.organization_id and d.workspace_id=a.workspace_id and d.active)`;
  await prepareTenantCloudGrants(tx, scope);
}

export type ManagedCloudEnvironmentReport = {
  workerId: string;
  browser: { available: boolean; profile: unknown; reason: string | null };
  compute: { available: boolean; profile: unknown; reason: string | null };
};

/** Trusted Worker startup/health evidence. No public API accepts these reports.
 * A real browser launch and the existing sandbox preflight precede publication. */
export async function recordManagedCloudEnvironment(
  input: ManagedCloudEnvironmentReport,
  db = getDatabase(),
) {
  UuidSchema.parse(input.workerId);
  if (input.browser.available)
    BrowserProfileSchema.parse(input.browser.profile);
  if (input.compute.available)
    CloudExecutionProfileSchema.parse(input.compute.profile);
  await db`insert into allrice_runtime_metadata(key,value,updated_at)
    values(${`managed-cloud-environments:${input.workerId}`},${db.json(JSON.parse(JSON.stringify(input)))},clock_timestamp())
    on conflict(key) do update set value=excluded.value,updated_at=excluded.updated_at`;
  const workspaces =
    await db`select distinct d.organization_id,d.workspace_id from allrice_platform_employee_tenant_assignments d
    join allrice_workspaces w on w.id=d.workspace_id and w.archived_at is null
    join allrice_organizations o on o.id=d.organization_id and o.archived_at is null
    order by d.organization_id,d.workspace_id`;
  for (const workspace of workspaces)
    await db.begin(async (tx) => {
      const scope = {
        organizationId: workspace.organization_id,
        workspaceId: workspace.workspace_id,
      };
      await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-deployments:${scope.organizationId}:${scope.workspaceId}`},0))`;
      await prepareTenantExecutionDefaults(tx, scope);
      await synchronizeTenantEmployeeAccess(tx, scope);
    });
}

async function prepareManagedCloudTargets(tx: Tx, scope: Scope) {
  const { organizationId, workspaceId } = scope;
  const [report] = await tx<
    { value: ManagedCloudEnvironmentReport; updated_at: Date }[]
  >`
    select value,updated_at from allrice_runtime_metadata where starts_with(key,'managed-cloud-environments:')
      and updated_at between clock_timestamp()-interval '120 seconds' and clock_timestamp()
    order by updated_at desc limit 1`;
  if (!report) return;
  for (const kind of ['compute', 'browser'] as const) {
    const evidence = report.value[kind];
    const capability =
      kind === 'compute' ? 'process.execute' : 'browser.navigate';
    const [existing] =
      await tx`select id,target_key,state,capabilities,metadata from allrice_execution_targets
      where organization_id=${organizationId} and workspace_id=${workspaceId} and kind='cloud_sandbox'
        and metadata->>'managedBy'='allrice'
        and (target_key=${`allrice.cloud.${kind}`} or capabilities ? ${capability})
      order by created_at desc,id limit 1`;
    if (existing?.state === 'revoked') continue;
    const profile =
      kind === 'compute'
        ? CloudExecutionProfileSchema.safeParse(evidence.profile)
        : BrowserProfileSchema.safeParse(evidence.profile);
    const ready = evidence.available && profile.success;
    const metadata = {
      ...existing?.metadata,
      managedBy: 'allrice',
      healthManaged: true,
      workerId: report.value.workerId,
      observedAt: report.updated_at.toISOString(),
      [kind === 'compute' ? 'profile' : 'browserProfile']: profile.success
        ? profile.data
        : null,
    };
    await tx`insert into allrice_execution_targets(organization_id,workspace_id,target_key,kind,label,state,capabilities,concurrency_limit,timeout_seconds,last_heartbeat_at,unavailable_reason,metadata)
      values(${organizationId},${workspaceId},${existing?.target_key ?? `allrice.cloud.${kind}`},'cloud_sandbox',${kind === 'compute' ? '云端计算' : '云端浏览器'},${ready ? 'online' : 'degraded'},${tx.json([...new Set([...(existing?.capabilities ?? []), capability])])},2,300,${report.updated_at},${ready ? null : (evidence.reason ?? 'platform_environment_preparing')},${tx.json(metadata)})
      on conflict(organization_id,workspace_id,target_key) do update set state=excluded.state,
        capabilities=excluded.capabilities,last_heartbeat_at=excluded.last_heartbeat_at,unavailable_reason=excluded.unavailable_reason,metadata=excluded.metadata,updated_at=clock_timestamp()
        where allrice_execution_targets.state<>'revoked'`;
  }
}

/** A tenant-wide membership covers all its workspaces. Explicit mutations use
 * this helper so activation, demotion and removal all update the same relation. */
export async function synchronizeTenantMembershipAccess(
  tx: Tx,
  input: {
    organizationId: string;
    workspaceId: string | null;
  },
) {
  const workspaces = await lockTenantEmployeeWorkspaces(tx, input);
  for (const workspace of workspaces)
    await synchronizeTenantEmployeeAccess(tx, {
      organizationId: input.organizationId,
      workspaceId: workspace.id,
    });
}

/** Membership writers take these locks before changing membership rows. This
 * matches publication/provisioning and avoids controls/member lock inversion. */
export async function lockTenantEmployeeWorkspaces(
  tx: Tx,
  input: { organizationId: string; workspaceId: string | null },
) {
  const workspaces = await tx`
    select id from allrice_workspaces where organization_id=${input.organizationId} and archived_at is null
      and (${input.workspaceId}::uuid is null or id=${input.workspaceId}) order by id`;
  for (const workspace of workspaces)
    await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-deployments:${input.organizationId}:${workspace.id}`},0))`;
  return workspaces;
}

/** Deployment bootstrap adds missing rules only. Existing pauses and explicit
 * decisions survive member joins, server restarts and environment repair. */
export async function prepareTenantExecutionDefaults(tx: Tx, scope: Scope) {
  const { organizationId, workspaceId } = scope;
  const rows =
    await tx`select r.runtime_profile->'toolNames' tools from allrice_platform_employee_tenant_assignments d
    join allrice_platform_employee_revisions r on r.id=d.revision_id
    where d.organization_id=${organizationId} and d.workspace_id=${workspaceId} and d.active`;
  const tools = rows.flatMap((r) =>
    Array.isArray(r.tools) ? (r.tools as string[]) : [],
  );
  if (!tools.length) return;
  await tx`select pg_advisory_xact_lock(hashtextextended(${`runtime-policy:${organizationId}:${workspaceId}`},0))`;
  const [row] =
    await tx`select version,controls from allrice_runtime_policy_controls where organization_id=${organizationId} and workspace_id=${workspaceId} for update`;
  const previous = RuntimePolicyControlsSchema.safeParse(row?.controls);
  if (row && !previous.success) return;
  const defaults = employeePublicationPolicy(
    undefined,
    tools,
    (row?.version ?? 0) + 1,
  );
  const missing = defaults.rules.filter(
    (rule) =>
      !previous.success ||
      !previous.data.rules.some((r) => r.action === rule.action),
  );
  if (previous.success && !missing.length) return;
  const controls = previous.success
    ? {
        ...previous.data,
        version: defaults.version,
        rules: [...previous.data.rules, ...missing],
      }
    : defaults;
  await tx`insert into allrice_runtime_policy_controls(organization_id,workspace_id,version,controls)
    values(${organizationId},${workspaceId},${controls.version},${tx.json(controls)})
    on conflict(organization_id,workspace_id) do update set version=excluded.version,controls=excluded.controls,updated_at=clock_timestamp()`;
}
