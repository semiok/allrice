import type postgres from 'postgres';
import type { getDatabase } from '../core/client.ts';
type Sql = postgres.TransactionSql | ReturnType<typeof getDatabase>;

export async function employeePublicationTargets(db: Sql, employeeId: string) {
  return db<
    { id: string; organization_id: string; organization_name: string }[]
  >`
    select w.id,w.organization_id,o.name as organization_name
    from allrice_platform_employee_tenant_assignments d
    join allrice_employees e on e.id=d.tenant_employee_id and e.status='active'
    join allrice_workspaces w on w.id=d.workspace_id and w.organization_id=d.organization_id
    join allrice_organizations o on o.id=w.organization_id
    where d.employee_id=${employeeId} and d.active and w.archived_at is null
      and o.archived_at is null and o.slug<>'allrice-platform' order by w.id`;
}

export async function employeePublicationReceipt(
  db: Sql,
  employeeId: string,
  workspaceIds: string[],
) {
  const companies = await db<
    {
      organizationId: string;
      name: string;
      peopleCount: number;
      workspaceCount: number;
    }[]
  >`
    select o.id as "organizationId",o.name,count(distinct a.user_id)::int as "peopleCount",count(distinct d.workspace_id)::int as "workspaceCount"
    from allrice_platform_employee_tenant_assignments d
    join allrice_organizations o on o.id=d.organization_id
    left join allrice_employee_assignments a on a.organization_id=d.organization_id and a.workspace_id=d.workspace_id
      and a.employee_id=d.tenant_employee_id and a.active and exists(select 1 from allrice_memberships m
        join allrice_users u on u.id=m.user_id and u.status='active'
        where m.organization_id=a.organization_id and m.user_id=a.user_id and m.active and m.role in ('admin','member')
          and (m.workspace_id is null or m.workspace_id=a.workspace_id))
    where d.employee_id=${employeeId} and d.active and d.workspace_id=any(${db.array(workspaceIds)}::uuid[])
    group by o.id,o.name order by o.name,o.id`;
  return {
    companyCount: companies.length,
    peopleCount: companies.reduce((n, c) => n + c.peopleCount, 0),
    workspaceCount: workspaceIds.length,
    companies,
  };
}

export class EmployeePublicationTargetError extends Error {
  readonly code = 'employee_publication_target_failed';
  constructor(
    public readonly workspaceId: string,
    public readonly organizationName: string,
  ) {
    super(
      `${organizationName} 更新未完成，本次整批未生效，所有公司保持原版本。可修复后重试。`,
    );
    this.name = 'EmployeePublicationTargetError';
  }
}
