-- Private repair records bind real Employee Runs and the existing cloud ledger.
-- No repository URL, filesystem path, shell, target or deployment comes from HTTP/model input.
create table allrice_platform_repair_tasks (
  id uuid primary key,
  request_id uuid not null,
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null references allrice_workspaces(id),
  owner_id uuid not null references allrice_users(id),
  run_id uuid not null unique references allrice_runs(id),
  job_id uuid not null unique references allrice_jobs(id),
  session_id uuid not null unique references allrice_chat_sessions(id),
  input_digest text not null check (input_digest ~ '^sha256:[a-f0-9]{64}$'),
  frozen jsonb not null check (jsonb_typeof(frozen)='object'),
  candidate jsonb not null check (jsonb_typeof(candidate)='object'),
  input_object_id uuid references allrice_storage_objects(id),
  report jsonb,
  created_at timestamptz not null default now(),
  unique(owner_id,request_id)
);
create index allrice_platform_repair_tasks_owner_created on allrice_platform_repair_tasks(owner_id,created_at desc);
create table allrice_platform_repair_candidates (
  task_id uuid not null references allrice_platform_repair_tasks(id),
  revision integer not null check (revision between 0 and 3),
  checksum text not null check (checksum ~ '^sha256:[a-f0-9]{64}$'),
  candidate jsonb not null check (jsonb_typeof(candidate)='object'),
  call_id text not null check (length(call_id) between 1 and 255),
  arguments_digest text not null check (arguments_digest ~ '^sha256:[a-f0-9]{64}$'),
  primary key(task_id,revision), unique(task_id,call_id)
);
create table allrice_platform_repair_verifications (
  task_id uuid not null references allrice_platform_repair_tasks(id),
  revision integer not null,
  operation_id uuid not null unique,
  command jsonb not null check (jsonb_typeof(command)='object'),
  command_digest text not null check (command_digest ~ '^sha256:[a-f0-9]{64}$'),
  proof jsonb not null check (jsonb_typeof(proof)='object'),
  observation jsonb,
  primary key(task_id,revision),
  foreign key(task_id,revision) references allrice_platform_repair_candidates(task_id,revision)
);
