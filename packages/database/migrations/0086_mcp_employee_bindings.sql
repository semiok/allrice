-- A tenant admin narrows a pre-authorized employee policy to one exact
-- connector and employee version. This never rewrites platform manifests.
create table allrice_employee_mcp_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  employee_id uuid not null,
  employee_version_id uuid not null,
  connector_binding_id uuid not null,
  enabled boolean not null,
  grant_revision integer not null default 1 check (grant_revision > 0),
  granted_by uuid not null references allrice_users(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (organization_id, workspace_id, employee_id, employee_version_id)
    references allrice_employee_versions(organization_id, workspace_id, employee_id, id),
  foreign key (organization_id, workspace_id, connector_binding_id)
    references allrice_mcp_binding_config(organization_id, workspace_id, binding_id),
  unique (organization_id, workspace_id, employee_id, employee_version_id, connector_binding_id),
  unique (organization_id, workspace_id, id)
);
create function allrice_guard_employee_mcp_binding() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then raise exception 'employee_mcp_binding_must_be_revoked'; end if;
  if ROW(new.id,new.organization_id,new.workspace_id,new.employee_id,new.employee_version_id,new.connector_binding_id,new.created_at)
    is distinct from ROW(old.id,old.organization_id,old.workspace_id,old.employee_id,old.employee_version_id,old.connector_binding_id,old.created_at)
    or new.grant_revision <= old.grant_revision then
    raise exception 'employee_mcp_binding_identity_or_revision_immutable';
  end if;
  return new;
end;
$$;
create trigger allrice_employee_mcp_binding_guard before update or delete
  on allrice_employee_mcp_bindings for each row execute function allrice_guard_employee_mcp_binding();
