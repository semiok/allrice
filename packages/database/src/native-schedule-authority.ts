import type { TransactionSql } from 'postgres';
import {
  MembershipSchema,
  UuidSchema,
  type RequestContext,
} from '@allrice/contracts';
import { DataAccessError } from './data.ts';
import { readContentPrincipal } from './content-maintenance.ts';
import { assertWorkbenchSession } from './artifact-review.ts';
import { resolveEmployeeSessionInstance } from './employees/employee-instances.ts';
import type { ResourcePrincipal } from './resource-principal.ts';
type Tx = TransactionSql;
export type ScheduleScope = {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
};
export type ScheduleTarget = {
  id: string;
  employee_assignment_id: string;
  employee_instance_id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
};
export const scheduleIdentity = (s: ScheduleScope) => ({
  actor: { type: 'user' as const, id: s.ownerId },
  organizationId: s.organizationId,
  workspaceId: s.workspaceId,
});
/** Current rows, not a synthetic browser session or a saved membership list. */
export async function lockSchedulePrincipal(
  tx: Tx,
  scope: ScheduleScope,
  requestId: string,
  browser?: RequestContext,
): Promise<ResourcePrincipal> {
  for (const v of Object.values(scope)) UuidSchema.parse(v);
  const current = await readContentPrincipal(
    browser ?? scheduleIdentity(scope),
    tx,
    'update_user',
  );
  if (!current?.writable) throw new DataAccessError('authorization_denied');
  const rows = await tx<
    {
      id: string;
      user_id: string;
      organization_id: string;
      workspace_id: string | null;
      role: string;
      active: boolean;
    }[]
  >`
    select id,user_id,organization_id,workspace_id,role,active from allrice_memberships
    where organization_id=${scope.organizationId} and user_id=${scope.ownerId} and active
      and (workspace_id is null or workspace_id=${scope.workspaceId}) order by id for share`;
  return {
    ...scheduleIdentity(scope),
    requestId,
    memberships: rows.map((r) =>
      MembershipSchema.parse({
        id: r.id,
        userId: r.user_id,
        organizationId: r.organization_id,
        workspaceId: r.workspace_id,
        role: r.role,
        active: r.active,
      }),
    ),
  };
}

export async function readScheduleTarget(
  tx: Tx,
  scope: ScheduleScope,
  sessionId: string,
) {
  const [row] = await tx<ScheduleTarget[]>`
    select id,organization_id,workspace_id,owner_id,employee_assignment_id,
      coalesce(employee_instance_id,employee_assignment_id) employee_instance_id
    from allrice_chat_sessions where id=${UuidSchema.parse(sessionId)}
      and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
      and owner_id=${scope.ownerId} and archived_at is null`;
  if (!row) throw new DataAccessError('not_found');
  return row;
}

export async function lockScheduleTarget(
  tx: Tx,
  scope: ScheduleScope,
  target: ScheduleTarget,
) {
  const instance = await resolveEmployeeSessionInstance(
    scheduleIdentity(scope),
    target.employee_assignment_id,
    target.employee_instance_id,
    tx,
  );
  await assertWorkbenchSession(tx, scheduleIdentity(scope), target.id, true);
  // This lane is for ordinary work. Privileged platform drivers keep their own
  // existing authorization and cannot be scheduled by copying their IDs.
  const [ordinary] = await tx`
    select a.id from allrice_employee_assignments a
    join allrice_employees e on e.id=a.employee_id and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id
    where a.id=${target.employee_assignment_id} and a.organization_id=${scope.organizationId}
      and a.workspace_id=${scope.workspaceId} and a.user_id=${scope.ownerId} and a.active and e.status='active'
      and e.employee_key not like 'platform-%' for share of a,e`;
  if (!ordinary || instance.id !== target.employee_instance_id)
    throw new DataAccessError('authorization_denied');
  return instance;
}

export async function readScheduleBrowserScope(
  tx: Tx,
  context: RequestContext,
  sessionId: string,
) {
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  const [row] = await tx<{ workspace_id: string }[]>`
    select workspace_id from allrice_chat_sessions where id=${UuidSchema.parse(sessionId)}
      and organization_id=${context.organizationId} and owner_id=${context.actor.id}
      and (${context.workspaceId}::uuid is null or workspace_id=${context.workspaceId}) and archived_at is null`;
  if (!row) throw new DataAccessError('not_found');
  return {
    organizationId: context.organizationId,
    workspaceId: row.workspace_id,
    ownerId: context.actor.id,
  };
}
