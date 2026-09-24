import type postgres from 'postgres';
import {
  TenantMemberChangeSchema,
  UuidSchema,
  type AdminTenant,
  type AdminTenantMember,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import {
  synchronizeTenantMembershipAccess,
  lockTenantEmployeeWorkspaces,
} from './tenant-employee-access.ts';
import { DataAccessError } from './data.ts';
import { isPlatformAdmin } from './providers/model-pool.ts';

type Sql = ReturnType<typeof getDatabase> | postgres.TransactionSql;
export class TenantAdministrationError extends Error {
  constructor(
    readonly code: 'member_conflict' | 'last_administrator' | 'scope_mismatch',
  ) {
    super(code);
  }
}

/** The issuer stays in their actual login context; target tenant is a separate input. */
export async function requireTenantAdministrationAuthority(
  context: RequestContext,
  sql: Sql,
) {
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  if (!(await isPlatformAdmin(context, sql)))
    throw new DataAccessError('authorization_denied');
  const [current] = await sql`
    select s.id from allrice_sessions s
    join allrice_users u on u.id=s.user_id and u.status='active'
    join allrice_organizations o on o.id=${context.organizationId} and o.archived_at is null
    where s.id=${context.sessionId} and s.user_id=${context.actor.id}
      and s.revoked_at is null and s.expires_at>now()
      and (${context.workspaceId}::uuid is null or exists(select 1 from allrice_workspaces w
        where w.id=${context.workspaceId} and w.organization_id=o.id and w.archived_at is null))
      and exists(select 1 from allrice_memberships m where m.user_id=u.id
        and m.organization_id=o.id and m.active
        and (${context.workspaceId}::uuid is null or m.workspace_id is null or m.workspace_id=${context.workspaceId}))
    limit 1`;
  if (!current) throw new DataAccessError('authorization_denied');
}
const requireAdministrator = requireTenantAdministrationAuthority;

export async function requireTenantAdministrationTarget(
  sql: Sql,
  organizationId: string,
  workspaceId: string | null,
) {
  const [found] = await sql`
    select id from allrice_organizations where id=${organizationId} and archived_at is null
      and (${workspaceId}::uuid is null or exists(select 1 from allrice_workspaces w
        where w.organization_id=allrice_organizations.id and w.id=${workspaceId} and w.archived_at is null))`;
  if (!found) throw new DataAccessError('not_found');
}
const target = requireTenantAdministrationTarget;

export async function listAdminTenants(
  context: RequestContext,
  cursor?: string,
  database = getDatabase(),
) {
  const after = cursor ? UuidSchema.parse(cursor) : null;
  await requireAdministrator(context, database);
  const tenants = await database<{ id: string; name: string; slug: string }[]>`
    select id,name,slug from allrice_organizations where archived_at is null
      and (${after}::uuid is null or id>${after}) order by id limit 101`;
  const page = tenants.slice(0, 100);
  const workspaces = page.length
    ? await database<
        { id: string; name: string; slug: string; organization_id: string }[]
      >`
    select id,name,slug,organization_id from allrice_workspaces
    where organization_id in ${database(page.map((t) => t.id))} and archived_at is null order by name,id`
    : [];
  return {
    tenants: page.map((t) => ({
      ...t,
      workspaces: workspaces
        .filter((w) => w.organization_id === t.id)
        .map(({ id, name, slug }) => ({ id, name, slug })),
    })) satisfies AdminTenant[],
    nextCursor: tenants.length > 100 ? page.at(-1)!.id : null,
  };
}

function member(row: Record<string, unknown>): AdminTenantMember {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    displayName: row.display_name as string,
    email: row.email as string,
    userStatus: row.status as AdminTenantMember['userStatus'],
    workspaceId: row.workspace_id as string | null,
    role: row.role as AdminTenantMember['role'],
    active: row.active as boolean,
    version: row.version as string,
  };
}

