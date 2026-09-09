-- P23: a preview is derived from one already-approved, live local service.
-- It is not an ordinary public browser grant or a host port publication.
alter table allrice_local_services add column preview_heartbeat_at timestamptz;
alter table allrice_local_browser_grants add column purpose text not null default 'public'
  check (purpose in ('public','local_preview'));
create table allrice_local_preview_endpoints (
  id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null,
  device_id uuid not null,
  run_id uuid not null,
  process_id uuid not null,
  browser_workspace_id uuid not null unique references allrice_browser_workspaces(id),
  browser_grant_id uuid not null unique references allrice_local_browser_grants(grant_id),
  endpoint_lease_id uuid not null unique,
  target jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (organization_id,workspace_id,run_id) references allrice_runs(organization_id,workspace_id,id),
  foreign key (organization_id,workspace_id,process_id) references allrice_runtime_operations(organization_id,workspace_id,id),
  foreign key (organization_id,workspace_id,device_id,owner_id) references allrice_bridge_devices(organization_id,workspace_id,id,owner_id),
  unique (organization_id,workspace_id,process_id),
  check (target->>'endpointId'=id::text and target->>'processId'=process_id::text
    and target->>'browserWorkspaceId'=browser_workspace_id::text and target->>'browserGrantId'=browser_grant_id::text
    and target->>'ownerId'=owner_id::text and target->>'deviceId'=device_id::text and target->>'runId'=run_id::text
    and target->'scope'->>'organizationId'=organization_id::text and target->'scope'->>'workspaceId'=workspace_id::text)
);
create function allrice_local_preview_immutable() returns trigger language plpgsql as $$
begin
  if new is distinct from old then raise exception 'local preview endpoint identity is immutable'; end if;
  return new;
end;
$$;
create trigger allrice_local_preview_immutable before update on allrice_local_preview_endpoints
  for each row execute function allrice_local_preview_immutable();
create function allrice_local_browser_grant_purpose_immutable() returns trigger language plpgsql as $$
begin
  if new.purpose is distinct from old.purpose then raise exception 'local browser grant purpose is immutable'; end if;
  return new;
end;
$$;
create trigger allrice_local_browser_grant_purpose_immutable before update on allrice_local_browser_grants
  for each row execute function allrice_local_browser_grant_purpose_immutable();
