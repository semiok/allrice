import { randomUUID } from 'node:crypto';
import { CloudExecutionProfileSchema } from '@allrice/contracts';
import type postgres from 'postgres';
import { RuntimePolicyError } from '../runtime-policy.ts';

/** Publication authorizes the platform's installed sandbox for assigned users.
 * The target/profile is installed by the deployment after backend verification;
 * publication cannot invent a running backend or change its isolation profile. */
export async function enablePublishedDevelopmentCloud(
  tx: postgres.TransactionSql,
  input: { organizationId: string; workspaceId: string; employeeId: string },
) {
  const [target] = await tx<{ id: string; metadata: { profile?: unknown } }[]>`
    select id,metadata from allrice_execution_targets
    where organization_id=${input.organizationId} and workspace_id=${input.workspaceId}
      and kind='cloud_sandbox' and state='online' and capabilities ? 'process.execute'
      and metadata->>'managedBy'='allrice'
    order by created_at desc limit 1 for share`;
  const profile = CloudExecutionProfileSchema.safeParse(
    target?.metadata.profile,
  );
  if (!target || !profile.success)
    throw new RuntimePolicyError('cloud_runner_unavailable');
  const users = await tx<{ user_id: string }[]>`
    select distinct a.user_id from allrice_employee_assignments a
    join allrice_memberships m on m.user_id=a.user_id and m.organization_id=a.organization_id
      and (m.workspace_id is null or m.workspace_id=a.workspace_id) and m.active
    join allrice_users u on u.id=a.user_id and u.status='active'
    where a.organization_id=${input.organizationId} and a.workspace_id=${input.workspaceId}
      and a.employee_id=${input.employeeId} and a.active`;
  const installed: { grantId: string; ownerId: string }[] = [];
  for (const user of users) {
    const [existing] = await tx`
      select id from allrice_cloud_execution_grants
      where organization_id=${input.organizationId} and workspace_id=${input.workspaceId}
        and owner_id=${user.user_id} and target_id=${target.id} and enabled and revoked_at is null`;
    if (existing) continue;
    const grantId = randomUUID();
    await tx`insert into allrice_cloud_execution_grants
      (id,organization_id,workspace_id,owner_id,target_id,version,profile,enabled)
      values (${grantId},${input.organizationId},${input.workspaceId},${user.user_id},${target.id},1,${tx.json(profile.data)},true)`;
    installed.push({ grantId, ownerId: user.user_id });
  }
  return installed;
}
