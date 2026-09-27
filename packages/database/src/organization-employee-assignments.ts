import type postgres from 'postgres';
import {
  OrganizationAiChangeSchema,
  OrganizationAiTargetSchema,
  PlatformEmployeeDefinitionSchema,
  UuidSchema,
  type OrganizationAiTarget,
  type OrganizationAiCatalog,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import {
  requireTenantAdministrationAuthority,
  requireTenantAdministrationTarget,
} from './tenant-administration.ts';
import {
  listAdminTenantEmployees,
  TenantEmployeeError,
} from './tenant-employees.ts';
import { materializePlatformEmployeeRevision } from './employees/platform-employees.ts';
import { synchronizeTenantEmployeeAccess } from './tenant-employee-access.ts';
import { requestRunCancellationTransaction } from './execution/queue.ts';

type Sql = ReturnType<typeof getDatabase> | postgres.TransactionSql;
type Revision = Parameters<
  typeof materializePlatformEmployeeRevision
>[1]['revision'];
async function targetPeople(
  db: Sql,
  organizationId: string,
  workspaceId: string,
  input: OrganizationAiTarget,
) {
  const target = OrganizationAiTargetSchema.parse(input);
  const selected =
    target.type === 'selected' ? [...new Set(target.userIds)] : null;
  const search = target.type === 'search' ? target.search.toLowerCase() : null;
  const rows = await db<{ id: string }[]>`
    select u.id from allrice_users u
    left join allrice_organization_people p on p.organization_id=${organizationId} and p.user_id=u.id
    where exists(select 1 from allrice_memberships m where m.organization_id=${organizationId} and m.user_id=u.id
      and (m.workspace_id is null or m.workspace_id=${workspaceId}))
    and (${selected === null} or u.id=any(${db.array(selected ?? [])}::uuid[]))
    and (${search}::text is null or position(${search} in lower(coalesce(p.display_name,u.display_name)||' '||coalesce(u.username,'')||' '||coalesce(p.job_title,'')))>0)
    order by u.id`;
  if (selected && rows.length !== selected.length)
    throw new DataAccessError('not_found');
  return rows.map((r) => r.id);
}

export async function listOrganizationAiAssignments(
  context: RequestContext,
  organizationInput: string,
  workspaceInput: string,
  target: OrganizationAiTarget = { type: 'all' },
): Promise<OrganizationAiCatalog> {
  const organizationId = UuidSchema.parse(organizationInput),
    workspaceId = UuidSchema.parse(workspaceInput),
    db = getDatabase();
  const catalog = await listAdminTenantEmployees(
    context,
    organizationId,
    workspaceId,
  );
  const people = await targetPeople(db, organizationId, workspaceId, target);
  const counts = await db`
    select d.employee_id,d.inherit_by_default,
      count(a.id) filter(where a.active and u.status='active' and exists(select 1 from allrice_memberships m
        where m.organization_id=a.organization_id and m.user_id=a.user_id and m.active and m.role in ('admin','member')
          and (m.workspace_id is null or m.workspace_id=a.workspace_id)))::int as assigned,
      count(a.id) filter(where a.selection_mode='exclude')::int as excluded,
      count(a.id) filter(where a.selection_mode='include')::int as included
    from allrice_platform_employee_tenant_assignments d
    left join allrice_employee_assignments a on a.organization_id=d.organization_id and a.workspace_id=d.workspace_id
      and a.employee_id=d.tenant_employee_id and a.user_id=any(${db.array(people)}::uuid[])
    left join allrice_users u on u.id=a.user_id
    where d.organization_id=${organizationId} and d.workspace_id=${workspaceId}
    group by d.employee_id,d.inherit_by_default`;
  return {
    ...catalog,
    targetCount: people.length,
    employees: catalog.employees.map((e) => {
      const count = counts.find((c) => c.employee_id === e.employeeId);
      return {
        ...e,
        inheritedByDefault:
          e.deployment?.active === true && count?.inherit_by_default === true,
        targetAssignedCount: Number(count?.assigned ?? 0),
        targetExcludedCount: Number(count?.excluded ?? 0),
        targetIncludedCount: Number(count?.included ?? 0),
      };
    }),
  };
}

/** Personal assignment choices and the company default roster share one
 * deployment lock with global publication and membership inheritance. */
export async function changeOrganizationAiAssignments(
  context: RequestContext,
  organizationInput: string,
  input: unknown,
) {
  const organizationId = UuidSchema.parse(organizationInput),
    change = OrganizationAiChangeSchema.parse(input);
  return getDatabase().begin(async (tx) => {
    await requireTenantAdministrationAuthority(context, tx);
    await requireTenantAdministrationTarget(
      tx,
      organizationId,
      change.workspaceId,
    );
    const [platform] =
      await tx`select id,status,current_published_revision_id from allrice_platform_employees
      where id=${change.employeeId} for update`;
    if (!platform) throw new DataAccessError('not_found');
    await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-deployments:${organizationId}:${change.workspaceId}`},0))`;
    const [existing] =
      await tx`select d.*,md5(to_jsonb(d)::text) as version from allrice_platform_employee_tenant_assignments d
      where employee_id=${change.employeeId} and organization_id=${organizationId} and workspace_id=${change.workspaceId} for update`;
    if ((existing?.version ?? null) !== change.expectedVersion)
      throw new TenantEmployeeError('employee_changed');
    const people = await targetPeople(
      tx,
      organizationId,
      change.workspaceId,
      change.target,
    );
    const enables =
      change.action === 'include' ||
      (change.action === 'default' && change.defaultEnabled === true);
    if (
      enables &&
      (['archived', 'disabled'].includes(platform.status) ||
        platform.current_published_revision_id !== change.revisionId)
    )
      throw new TenantEmployeeError('employee_not_published');
    // An explicit per-person addition to a withdrawn company deployment must
    // not implicitly restore the other people's old personal additions.
    if (existing && !existing.active && change.action === 'include') {
      await tx`update allrice_employee_assignments set selection_mode='exclude',active=false,is_default=false,updated_at=clock_timestamp()
        where organization_id=${organizationId} and workspace_id=${change.workspaceId} and employee_id=${existing.tenant_employee_id}`;
      await tx`update allrice_platform_employee_tenant_assignments set inherit_by_default=false where id=${existing.id}`;
    }
    if (
      !existing ||
      (enables &&
        (!existing.active || existing.revision_id !== change.revisionId))
    ) {
      if (!enables && change.action !== 'exclude')
        return {
          targetCount: people.length,
          changedCount: 0,
          cancellationRequestedCount: 0,
        };
      if (
        ['archived', 'disabled'].includes(platform.status) ||
        platform.current_published_revision_id !== change.revisionId
      )
        throw new TenantEmployeeError('employee_not_published');
      const [revision] = await tx<
        Revision[]
      >`select * from allrice_platform_employee_revisions
        where id=${change.revisionId} and employee_id=${change.employeeId} and status='published'`;
      if (!revision?.runtime_profile)
        throw new TenantEmployeeError('employee_not_published');
      await materializePlatformEmployeeRevision(tx, {
        employeeId: change.employeeId,
        revision,
        definition: PlatformEmployeeDefinitionSchema.parse(revision.definition),
        workspaceIds: [change.workspaceId],
        actorLabel: context.actor.id,
        inheritByDefault: change.action === 'default',
      });
    }
    const [deployment] =
      await tx`select * from allrice_platform_employee_tenant_assignments
      where employee_id=${change.employeeId} and organization_id=${organizationId} and workspace_id=${change.workspaceId}`;
    if (!deployment) throw new TenantEmployeeError('employee_not_assigned');
    let changedCount = 0;
    if (change.action === 'default') {
      const changed =
        await tx`update allrice_platform_employee_tenant_assignments set inherit_by_default=${change.defaultEnabled!},updated_at=clock_timestamp()
        where id=${deployment.id} and inherit_by_default<>${change.defaultEnabled!} returning id`;
      changedCount = changed.length;
    } else if (people.length) {
      const changed = await tx`insert into allrice_employee_assignments
        (organization_id,workspace_id,employee_id,employee_version_id,user_id,active,is_default,selection_mode,assigned_by)
        select ${organizationId},${change.workspaceId},${deployment.tenant_employee_id},${deployment.tenant_employee_version_id},u.id,false,false,${change.action},${context.actor.id}
        from allrice_users u where u.id=any(${tx.array(people)}::uuid[])
        on conflict(organization_id,workspace_id,user_id,employee_id) do update
          set selection_mode=excluded.selection_mode,assigned_by=excluded.assigned_by,updated_at=clock_timestamp()
          where allrice_employee_assignments.selection_mode<>excluded.selection_mode returning id`;
      changedCount = changed.length;
      if (changedCount)
        await tx`update allrice_platform_employee_tenant_assignments set updated_at=clock_timestamp() where id=${deployment.id}`;
    }
    await synchronizeTenantEmployeeAccess(tx, {
      organizationId,
      workspaceId: change.workspaceId,
    });
    const runs = await tx<
      { run_id: string }[]
    >`select er.run_id from allrice_employee_runs er
      join allrice_employee_assignments a on a.id=er.employee_assignment_id
      join allrice_jobs j on j.run_id=er.run_id
      where a.organization_id=${organizationId} and a.workspace_id=${change.workspaceId}
        and a.employee_id=${deployment.tenant_employee_id} and not a.active
        and j.status not in ('succeeded','failed','dead_letter','canceled')
        and j.cancel_requested_at is null order by er.run_id`;
    for (const run of runs)
      await requestRunCancellationTransaction(
        tx,
        context,
        run.run_id,
        '管理员已移除本人的 AI 员工',
        true,
      );
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
      values(${organizationId},${change.workspaceId},${context.actor.id},'organization.ai_assignment.updated','platform_employee',${change.employeeId},'recorded',${change.action},${context.requestId},
        ${tx.json({ action: change.action, defaultEnabled: change.defaultEnabled ?? null, targetCount: people.length, changedCount, cancellationRequestedCount: runs.length, userIds: people })})`;
    return {
      targetCount: people.length,
      changedCount,
      cancellationRequestedCount: runs.length,
    };
  });
}
