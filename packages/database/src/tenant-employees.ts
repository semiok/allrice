import {
  PlatformEmployeeDefinitionSchema,
  PlatformEmployeeRuntimeProfileSchema,
  TenantEmployeeChangeSchema,
  UuidSchema,
  type AdminTenantEmployee,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import {
  requireTenantAdministrationAuthority,
  requireTenantAdministrationTarget,
} from './tenant-administration.ts';
import { materializePlatformEmployeeRevision } from './employees/platform-employees.ts';
import { frozenPackageSkills } from './skill-bundles.ts';

type Revision = Parameters<
  typeof materializePlatformEmployeeRevision
>[1]['revision'];
export class TenantEmployeeError extends Error {
  constructor(
    readonly code:
      'employee_changed' | 'employee_not_published' | 'employee_not_assigned',
  ) {
    super(code);
  }
}
function capabilities(profile: unknown) {
  const runtime = PlatformEmployeeRuntimeProfileSchema.parse(profile);
  return {
    toolNames: runtime.toolNames,
    skills: runtime.runtimePackage
      ? frozenPackageSkills(runtime.runtimePackage).map(({ id, name }) => ({
          id,
          name,
        }))
      : [],
  };
}
export async function listAdminTenantEmployees(
  context: RequestContext,
  organizationInput: string,
  workspaceInput: string,
) {
  const organizationId = UuidSchema.parse(organizationInput),
    workspaceId = UuidSchema.parse(workspaceInput),
    sql = getDatabase();
  await requireTenantAdministrationAuthority(context, sql);
  await requireTenantAdministrationTarget(sql, organizationId, workspaceId);
  const rows = await sql`
    select p.id,p.status,r.id revision_id,r.revision,r.published_at,r.definition,r.runtime_profile,
      d.active,d.is_default,d.revision_id deployed_revision_id,d.tenant_employee_id,d.tenant_employee_version_id,
      dr.revision deployed_revision,dr.definition deployed_definition,dr.runtime_profile deployed_profile,
      case when d.id is null then null else md5(to_jsonb(d)::text) end deployment_version,
      (select count(distinct a.user_id)::integer from allrice_employee_assignments a
        join allrice_users u on u.id=a.user_id and u.status='active'
        where a.organization_id=${organizationId} and a.workspace_id=${workspaceId}
          and a.employee_id=d.tenant_employee_id and a.active
          and exists (select 1 from allrice_memberships m where m.user_id=a.user_id
            and m.organization_id=a.organization_id and (m.workspace_id is null or m.workspace_id=a.workspace_id)
            and m.active and m.role in ('admin','member'))) member_count
    from allrice_platform_employees p
    left join allrice_platform_employee_tenant_assignments d on d.employee_id=p.id
      and d.organization_id=${organizationId} and d.workspace_id=${workspaceId}
    join allrice_platform_employee_revisions r on r.id=coalesce(p.current_published_revision_id,d.revision_id)
    left join allrice_platform_employee_revisions dr on dr.id=d.revision_id
    where (p.status not in ('archived','disabled') and r.status='published') or d.id is not null
    order by coalesce(d.active,false) desc,coalesce(d.is_default,false) desc,p.name,p.id`;
  return {
    organizationId,
    workspaceId,
    employees: rows.map((row): AdminTenantEmployee => {
      const definition = PlatformEmployeeDefinitionSchema.parse(row.definition);
      return {
        employeeId: row.id,
        name: definition.name,
        description: definition.description,
        role: definition.identity.role,
        revisionId: row.revision_id,
        revision: row.revision,
        publishedAt: row.published_at?.toISOString() ?? null,
        ...capabilities(row.runtime_profile),
        canAssign: !['archived', 'disabled'].includes(row.status),
        deployment: row.deployment_version
          ? {
              active: row.active,
              isDefault: row.active && row.is_default,
              name: PlatformEmployeeDefinitionSchema.parse(
                row.deployed_definition,
              ).name,
              role: PlatformEmployeeDefinitionSchema.parse(
                row.deployed_definition,
              ).identity.role,
              description: PlatformEmployeeDefinitionSchema.parse(
                row.deployed_definition,
              ).description,
              revisionId: row.deployed_revision_id,
              revision: row.deployed_revision,
              tenantEmployeeId: row.tenant_employee_id,
              tenantVersionId: row.tenant_employee_version_id,
              version: row.deployment_version,
              memberCount: row.member_count,
              ...capabilities(row.deployed_profile),
            }
          : null,
      };
    }),
  };
}

export async function changeAdminTenantEmployee(
  context: RequestContext,
  organizationInput: string,
  input: unknown,
) {
  const organizationId = UuidSchema.parse(organizationInput),
    change = TenantEmployeeChangeSchema.parse(input),
    sql = getDatabase();
  return sql.begin(async (tx) => {
    await requireTenantAdministrationAuthority(context, tx);
    await requireTenantAdministrationTarget(
      tx,
      organizationId,
      change.workspaceId,
    );
    // Same employee-first lock order as publication; all workspace mutations serialize.
    const [employee] =
      await tx`select id,status,current_published_revision_id from allrice_platform_employees where id=${change.employeeId} for update`;
    if (!employee) throw new DataAccessError('not_found');
    await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-deployments:${organizationId}:${change.workspaceId}`},0))`;
    const [existing] =
      await tx`select d.*,md5(to_jsonb(d)::text) version from allrice_platform_employee_tenant_assignments d
      where d.employee_id=${change.employeeId} and d.organization_id=${organizationId} and d.workspace_id=${change.workspaceId} for update`;
    if (
      change.action === 'assign' &&
      existing?.active &&
      existing.revision_id === change.revisionId &&
      employee.current_published_revision_id === change.revisionId
    )
      return { changed: false };
    if (change.action === 'withdraw' && existing && !existing.active)
      return { changed: false };
    if (change.action === 'default' && existing?.active && existing.is_default)
      return { changed: false };
    if ((existing?.version ?? null) !== change.expectedVersion)
      throw new TenantEmployeeError('employee_changed');
    const [previousDefault] =
      await tx`select id from allrice_platform_employee_tenant_assignments where organization_id=${organizationId} and workspace_id=${change.workspaceId} and active and is_default`;
    if (change.action === 'assign') {
      if (
        ['disabled', 'archived'].includes(employee.status) ||
        employee.current_published_revision_id !== change.revisionId
      )
        throw new TenantEmployeeError('employee_not_published');
      const [revision] = await tx<
        Revision[]
      >`select * from allrice_platform_employee_revisions where employee_id=${change.employeeId} and id=${change.revisionId} and status='published' for share`;
      if (!revision?.runtime_profile)
        throw new TenantEmployeeError('employee_not_published');
      await materializePlatformEmployeeRevision(tx, {
        employeeId: change.employeeId,
        revision,
        definition: PlatformEmployeeDefinitionSchema.parse(revision.definition),
        workspaceIds: [change.workspaceId],
        actorLabel: context.actor.id,
      });
    } else {
      if (!existing?.active)
        throw new TenantEmployeeError('employee_not_assigned');
      if (existing.revision_id !== change.revisionId)
        throw new TenantEmployeeError('employee_changed');
      if (change.action === 'withdraw') {
        await tx`update allrice_platform_employee_tenant_assignments set active=false,is_default=false,updated_at=clock_timestamp() where id=${existing.id}`;
        await tx`update allrice_employee_assignments set active=false,is_default=false,updated_at=clock_timestamp()
          where organization_id=${organizationId} and workspace_id=${change.workspaceId} and employee_id=${existing.tenant_employee_id}`;
        await tx`update allrice_employees set status='archived',updated_at=clock_timestamp() where organization_id=${organizationId} and workspace_id=${change.workspaceId} and id=${existing.tenant_employee_id}`;
      }
    }
    // Keep a workspace default on the existing deployment record. The explicit
    // default action applies to current members; future-member inheritance is PR2.
    const [currentDefault] =
      await tx`select id from allrice_platform_employee_tenant_assignments where organization_id=${organizationId} and workspace_id=${change.workspaceId} and active and is_default`;
    if (
      change.action === 'default' ||
      !currentDefault ||
      (change.action === 'assign' && !previousDefault)
    ) {
      const [next] =
        await tx`select id,tenant_employee_id from allrice_platform_employee_tenant_assignments
        where organization_id=${organizationId} and workspace_id=${change.workspaceId} and active
          and (${change.action === 'default'}=false or employee_id=${change.employeeId})
        order by assigned_at,id limit 1`;
      if (next) {
        await tx`update allrice_platform_employee_tenant_assignments set is_default=false,updated_at=clock_timestamp()
          where organization_id=${organizationId} and workspace_id=${change.workspaceId} and is_default`;
        await tx`update allrice_platform_employee_tenant_assignments set is_default=true,updated_at=clock_timestamp() where id=${next.id}`;
        // Only change current members with access to the target employee.
        await tx`update allrice_employee_assignments a set is_default=false,updated_at=clock_timestamp()
          where a.organization_id=${organizationId} and a.workspace_id=${change.workspaceId} and a.is_default
            and exists(select 1 from allrice_employee_assignments target where target.organization_id=a.organization_id
              and target.workspace_id=a.workspace_id and target.user_id=a.user_id and target.employee_id=${next.tenant_employee_id} and target.active)`;
        await tx`update allrice_employee_assignments set is_default=true,updated_at=clock_timestamp()
          where organization_id=${organizationId} and workspace_id=${change.workspaceId} and employee_id=${next.tenant_employee_id} and active`;
      }
    }
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
      values(${organizationId},${change.workspaceId},${context.actor.id},${`tenant.employee.${change.action}`},'platform_employee',${change.employeeId},'recorded',${change.note || 'tenant_employee_management'},${context.requestId},
        ${tx.json({ actorOrganizationId: context.organizationId, revisionId: change.revisionId, previousVersion: existing?.version ?? null })})`;
    return { changed: true };
  });
}
