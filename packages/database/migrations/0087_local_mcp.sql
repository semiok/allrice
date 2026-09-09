-- Same connector, tool-revision and employee-grant authorities as P16.
-- A local transport never contains a cloud URL or cloud-held credential.
alter table allrice_mcp_binding_config add column transport text not null default 'streamable_http'
  check (transport in ('streamable_http','local_stdio'));
alter table allrice_mcp_binding_config alter column endpoint drop not null;
alter table allrice_mcp_binding_config add constraint allrice_mcp_transport_location
  check ((transport='streamable_http' and endpoint is not null)
    or (transport='local_stdio' and endpoint is null and credential_envelope='null'::jsonb));

create table allrice_local_mcp_config (
  binding_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  device_id uuid not null references allrice_bridge_devices(id),
  folder_grant_id uuid not null references allrice_bridge_folder_grants(id),
  folder_grant_version integer not null check (folder_grant_version > 0),
  configuration jsonb not null check (octet_length(configuration::text)<=32768),
  last_discovery_operation_id uuid references allrice_runtime_operations(id),
  foreign key (organization_id,workspace_id,binding_id)
    references allrice_mcp_binding_config(organization_id,workspace_id,binding_id),
  unique (organization_id,workspace_id,binding_id)
);
create function allrice_guard_local_mcp_identity() returns trigger language plpgsql as $$
begin
  if TG_OP='DELETE' or ROW(new.binding_id,new.organization_id,new.workspace_id,new.owner_id,new.device_id,new.folder_grant_id,new.folder_grant_version)
    is distinct from ROW(old.binding_id,old.organization_id,old.workspace_id,old.owner_id,old.device_id,old.folder_grant_id,old.folder_grant_version) then
    raise exception 'local_mcp_identity_immutable';
  end if;
  return new;
end $$;
create trigger allrice_local_mcp_identity before update or delete on allrice_local_mcp_config
  for each row execute function allrice_guard_local_mcp_identity();
