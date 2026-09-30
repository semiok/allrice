import type postgres from 'postgres';
import { UuidSchema } from '@allrice/contracts';
import { isPlatformAdmin } from '../platform-authority.ts';

export class PlatformPreviewContextError extends Error {}

export interface PlatformPreviewContext {
  workspace_id: string;
  workspace_name: string;
  organization_id: string;
  membership_id: string;
  owner_id: string;
  role: 'admin' | 'member' | 'viewer';
}

/** Platform previews never borrow a company member or discover an online Bridge. */
export async function resolvePlatformPreviewContext(
  tx: postgres.TransactionSql,
  input: {
    environment?: 'platform' | 'company';
    workspaceId: string | null;
    ownerId: string | null;
  },
  actorLabel: string,
  provision = false,
) {
  const environment =
    input.environment ?? (input.workspaceId ? 'company' : 'platform');
  let workspaceId = input.workspaceId;
  let ownerId = input.ownerId;
  if (environment === 'platform') {
    const actor = UuidSchema.safeParse(actorLabel);
    if (
      !actor.success ||
      !(await isPlatformAdmin({ actor: { type: 'user', id: actor.data } }, tx))
    )
      throw new PlatformPreviewContextError(
        '平台测试需要有效的平台管理员账号。',
      );
    ownerId = actor.data;
    if (input.ownerId && input.ownerId !== ownerId)
      throw new PlatformPreviewContextError('平台测试不能借用其他员工的身份。');
    const [organization] = await tx<{ id: string }[]>`
      select id from allrice_organizations where slug='allrice-platform' and archived_at is null`;
    if (!organization)
      throw new PlatformPreviewContextError(
        '平台测试环境尚未初始化，请重新登录管理后台。',
      );
    // One private test workspace per administrator, inside the existing internal organization.
    const slug = `employee-tests-${ownerId}`;
    if (provision)
      await tx`insert into allrice_workspaces(organization_id,slug,name)
        values(${organization.id},${slug},'平台测试') on conflict(organization_id,slug) do nothing`;
    const [workspace] = await tx<{ id: string }[]>`
      select id from allrice_workspaces where organization_id=${organization.id} and slug=${slug} and archived_at is null`;
    if (!workspace || (input.workspaceId && input.workspaceId !== workspace.id))
      throw new PlatformPreviewContextError('平台测试工作区不可用。');
    workspaceId = workspace.id;
    if (provision) {
      const [member] = await tx`select id from allrice_memberships
        where organization_id=${organization.id} and user_id=${ownerId}
          and (workspace_id is null or workspace_id=${workspaceId})`;
      if (!member)
        await tx`insert into allrice_memberships(organization_id,workspace_id,user_id,role)
          values(${organization.id},${workspaceId},${ownerId},'member') on conflict do nothing`;
    }
  } else if (!workspaceId || !ownerId) {
    throw new PlatformPreviewContextError(
      '公司环境测试需要明确选择工作区和员工，不会自动借用成员身份。',
    );
  }
  const [context] = await tx<PlatformPreviewContext[]>`
    select w.id workspace_id,w.name workspace_name,w.organization_id,
      m.id membership_id,m.user_id owner_id,m.role
    from allrice_workspaces w
    join allrice_organizations o on o.id=w.organization_id and o.archived_at is null
    join allrice_memberships m on m.organization_id=w.organization_id
      and (m.workspace_id is null or m.workspace_id=w.id) and m.active
    join allrice_users u on u.id=m.user_id and u.status='active'
    where w.id=${workspaceId} and w.archived_at is null and m.user_id=${ownerId}
      and (o.slug='allrice-platform')=${environment === 'platform'}
    order by (m.workspace_id is null) desc,m.created_at,m.id limit 1`;
  if (!context)
    throw new PlatformPreviewContextError(
      '测试环境或所选员工已不可用，请重新选择。',
    );
  return { environment, context };
}