export async function listAdminTenantMembers(
  context: RequestContext,
  organizationInput: string,
  workspaceInput: string | null,
  cursor?: string,
  database = getDatabase(),
) {
  const organizationId = UuidSchema.parse(organizationInput),
    workspaceId =
      workspaceInput === null ? null : UuidSchema.parse(workspaceInput);
  const after = cursor ? UuidSchema.parse(cursor) : null;
  await requireAdministrator(context, database);
  await target(database, organizationId, workspaceId);
  const rows = await database`
    select m.*,u.display_name,u.email,u.status,md5(to_jsonb(m)::text) as version
    from allrice_memberships m join allrice_users u on u.id=m.user_id
    where m.organization_id=${organizationId}
      and (${workspaceId}::uuid is null or m.workspace_id is null or m.workspace_id=${workspaceId})
      and (${after}::uuid is null or m.id>${after}) order by m.id limit 101`;
  return {
    organizationId,
    workspaceId,
    members: rows.slice(0, 100).map(member),
    nextCursor: rows.length > 100 ? (rows[99]!.id as string) : null,
  };
}

export async function updateAdminTenantMember(
  context: RequestContext,
  organizationInput: string,
  memberInput: string,
  input: unknown,
  database = getDatabase(),
) {
  const organizationId = UuidSchema.parse(organizationInput),
    membershipId = UuidSchema.parse(memberInput);
  const change = TenantMemberChangeSchema.parse(input);
  return database.begin(async (tx) => {
    await requireAdministrator(context, tx);
    // Serialize role changes for the tenant so concurrent demotions cannot remove both final admins.
    const [organization] =
      await tx`select id from allrice_organizations where id=${organizationId} and archived_at is null for no key update`;
    if (!organization) throw new DataAccessError('not_found');
    await target(tx, organizationId, change.workspaceId);
    await lockTenantEmployeeWorkspaces(tx, {
      organizationId,
      workspaceId: change.workspaceId,
    });
    const [row] = await tx`
      select m.*,u.status,u.email,u.display_name,md5(to_jsonb(m)::text) as version
      from allrice_memberships m join allrice_users u on u.id=m.user_id
      where m.id=${membershipId} and m.organization_id=${organizationId} for update of m`;
    if (!row) throw new DataAccessError('not_found');
    if (row.workspace_id !== change.workspaceId)
      throw new TenantAdministrationError('scope_mismatch');
    if (row.version !== change.expectedVersion)
      throw new TenantAdministrationError('member_conflict');
    if (
      row.active &&
      row.role === 'admin' &&
      (!change.active || change.role !== 'admin')
    ) {
      const [other] = await tx`
        select m.id from allrice_memberships m join allrice_users u on u.id=m.user_id and u.status='active'
        where m.organization_id=${organizationId} and m.id<>${membershipId} and m.active and m.role='admin'
          and (m.workspace_id is null or (${row.workspace_id}::uuid is not null and m.workspace_id=${row.workspace_id})) limit 1`;
      if (!other) throw new TenantAdministrationError('last_administrator');
    }
    if (row.active === change.active && row.role === change.role)
      return { member: member(row), changed: false };
    const [updated] = await tx`
      update allrice_memberships m set role=${change.role},active=${change.active},updated_at=clock_timestamp()
      where id=${membershipId} returning m.*,md5(to_jsonb(m)::text) as version`;
    await synchronizeTenantMembershipAccess(tx, {
      organizationId,
      workspaceId: row.workspace_id,
    });
    await tx`
      insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
      values(${organizationId},${row.workspace_id},${context.actor.id},'tenant.member.updated','membership',${membershipId},'recorded',${change.reason || 'tenant_member_updated'},${context.requestId},
        ${tx.json({
          actorOrganizationId: context.organizationId,
          targetUserId: row.user_id,
          before: { role: row.role, active: row.active, version: row.version },
          after: {
            role: change.role,
            active: change.active,
            version: updated!.version,
          },
          scope: row.workspace_id === null ? 'organization' : 'workspace',
          deviceAuthorizationChanged: false,
        })})`;
    return { member: member({ ...row, ...updated }), changed: true };
  });
}
