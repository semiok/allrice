-- MET-73: durable, approval-aware Workflow runtime.

alter table allrice_runs drop constraint if exists allrice_runs_state_check;
alter table allrice_runs add constraint allrice_runs_state_check check (state in (
  'queued', 'running', 'waiting_approval', 'succeeded', 'failed',
  'canceled', 'needs_attention'
));

alter table allrice_jobs drop constraint if exists allrice_jobs_status_check;
alter table allrice_jobs add constraint allrice_jobs_status_check check (status in (
  'queued', 'claimed', 'running', 'waiting_approval', 'retry_wait',
  'succeeded', 'failed', 'dead_letter', 'canceled'
));

alter table allrice_run_events drop constraint if exists allrice_run_events_event_type_check;
alter table allrice_run_events add constraint allrice_run_events_event_type_check check (event_type in (
  'run.created', 'run.started', 'run.retrying',
  'step.started', 'step.completed', 'step.waiting_approval', 'step.retrying',
  'step.compensating', 'step.compensated',
  'assistant.text.delta', 'assistant.text.completed',
  'tool.started', 'tool.completed', 'tool.failed',
  'artifact.created', 'approval.requested', 'approval.decided',
  'run.succeeded', 'run.failed', 'run.canceled', 'run.needs_attention',
  'heartbeat'
));

create table allrice_workflow_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  run_id uuid not null,
  employee_id uuid not null,
  workflow_revision_id uuid not null,
  session_id uuid,
  status text not null default 'queued' check (status in (
    'queued', 'running', 'waiting_approval', 'succeeded', 'failed',
    'canceled', 'needs_attention'
  )),
  definition_snapshot jsonb not null check (jsonb_typeof(definition_snapshot) = 'object'),
  input jsonb,
  output jsonb,
  current_step_key text,
  checkpoint jsonb not null default '{}'::jsonb check (jsonb_typeof(checkpoint) = 'object'),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  foreign key (organization_id, workspace_id, run_id)
    references allrice_runs(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, employee_id)
    references allrice_employees(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, workflow_revision_id)
    references allrice_workflow_revisions(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, session_id)
    references allrice_chat_sessions(organization_id, workspace_id, id),
  unique (run_id),
  unique (organization_id, workspace_id, id)
);

create table allrice_workflow_step_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  workflow_run_id uuid not null,
  step_key text not null check (step_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  name text not null,
  step_kind text not null check (step_kind in ('model', 'agent_skill', 'knowledge', 'tool', 'approval')),
  status text not null default 'pending' check (status in (
    'pending', 'running', 'waiting_approval', 'succeeded', 'failed',
    'skipped', 'compensating', 'compensated', 'needs_attention'
  )),
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null check (max_attempts between 1 and 10),
  input jsonb,
  input_digest text check (input_digest is null or input_digest ~ '^sha256:[a-f0-9]{64}$'),
  output jsonb,
  output_digest text check (output_digest is null or output_digest ~ '^sha256:[a-f0-9]{64}$'),
  idempotency_key text not null check (length(idempotency_key) between 1 and 255),
  side_effect_committed boolean not null default false,
  approval_id uuid references allrice_approval_requests(id),
  checkpoint jsonb not null default '{}'::jsonb check (jsonb_typeof(checkpoint) = 'object'),
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, workflow_run_id)
    references allrice_workflow_runs(organization_id, workspace_id, id),
  unique (workflow_run_id, step_key),
  unique (organization_id, idempotency_key),
  unique (organization_id, workspace_id, id),
  check ((lease_token is null) = (lease_expires_at is null))
);

create table allrice_workflow_artifacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  workflow_run_id uuid not null,
  step_key text not null,
  storage_object_id uuid not null,
  name text not null,
  media_type text not null,
  checksum text not null check (checksum ~ '^sha256:[a-f0-9]{64}$'),
  size_bytes bigint not null check (size_bytes >= 0),
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, workflow_run_id)
    references allrice_workflow_runs(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, storage_object_id)
    references allrice_storage_objects(organization_id, workspace_id, id),
  unique (workflow_run_id, step_key, storage_object_id),
  unique (organization_id, workspace_id, id)
);

create table allrice_workflow_evaluations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  workflow_run_id uuid not null,
  metrics jsonb not null check (jsonb_typeof(metrics) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, workflow_run_id)
    references allrice_workflow_runs(organization_id, workspace_id, id),
  unique (workflow_run_id),
  unique (organization_id, workspace_id, id)
);

create index allrice_workflow_runs_employee_activity
  on allrice_workflow_runs (organization_id, workspace_id, employee_id, created_at desc);
create index allrice_workflow_runs_session_activity
  on allrice_workflow_runs (organization_id, workspace_id, session_id, created_at desc)
  where session_id is not null;
create index allrice_workflow_steps_recovery
  on allrice_workflow_step_runs (status, lease_expires_at, updated_at);

insert into allrice_runtime_metadata (key, value)
values (
  'durable-workflow-schema',
  '{"version":"0028","issue":"MET-73","checkpoint":"per-step","approval":"durable","sideEffects":"idempotency-required"}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
