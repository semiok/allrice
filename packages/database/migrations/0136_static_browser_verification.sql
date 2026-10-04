-- A finite verification of immutable saved HTML; no live service/port/preview lease.
alter table allrice_local_browser_grants drop constraint allrice_local_browser_grants_purpose_check;
alter table allrice_local_browser_grants add constraint allrice_local_browser_grants_purpose_check
  check (purpose in ('public','local_preview','static_artifact'));
create table allrice_static_browser_verifications (
  id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  run_id uuid not null,
  session_id uuid not null,
  job_id uuid not null,
  worker_id uuid not null,
  job_attempt integer not null,
  job_lease_token uuid not null,
  call_id text not null,
  request_digest text not null,
  target jsonb not null,
  plan jsonb not null,
  execution_context jsonb not null,
  location text not null check (location in ('local','cloud')),
  execution_reason text not null,
  device_id uuid,
  browser_workspace_id uuid,
  target_id uuid not null,
  parent_grant_id uuid not null,
  parent_grant_version integer not null,
  attempt_id uuid not null unique,
  container_id text,
  browser_version text,
  state text not null default 'admitted' check (state in ('admitted','running','completed','unknown')),
  deadline_at timestamptz not null,
  started_at timestamptz,
  outcome jsonb,
  report_version_id uuid,
  screenshot_version_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  foreign key (organization_id,workspace_id,run_id) references allrice_runs(organization_id,workspace_id,id),
  foreign key (organization_id,workspace_id) references allrice_workspaces(organization_id,id),
  unique (organization_id,workspace_id,run_id,call_id),
  check ((location='local') = (device_id is not null)),
  check (state<>'completed' or (outcome is not null and report_version_id is not null and screenshot_version_id is not null))
);
create index allrice_static_browser_workspace on allrice_static_browser_verifications(browser_workspace_id)
  where browser_workspace_id is not null;
create function allrice_static_browser_input_immutable() returns trigger language plpgsql as $$
begin
  if (to_jsonb(old)-array['state','started_at','container_id','browser_version','outcome','report_version_id','screenshot_version_id','completed_at'])
    is distinct from (to_jsonb(new)-array['state','started_at','container_id','browser_version','outcome','report_version_id','screenshot_version_id','completed_at'])
    or (old.container_id is not null and old.container_id is distinct from new.container_id)
    or (old.outcome is not null and old.outcome is distinct from new.outcome)
    or (old.state in ('completed','unknown') and old.state is distinct from new.state)
  then raise exception 'static browser inputs and accepted evidence are immutable'; end if;
  return new;
end; $$;
create trigger allrice_static_browser_input_immutable before update on allrice_static_browser_verifications
  for each row execute function allrice_static_browser_input_immutable();
