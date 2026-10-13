import type postgres from 'postgres';
import {
  ContentMaintenanceLevelSchema,
  ContentOwnershipSchema,
  evaluateContentAccess,
  type ContentAccessDecision,
  type ContentOwnership,
  type ContentPrincipal,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';

type Sql = ReturnType<typeof getDatabase> | postgres.TransactionSql;

/** Never cache this principal in a Session/Run or trust context.memberships.
 * A new read resolves current membership, department and maintenance level.
 * Writes call this inside their transaction, after any storage-quota gate and
 * before locking content. SHARE locks serialize with revocation/profile edits. */
export async function readContentPrincipal(
  context: RequestContext,
  sql: Sql = getDatabase(),
  lockForWrite = false,
): Promise<ContentPrincipal | null> {
  if (context.actor.type !== 'user') return null;
  if (lockForWrite) {
    await sql`select id from allrice_organizations where id=${context.organizationId} for share`;
    if (context.workspaceId)
      await sql`select id from allrice_workspaces where id=${context.workspaceId} and organization_id=${context.organizationId} for share`;
    await sql`select id from allrice_users where id=${context.actor.id} for share`;
    if (context.sessionId)
      await sql`select id from allrice_sessions where id=${context.sessionId} and user_id=${context.actor.id} for share`;
    await sql`select id from allrice_memberships where organization_id=${context.organizationId} and user_id=${context.actor.id} and active and (workspace_id is null or workspace_id=${context.workspaceId}) order by id for share`;
    await sql`select user_id from allrice_organization_people where organization_id=${context.organizationId} and user_id=${context.actor.id} for share`;
  }
  const [row] = await sql<
    {
      department_id: string | null;
      maintenance_level: string;
      writable: boolean;
    }[]
  >`select d.id as department_id,coalesce(p.content_maintenance_level,'personal') as maintenance_level,
      exists(select 1 from allrice_memberships m where m.organization_id=o.id and m.user_id=u.id and m.active and m.role in ('admin','member') and (m.workspace_id is null or m.workspace_id=${context.workspaceId})) as writable
    from allrice_users u join allrice_organizations o on o.id=${context.organizationId} and o.archived_at is null
    left join allrice_organization_people p on p.organization_id=o.id and p.user_id=u.id
    left join allrice_departments d on d.organization_id=o.id and d.id=p.department_id and d.archived_at is null
    where u.id=${context.actor.id} and u.status='active'
      and exists(select 1 from allrice_memberships m where m.organization_id=o.id and m.user_id=u.id and m.active and (m.workspace_id is null or m.workspace_id=${context.workspaceId}))
      and (${context.workspaceId}::uuid is null or exists(select 1 from allrice_workspaces w where w.id=${context.workspaceId} and w.organization_id=o.id and w.archived_at is null))
      and (${context.sessionId ?? null}::uuid is null or exists(select 1 from allrice_sessions s where s.id=${context.sessionId ?? null} and s.user_id=u.id and s.revoked_at is null and s.expires_at>clock_timestamp()))`;
  return row
    ? {
        userId: context.actor.id,
        organizationId: context.organizationId,
        departmentId: row.department_id,
        maintenanceLevel: ContentMaintenanceLevelSchema.parse(
          row.maintenance_level,
        ),
        writable: row.writable,
      }
    : null;
}

/** Ownership comes from the authoritative content row, not a user's choice of
 * scope. For new content the caller checks the requested target before insert.
 * Platform writes keep using their separate, existing administration boundary. */
export async function getContentAccess(
  context: RequestContext,
  ownershipInput: ContentOwnership,
  sql: Sql = getDatabase(),
  lockForWrite = false,
): Promise<ContentAccessDecision> {
  const ownership = ContentOwnershipSchema.parse(ownershipInput);
  const principal = await readContentPrincipal(context, sql, lockForWrite);
  const decision = evaluateContentAccess(principal, ownership);
  if (!decision.canRead || ownership.scope !== 'department') return decision;
  const [department] = lockForWrite
    ? await sql`select id from allrice_departments where organization_id=${ownership.organizationId} and id=${ownership.departmentId} and archived_at is null for share`
    : await sql`select id from allrice_departments where organization_id=${ownership.organizationId} and id=${ownership.departmentId} and archived_at is null`;
  return department
    ? decision
    : {
        canRead: false,
        canMaintain: false,
        readReason: 'department_unavailable',
        maintenanceReason: 'department_unavailable',
      };
}

export async function requireContentMaintenance(
  context: RequestContext,
  ownership: ContentOwnership,
  tx: postgres.TransactionSql,
) {
  const decision = await getContentAccess(context, ownership, tx, true);
  if (!decision.canMaintain) throw new DataAccessError('authorization_denied');
  return decision;
}
