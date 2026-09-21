import type postgres from 'postgres';
import { UuidSchema, McpError, type RequestContext } from '@allrice/contracts';
import type { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import {
  requireTenantAdministrationAuthority,
  requireTenantAdministrationTarget,
} from './tenant-administration.ts';

/** Server-side management target, never a replacement login or execution principal. */
export interface TenantManagementTarget {
  organizationId: string;
  workspaceId: string;
  subjectId: string;
}
export type ManagementSql =
  ReturnType<typeof getDatabase> | postgres.TransactionSql;

export async function requireTenantManagementScope(
  issuer: RequestContext,
  target: TenantManagementTarget,
  sql: ManagementSql,
) {
  const organizationId = UuidSchema.parse(target.organizationId),
    workspaceId = UuidSchema.parse(target.workspaceId),
    subjectId = UuidSchema.parse(target.subjectId);
  await requireTenantAdministrationAuthority(issuer, sql);
  await requireTenantAdministrationTarget(sql, organizationId, workspaceId);
  const [subject] = await sql`
    select u.id from allrice_users u join allrice_memberships m on m.user_id=u.id
    where u.id=${subjectId} and u.status='active' and m.active
      and m.organization_id=${organizationId}
      and (m.workspace_id is null or m.workspace_id=${workspaceId}) limit 1`;
  if (!subject) throw new DataAccessError('not_found');
  return { organizationId, workspaceId, subjectId, actorId: issuer.actor.id };
}

/** Options are constructed by trusted HTTP handlers; every store still rechecks
 * the real issuer and target inside the transaction that changes authority. */
export interface TenantManagementOptions extends TenantManagementTarget {
  issuer: RequestContext;
  reason: string;
  expectedConnection?: {
    id: string;
    revision: number;
    toolRevisionId?: string;
    toolGrantRevision?: number;
  };
}
export async function checkTenantManagement(
  sql: ManagementSql,
  options: TenantManagementOptions,
  scope: { organizationId: string; workspaceId: string; actorId: string },
) {
  if (
    scope.organizationId !== options.organizationId ||
    scope.workspaceId !== options.workspaceId ||
    scope.actorId !== options.issuer.actor.id
  )
    throw new DataAccessError('authorization_denied');
  const target = await requireTenantManagementScope(
    options.issuer,
    options,
    sql,
  );
  if (options.expectedConnection) {
    const expected = options.expectedConnection;
    const [row] =
      await sql`select binding_id from allrice_mcp_binding_config where binding_id=${UuidSchema.parse(expected.id)}
      and organization_id=${target.organizationId} and workspace_id=${target.workspaceId} and revision=${expected.revision} for update`;
    if (!row) throw new McpError('MCP_BINDING_CHANGED');
    if (expected.toolRevisionId) {
      const [tool] =
        await sql`select revision_id from allrice_mcp_tool_grants where binding_id=${expected.id} and revision_id=${expected.toolRevisionId} and grant_revision=${expected.toolGrantRevision ?? -1} for update`;
      if (!tool) throw new McpError('MCP_BINDING_CHANGED');
    }
  }
  return target;
}
export function tenantManagementScope(
  context: RequestContext,
  workspaceId: string,
  options: TenantManagementOptions,
) {
  if (
    context.actor.type !== 'user' ||
    context.actor.id !== options.issuer.actor.id ||
    context.sessionId !== options.issuer.sessionId ||
    workspaceId !== options.workspaceId
  )
    throw new DataAccessError('authorization_denied');
  return {
    organizationId: UuidSchema.parse(options.organizationId),
    workspaceId: UuidSchema.parse(workspaceId),
    actorId: context.actor.id,
  };
}
