import { randomUUID } from 'node:crypto';
import {
  CloudExecutionProfileSchema,
  BrowserProfileSchema,
} from '@allrice/contracts';
import type postgres from 'postgres';
type Tx = postgres.TransactionSql;
type Scope = { organizationId: string; workspaceId: string };

/** Existing cloud grants remain the execution authority. A revoked/paused grant
 * suppresses automatic preparation, including after restart or republishing. */
export async function prepareTenantCloudGrants(tx: Tx, scope: Scope) {
  const { organizationId, workspaceId } = scope;
  const targets = await tx<
    {
      id: string;
      capabilities: string[];
      metadata: { profile?: unknown; browserProfile?: unknown };
    }[]
  >`
    select id,capabilities,metadata from allrice_execution_targets
    where organization_id=${organizationId} and workspace_id=${workspaceId} and kind='cloud_sandbox'
      and state='online' and metadata->>'managedBy'='allrice' order by created_at desc,id`;
  for (const kind of ['compute', 'browser'] as const) {
    const target = targets.find((t) =>
      t.capabilities.includes(
        kind === 'compute' ? 'process.execute' : 'browser.navigate',
      ),
    );
    const parsed =
      kind === 'compute'
        ? CloudExecutionProfileSchema.safeParse(target?.metadata.profile)
        : BrowserProfileSchema.safeParse(target?.metadata.browserProfile);
    if (!target || !parsed.success) continue;
    const users = await tx<{ user_id: string }[]>`
      select distinct a.user_id from allrice_employee_assignments a
      join allrice_employee_versions v on v.id=a.employee_version_id
      join allrice_platform_employee_tenant_assignments d on d.tenant_employee_id=a.employee_id
        and d.organization_id=a.organization_id and d.workspace_id=a.workspace_id and d.active
      join allrice_memberships m on m.organization_id=a.organization_id and m.user_id=a.user_id
        and (m.workspace_id is null or m.workspace_id=a.workspace_id) and m.active and m.role in ('admin','member')
      join allrice_users u on u.id=a.user_id and u.status='active'
      where a.organization_id=${organizationId} and a.workspace_id=${workspaceId} and a.active
        and v.manifest->'capabilityBindings'->'toolNames' ? ${kind === 'compute' ? 'cloud.process.execute' : 'browser.workspace'}`;
    for (const user of users) {
      const existing =
        kind === 'compute'
          ? await tx`select id,enabled,revoked_at from allrice_cloud_execution_grants
            where organization_id=${organizationId} and workspace_id=${workspaceId} and owner_id=${user.user_id}`
          : await tx`select id,enabled,revoked_at,profile from allrice_browser_control_grants
            where organization_id=${organizationId} and workspace_id=${workspaceId} and owner_id=${user.user_id} and transport='cloud'`;
      if (
        existing.some((g) => !g.enabled || g.revoked_at) ||
        existing.some(
          (g) => kind === 'compute' || g.profile?.network === 'public_https',
        )
      )
        continue;
      const id = randomUUID();
      if (kind === 'compute')
        await tx`insert into allrice_cloud_execution_grants(id,organization_id,workspace_id,owner_id,target_id,version,profile,enabled)
          values(${id},${organizationId},${workspaceId},${user.user_id},${target.id},1,${tx.json(parsed.data)},true)`;
      else
        await tx`insert into allrice_browser_control_grants(id,organization_id,workspace_id,owner_id,target_id,version,profile,enabled)
          values(${id},${organizationId},${workspaceId},${user.user_id},${target.id},1,${tx.json(parsed.data)},true)`;
      await tx`insert into allrice_audit_events(organization_id,workspace_id,action,resource_type,resource_id,decision,reason,metadata)
        values(${organizationId},${workspaceId},'tenant.cloud.prepared',${kind === 'compute' ? 'cloud_grant' : 'browser_grant'},${id},'recorded','published_employee_membership',${tx.json({ ownerId: user.user_id, targetId: target.id })})`;
    }
  }
}
