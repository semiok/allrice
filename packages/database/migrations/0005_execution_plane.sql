alter table allrice_runs drop constraint if exists allrice_runs_state_check;
update allrice_runs set state = 'queued' where state = 'created';
update allrice_runs set state = 'canceled' where state = 'cancelled';
alter table allrice_runs
  add constraint allrice_runs_state_check
  check (state in (
    'queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'canceled'
  ));

alter table allrice_runs
  add column policy_snapshot_id uuid references allrice_policy_snapshots(id),
  add column execution_spec jsonb not null default '{}',
  add column input jsonb,
  add column result jsonb,
  add column error_code text,
  add column error_message text,
  add column request_id uuid,
  add column started_at timestamptz,
  add column completed_at timestamptz;

create table allrice_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  run_id uuid not null,
  status text not null default 'queued'
    check (status in (
      'queued', 'claimed', 'running', 'retry_wait',
      'succeeded', 'failed', 'dead_letter', 'canceled'
    )),
  idempotency_key text not null check (length(idempotency_key) between 1 and 255),
  priority integer not null default 0 check (priority between -100 and 100),
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  available_at timestamptz not null default now(),
  timeout_at timestamptz not null,
  payload jsonb not null,
  worker_id uuid,
  lease_token uuid,
  claimed_at timestamptz,
  heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  cancel_requested_at timestamptz,
  cancel_reason text,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  foreign key (organization_id, workspace_id, run_id)
    references allrice_runs(organization_id, workspace_id, id),
  unique (organization_id, idempotency_key),
  unique (organization_id, workspace_id, id),
  unique (run_id),
  check (timeout_at > created_at),
  check (
    (worker_id is null and lease_token is null and claimed_at is null
      and heartbeat_at is null and lease_expires_at is null)
    or
    (worker_id is not null and lease_token is not null and claimed_at is not null
      and heartbeat_at is not null and lease_expires_at is not null)
  )
);

create table allrice_run_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  run_id uuid not null,
  sequence integer not null check (sequence >= 0),
  event_type text not null check (event_type in (
    'run.created', 'run.started', 'step.started', 'step.completed',
    'artifact.created', 'approval.requested', 'approval.decided',
    'run.succeeded', 'run.failed', 'run.canceled', 'heartbeat'
  )),
  schema_version integer not null default 1 check (schema_version = 1),
  payload jsonb not null default '{}',
  occurred_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, run_id)
    references allrice_runs(organization_id, workspace_id, id),
  unique (run_id, sequence),
  unique (organization_id, workspace_id, id)
);

create index allrice_jobs_claimable
  on allrice_jobs (priority desc, available_at, created_at, id)
  where status = 'queued' and cancel_requested_at is null;
create index allrice_jobs_maintenance
  on allrice_jobs (status, lease_expires_at, available_at, timeout_at);
create index allrice_runs_owner_activity
  on allrice_runs (organization_id, workspace_id, owner_id, updated_at desc);
create index allrice_run_events_replay
  on allrice_run_events (organization_id, workspace_id, run_id, sequence);

insert into allrice_runtime_metadata (key, value)
values (
  'execution-plane-schema',
  '{"version":"0005","queue":"postgres","scheduler":"worker-module","eventSchemaVersion":1}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
