-- Keep personal choices on the authoritative assignment, not a parallel ACL.
alter table allrice_employee_assignments add column selection_mode text not null default 'inherit'
  check (selection_mode in ('inherit','include','exclude'));
alter table allrice_platform_employee_tenant_assignments add column inherit_by_default boolean not null default true;
-- New company accounts use their administrator's roster from the first login.
-- Legacy bootstrap workspaces retain compatibility until the explicit migration.
alter table allrice_organizations add column managed_employee_roster boolean not null default false;

-- Retain existing explicit personal withdrawals where current membership and
-- deployment would otherwise reactivate them. Disabled scopes still inherit.
update allrice_employee_assignments a set selection_mode='exclude'
where not a.active and exists (
  select 1 from allrice_platform_employee_tenant_assignments d
  join allrice_employees e on e.id=d.tenant_employee_id and e.status='active'
  where d.organization_id=a.organization_id and d.workspace_id=a.workspace_id
    and d.tenant_employee_id=a.employee_id and d.active
) and exists (
  select 1 from allrice_memberships m join allrice_users u on u.id=m.user_id and u.status='active'
  where m.user_id=a.user_id and m.organization_id=a.organization_id and m.active and m.role in ('admin','member')
    and (m.workspace_id is null or m.workspace_id=a.workspace_id)
);
