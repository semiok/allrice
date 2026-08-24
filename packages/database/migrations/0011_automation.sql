create table allrice_automations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  name text not null check (length(name) between 1 and 160),
  description text not null default '',
  prompt text not null check (length(prompt) between 1 and 40000),
  trigger_type text not null default 'schedule'
    check (trigger_type in ('schedule')),
  schedule jsonb not null,
  status text not null default 'enabled'
    check (status in ('enabled', 'paused')),
  employee_assignment_id uuid,
  session_id uuid,
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  foreign key (organization_id, workspace_id, employee_assignment_id)
    references allrice_employee_assignments(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, session_id)
    references allrice_chat_sessions(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, id)
);

create table allrice_automation_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  automation_id uuid not null,
  run_id uuid,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  scheduled_for timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, automation_id)
    references allrice_automations(organization_id, workspace_id, id)
    on delete cascade,
  foreign key (organization_id, workspace_id, run_id)
    references allrice_runs(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, id),
  unique (automation_id, scheduled_for)
);

create index allrice_automations_due
  on allrice_automations (status, next_run_at)
  where status = 'enabled' and next_run_at is not null;
create index allrice_automation_runs_history
  on allrice_automation_runs (organization_id, workspace_id, automation_id, created_at desc);

insert into allrice_runtime_metadata (key, value)
values (
  'automation-schema',
  '{"version":"0011","triggers":["schedule"],"executor":"employee-run"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
