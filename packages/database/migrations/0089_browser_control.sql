-- P21: explicit grants only. No defaults, employee permission or flag activation.
create table allrice_browser_control_grants (
 id uuid primary key, organization_id uuid not null, workspace_id uuid not null,
 owner_id uuid not null references allrice_users(id), target_id uuid not null,
 version integer not null check(version > 0), profile jsonb not null,
 enabled boolean not null default false, revoked_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,workspace_id,target_id) references allrice_execution_targets(organization_id,workspace_id,id),
 unique(organization_id,workspace_id,id)
);
create table allrice_browser_workspaces (
 id uuid primary key, organization_id uuid not null, workspace_id uuid not null,
 owner_id uuid not null references allrice_users(id), run_id uuid not null,
 session_id uuid not null, job_id uuid not null references allrice_jobs(id),
 worker_id uuid not null, job_lease_token uuid not null, job_attempt integer not null,
 task_id uuid not null, grant_id uuid not null, grant_version integer not null,
 profile_id uuid not null unique, profile jsonb not null, execution_context jsonb not null,
 state text not null default 'starting' check(state in ('starting','agent','takeover_pending','human','resume_pending','pause_pending','paused','close_pending','closed','unknown')),
 desired_control text not null default 'agent' check(desired_control in ('agent','human','paused','closed')),
 control_fence integer not null default 1 check(control_fence > 0),
 acknowledged_fence integer not null default 0,
 observation jsonb, last_heartbeat_at timestamptz, stopped_at timestamptz,
 expires_at timestamptz not null, created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,workspace_id,run_id) references allrice_runs(organization_id,workspace_id,id),
 foreign key(organization_id,workspace_id,grant_id) references allrice_browser_control_grants(organization_id,workspace_id,id),
 foreign key(organization_id,workspace_id,task_id) references allrice_managed_browser_tasks(organization_id,workspace_id,id),
 unique(organization_id,workspace_id,id), unique(job_id,job_attempt,task_id)
);
create table allrice_browser_control_requests (
 workspace_id uuid not null references allrice_browser_workspaces(id),
 request_id uuid not null, request jsonb not null, resulting_fence integer not null,
 created_at timestamptz not null default clock_timestamp(), primary key(workspace_id,request_id)
);
create table allrice_browser_operation_inputs (
 operation_id uuid primary key, browser_workspace_id uuid not null references allrice_browser_workspaces(id),
 binding jsonb not null, payload jsonb not null, observation jsonb,
 lease_token text, started_at timestamptz, result jsonb, receipt jsonb,
 created_at timestamptz not null default clock_timestamp()
);
create function allrice_browser_operation_input_immutable() returns trigger language plpgsql as $$
begin
 if old.operation_id is distinct from new.operation_id or old.browser_workspace_id is distinct from new.browser_workspace_id
 or old.binding is distinct from new.binding or old.payload is distinct from new.payload or old.observation is distinct from new.observation
 then raise exception 'browser operation inputs are immutable'; end if;
 return new;
end; $$;
create trigger allrice_browser_operation_input_immutable before update on allrice_browser_operation_inputs
 for each row execute function allrice_browser_operation_input_immutable();
create table allrice_browser_direct_inputs (
 id uuid primary key, browser_workspace_id uuid not null references allrice_browser_workspaces(id),
 owner_id uuid not null references allrice_users(id), fence integer not null,
 observation_id uuid not null, element_id text not null,
 envelope jsonb, expires_at timestamptz not null, consumed_at timestamptz,
 created_at timestamptz not null default clock_timestamp()
);
create index allrice_browser_workspace_active on allrice_browser_workspaces(worker_id,expires_at)
 where state not in ('closed','unknown');
create index allrice_browser_operations_pending on allrice_browser_operation_inputs(browser_workspace_id,created_at)
 where result is null;
