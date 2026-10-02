-- A fixed, read-only PDF reader has independent authority. No existing device,
-- folder grant, Python grant or historical frozen Run receives this permission.
create table allrice_bridge_pdf_runtime_grants (
  id uuid primary key,
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null references allrice_workspaces(id),
  owner_id uuid not null references allrice_users(id),
  device_id uuid not null unique references allrice_bridge_devices(id),
  profile_version integer not null check (profile_version=1),
  root_fingerprint text not null check (root_fingerprint ~ '^[a-f0-9]{64}$'),
  runtime_generation integer not null default 1 check (runtime_generation>0),
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);
create table allrice_bridge_pdf_profiles (
  device_id uuid primary key references allrice_bridge_devices(id),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null references allrice_workspaces(id),
  profile jsonb not null,
  reported_at timestamptz not null default clock_timestamp()
);
create table allrice_local_pdf_delegations (
  operation_id uuid primary key,
  run_id uuid not null references allrice_runs(id),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null references allrice_workspaces(id),
  owner_id uuid not null references allrice_users(id),
  device_id uuid not null references allrice_bridge_devices(id),
  job_id uuid not null references allrice_jobs(id),
  job_worker_id uuid not null,
  job_attempt integer not null check (job_attempt>0),
  job_lease_token uuid not null,
  call_id text not null check (length(call_id) between 1 and 255),
  tool_name text not null check (tool_name='workspace.document.read'),
  original_arguments jsonb not null,
  source jsonb not null,
  file_name text not null check (length(file_name) between 1 and 1024),
  request_digest text not null check (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique(run_id,call_id)
);
create function allrice_local_pdf_origin_immutable() returns trigger language plpgsql as $$
begin
  if new is distinct from old then raise exception 'immutable read-only PDF origin'; end if;
  return new;
end $$;
create trigger allrice_local_pdf_origin_immutable before update on allrice_local_pdf_delegations
  for each row execute function allrice_local_pdf_origin_immutable();
create function allrice_bridge_revoke_pdf_runtime() returns trigger language plpgsql as $$
begin
  if new.revoked_at is not null and old.revoked_at is null then
    update allrice_bridge_pdf_runtime_grants set revoked_at=new.revoked_at,runtime_generation=runtime_generation+1
      where device_id=new.id and revoked_at is null;
  end if;
  return new;
end $$;
create trigger allrice_bridge_revoke_pdf_runtime after update of revoked_at on allrice_bridge_devices
  for each row execute function allrice_bridge_revoke_pdf_runtime();

alter table allrice_bridge_devices drop constraint if exists allrice_bridge_devices_capabilities_allowed_check;
alter table allrice_bridge_devices add constraint allrice_bridge_devices_capabilities_allowed_check check (capabilities <@ array[
  'local.fs.list','local.fs.search','local.fs.read','local.fs.write','local.fs.mkdir','local.git.status','local.git.diff',
  'local.file.inspect','local.file.import','local.file.save','local.file.open','local.file.reveal','local.file.select','local.python.execute','local.pdf.read'
]::text[]);
