-- P25 additive, default OFF. Runs and shared root budgets remain authoritative.
create table allrice_assistant_roots (
  root_run_id uuid primary key references allrice_runtime_roots(root_run_id),
  configuration jsonb not null,
  worker_job_id uuid not null references allrice_jobs(id),
  worker_id uuid not null,
  generation bigint not null check (generation >= 0),
  fence bigint not null default 1 check (fence > 0),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create table allrice_assistant_instances (
  run_id uuid primary key references allrice_runtime_run_links(run_id),
  root_run_id uuid not null references allrice_assistant_roots(root_run_id),
  parent_run_id uuid references allrice_assistant_instances(run_id),
  native_session_id text not null check(length(native_session_id) between 1 and 200),
  delegation_id uuid not null unique,
  creation_digest text not null,
  label text not null,
  depth integer not null check (depth between 0 and 3),
  allowed_tools jsonb not null,
  artifact_namespace text not null unique,
  status text not null check (status in ('provisioning','running','waiting','completed','partial','failed','cancel_requested','canceled','unknown')),
  cancel_request_id uuid,
  cancel_requested_at timestamptz,
  stopped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((run_id = root_run_id) = (parent_run_id is null)),
  check ((cancel_request_id is null) = (cancel_requested_at is null))
);
create index allrice_assistant_instances_root on allrice_assistant_instances(root_run_id, created_at);
create unique index allrice_assistant_child_native_identity on allrice_assistant_instances(native_session_id) where depth>0;
create table allrice_assistant_messages (
  input_id uuid primary key,
  root_run_id uuid not null references allrice_assistant_roots(root_run_id),
  sender_run_id uuid not null references allrice_assistant_instances(run_id),
  recipient_run_id uuid not null references allrice_assistant_instances(run_id),
  content text not null,
  content_digest text not null,
  native_message_id text,
  durable_seq bigint,
  adopted_seq bigint,
  status text not null check (status in ('pending','dispatching','accepted','durable','adopted','unknown','canceled')),
  created_at timestamptz not null default now(),
  unique (recipient_run_id, native_message_id),
  check (durable_seq is null or native_message_id is not null),
  check (adopted_seq is null or durable_seq is not null)
);
create table allrice_assistant_results (
  delivery_id uuid primary key,
  run_id uuid not null references allrice_assistant_instances(run_id),
  root_run_id uuid not null references allrice_assistant_roots(root_run_id),
  payload jsonb not null,
  payload_digest text not null,
  parent_message_id text,
  parent_adopted_seq bigint,
  created_at timestamptz not null default now()
);
-- Model and non-operation tool usage reserve in the SAME root budget rows as P03.
create table allrice_assistant_usage (
  call_id uuid not null,
  run_id uuid not null references allrice_assistant_instances(run_id),
  root_run_id uuid not null,
  metric text not null,
  amount bigint not null check (amount >= 0),
  settled_amount bigint check (settled_amount >= 0),
  created_at timestamptz not null default now(),
  primary key (call_id, metric),
  foreign key (root_run_id, metric) references allrice_runtime_budgets(root_run_id, metric)
);
-- Immutable isolated outputs, never a shared mutable destination path.
create table allrice_assistant_artifacts (
  run_id uuid not null references allrice_assistant_instances(run_id),
  relative_path text not null,
  artifact_id uuid not null,
  digest text not null,
  created_at timestamptz not null default now(),
  primary key (run_id, relative_path),
  unique (artifact_id)
);
