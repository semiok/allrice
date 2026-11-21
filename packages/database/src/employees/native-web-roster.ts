import { createHash } from 'node:crypto';
import { UuidSchema, type RequestContext } from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import {
  ensureGeneralEmployeeInstance,
  getEmployeeInstance,
  listEmployeeInstances,
  lockEmployeeInstanceAdmissionIdentity,
} from './employee-instances.ts';

export type PersonNativeWebRoster = Readonly<{
  personId: string;
  organizationId: string;
  entries: readonly Readonly<{
    workspaceId: string;
    employeeInstanceId: string;
    employeeRevision: number;
    employeeVersionId: string;
  }>[];
  digest: string;
}>;

/** Trusted host only. Materializes existing assignments, never assigns an
 * employee, creates a Run, reads history, or accepts a browser-supplied roster.
 * The page's selected workspace is not the person's complete VM roster. */
export async function preparePersonNativeWebRoster(
  context: RequestContext,
  sql = getDatabase(),
): Promise<PersonNativeWebRoster> {
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  const personId = UuidSchema.parse(context.actor.id),
    organizationId = UuidSchema.parse(context.organizationId);
  return sql.begin(async (tx) => {
    const workspaces = await tx<{ id: string }[]>`
      select w.id from allrice_workspaces w
      join allrice_organizations o on o.id=w.organization_id and o.archived_at is null
      join allrice_users u on u.id=${personId} and u.status='active'
      where w.organization_id=${organizationId} and w.archived_at is null
        and exists(select 1 from allrice_memberships m
          where m.organization_id=w.organization_id and m.user_id=u.id and m.active
            and m.role in ('admin','member') and (m.workspace_id is null or m.workspace_id=w.id))
      order by w.id`;
    if (!workspaces.length) throw new DataAccessError('authorization_denied');
    const entries: PersonNativeWebRoster['entries'][number][] = [];
    for (const workspace of workspaces) {
      const scope = { ...context, workspaceId: workspace.id };
      // Existing admission identity lock also rechecks session expiry/revocation,
      // current membership and organization; stale context.memberships is ignored.
      await lockEmployeeInstanceAdmissionIdentity(tx, scope);
      const assignments = await tx<{ id: string }[]>`
        select a.id from allrice_employee_assignments a
        join allrice_employees e on e.id=a.employee_id and e.organization_id=a.organization_id
          and e.workspace_id=a.workspace_id and e.status='active'
        join allrice_employee_versions v on v.id=a.employee_version_id and v.employee_id=e.id
          and v.organization_id=a.organization_id and v.workspace_id=a.workspace_id
        where a.organization_id=${organizationId} and a.workspace_id=${workspace.id}
          and a.user_id=${personId} and a.active
          and not exists(select 1 from allrice_platform_employee_tenant_assignments d
            where d.organization_id=a.organization_id and d.workspace_id=a.workspace_id
              and d.tenant_employee_id=e.id and not d.active)
        order by a.id for share of a,e`;
      for (const assignment of assignments)
        await ensureGeneralEmployeeInstance(tx, assignment.id);
      const allowed = new Set(assignments.map(({ id }) => id));
      for (const instance of await listEmployeeInstances(
        scope,
        workspace.id,
        tx,
      )) {
        if (!allowed.has(instance.assignmentId)) continue;
        const current = await getEmployeeInstance(scope, instance.id, tx);
        entries.push(
          Object.freeze({
            workspaceId: workspace.id,
            employeeInstanceId: current.id,
            employeeRevision: current.revision,
            employeeVersionId: current.source.employeeVersionId,
          }),
        );
      }
    }
    entries.sort((a, b) =>
      a.employeeInstanceId.localeCompare(b.employeeInstanceId),
    );
    const facts = { personId, organizationId, entries: Object.freeze(entries) };
    return Object.freeze({
      ...facts,
      digest: `sha256:${createHash('sha256').update(JSON.stringify(facts)).digest('hex')}`,
    });
  });
}
