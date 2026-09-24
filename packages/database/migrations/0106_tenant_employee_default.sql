-- Workspace default belongs to the existing published-employee deployment.
-- Individual assignment IDs and historical Session bindings remain unchanged.
alter table allrice_platform_employee_tenant_assignments
  add column is_default boolean not null default false;
with ranked as (
  select d.id, row_number() over (
    partition by d.organization_id,d.workspace_id
    order by (select count(*) from allrice_employee_assignments a
      where a.organization_id=d.organization_id and a.workspace_id=d.workspace_id
        and a.employee_id=d.tenant_employee_id and a.active and a.is_default) desc,
      d.assigned_at,d.id
  ) position
  from allrice_platform_employee_tenant_assignments d where d.active
)
update allrice_platform_employee_tenant_assignments d set is_default=true
from ranked r where r.id=d.id and r.position=1;
create unique index allrice_platform_employee_one_workspace_default
  on allrice_platform_employee_tenant_assignments(organization_id,workspace_id)
  where active and is_default;
