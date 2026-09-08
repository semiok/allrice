-- P11: transport connection ownership only. Commands/leases remain in the existing ledger.
create table allrice_bridge_connections (
  device_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  connection_id uuid not null unique,
  server_id uuid not null,
  epoch bigint not null check(epoch > 0),
  expires_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp(),
  foreign key(organization_id,workspace_id,device_id)
    references allrice_bridge_devices(organization_id,workspace_id,id)
);

create function allrice_notify_bridge_connection() returns trigger language plpgsql as $$
begin
  perform pg_notify('allrice_bridge_connection',new.device_id::text);
  return new;
end $$;
create trigger allrice_bridge_connection_changed after insert or update of connection_id,expires_at
  on allrice_bridge_connections for each row execute function allrice_notify_bridge_connection();

create function allrice_notify_bridge_device_revoked() returns trigger language plpgsql as $$
begin
  if new.revoked_at is not null and old.revoked_at is null then
    update allrice_bridge_connections set expires_at=clock_timestamp(),updated_at=clock_timestamp()
      where device_id=new.id;
    perform pg_notify('allrice_bridge_connection',new.id::text);
  end if;
  return new;
end $$;
create trigger allrice_bridge_device_connection_revoked after update of revoked_at
  on allrice_bridge_devices for each row execute function allrice_notify_bridge_device_revoked();

create function allrice_notify_bridge_runtime_operation() returns trigger language plpgsql as $$
begin
  if new.device_id is not null then
    perform pg_notify('allrice_bridge_runtime_operation',new.device_id::text);
  end if;
  return new;
end $$;
create trigger allrice_bridge_runtime_operation_changed after insert or update of snapshot
  on allrice_runtime_operations for each row execute function allrice_notify_bridge_runtime_operation();
