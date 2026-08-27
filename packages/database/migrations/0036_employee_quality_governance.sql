-- MET-62: employee evaluation, release gates, feedback and rollout governance.

create table allrice_employee_eval_suites (
  id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  employee_id uuid not null,
  version integer not null check (version > 0),
  name text not null,
  status text not null default 'active'
    check (status in ('active', 'retired')),
  cases jsonb not null check (jsonb_typeof(cases) = 'array'),
  thresholds jsonb not null check (jsonb_typeof(thresholds) = 'object'),
  created_by uuid not null references allrice_users(id),
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, employee_id)
    references allrice_employees(organization_id, workspace_id, id),
  unique (employee_id, version),
  unique (organization_id, workspace_id, id)
);

create table allrice_employee_eval_runs (
  id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  employee_id uuid not null,
  employee_version_id uuid not null,
  eval_suite_id uuid not null,
  harness text not null check (harness in ('codex', 'dsh')),
  provider text not null,
  model text not null,
  status text not null check (status in ('passed', 'failed')),
  metrics jsonb not null check (jsonb_typeof(metrics) = 'object'),
  violations jsonb not null default '[]'::jsonb
    check (jsonb_typeof(violations) = 'array'),
  created_by uuid not null references allrice_users(id),
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, employee_id)
    references allrice_employees(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, employee_version_id)
    references allrice_employee_versions(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, eval_suite_id)
    references allrice_employee_eval_suites(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, id)
);

create index allrice_employee_eval_runs_gate
  on allrice_employee_eval_runs (
    organization_id, workspace_id, employee_id, employee_version_id,
    created_at desc
  );

create table allrice_employee_releases (
  organization_id uuid not null,
  workspace_id uuid not null,
  employee_id uuid not null,
  stable_version_id uuid not null,
  candidate_version_id uuid,
  stage text not null default 'production'
    check (stage in ('draft', 'internal_test', 'canary', 'production', 'disabled')),
  traffic_percentage integer not null default 100
    check (traffic_percentage between 0 and 100),
  gate_status text not null default 'pending'
    check (gate_status in ('pending', 'passed', 'blocked')),
  approved_by uuid references allrice_users(id),
  approved_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (organization_id, workspace_id, employee_id),
  foreign key (organization_id, workspace_id, employee_id)
    references allrice_employees(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, stable_version_id)
    references allrice_employee_versions(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, candidate_version_id)
    references allrice_employee_versions(organization_id, workspace_id, id)
);

create table allrice_run_feedback (
  organization_id uuid not null,
  workspace_id uuid not null,
  run_id uuid not null,
  message_id uuid not null,
  actor_id uuid not null references allrice_users(id),
  helpful boolean not null,
  reason text,
  reviewed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (run_id, actor_id),
  foreign key (organization_id, workspace_id, run_id)
    references allrice_employee_runs(organization_id, workspace_id, run_id),
  foreign key (organization_id, workspace_id, message_id)
    references allrice_messages(organization_id, workspace_id, id)
);

insert into allrice_runtime_metadata (key, value)
values (
  'employee-quality-governance',
  '{"version":"0036","issue":"MET-62","releaseStages":["draft","internal_test","canary","production","disabled"],"criticalFailuresBlockRelease":true}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
