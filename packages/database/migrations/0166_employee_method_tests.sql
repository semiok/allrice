-- Reuse the platform test scheduler, with private ownership separate from
-- platform template previews. Existing tests keep their original purpose.
alter table allrice_platform_employee_test_runs
  add column purpose text not null default 'platform_preview'
    check (purpose in ('platform_preview', 'method_candidate')),
  add column available_at timestamptz not null default now();

create table allrice_employee_method_tests (
  test_id uuid primary key references allrice_platform_employee_test_runs(id),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null references allrice_workspaces(id),
  owner_id uuid not null references allrice_users(id),
  employee_id uuid not null references allrice_employees(id),
  instance_id uuid not null references allrice_employee_instances(id),
  set_id uuid not null references allrice_employee_content_sets(id),
  candidate_revision_id uuid not null references allrice_employee_content_revisions(id),
  candidate_digest text not null,
  dependency_digest text not null,
  scene_id uuid not null,
  case_id text not null check(case_id = 'cny-total-v1'),
  environment text not null check(environment = 'isolated-text-v1'),
  request_id uuid not null,
  request_digest text not null,
  binding_digest text not null,
  source_run_id uuid not null references allrice_employee_runs(run_id),
  source_session_id uuid not null references allrice_chat_sessions(id),
  employee_version_id uuid not null references allrice_employee_versions(id),
  model_snapshot jsonb not null,
  candidate_snapshot jsonb not null,
  snapshot_digest text not null,
  run_id uuid unique references allrice_runs(id),
  route_decision_id uuid unique references allrice_route_decisions(id),
  assertion jsonb,
  created_at timestamptz not null default now(),
  unique(organization_id,workspace_id,owner_id,request_id),
  unique(organization_id,workspace_id,owner_id,instance_id,binding_digest)
);
create index allrice_employee_method_tests_owner_idx
  on allrice_employee_method_tests(organization_id,workspace_id,owner_id,instance_id,created_at desc);
create index allrice_platform_employee_tests_available_idx
  on allrice_platform_employee_test_runs(available_at,created_at,id) where status='queued';
