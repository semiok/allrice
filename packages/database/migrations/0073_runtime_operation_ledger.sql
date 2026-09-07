-- MET-112 / P03-a. Additive shared execution bookkeeping; no Runner is enabled.
-- Run remains the task authority. These rows record operations and root budgets.
create table allrice_runtime_roots (
  root_run_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  task jsonb not null,
  deadline_at timestamptz not null,
  cancel_request_id uuid,
  cancel_reason text check (cancel_reason in ('user_request', 'deadline', 'budget_exhausted')),
  cancel_requested_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, root_run_id)
    references allrice_runs(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, root_run_id),
  check ((cancel_request_id is null) = (cancel_requested_at is null)),
  check ((cancel_request_id is null) = (cancel_reason is null))
);

-- Parentage is admitted once, alongside existing Run identities. No second Run.
create table allrice_runtime_run_links (
  run_id uuid primary key,
  root_run_id uuid not null references allrice_runtime_roots(root_run_id),
  parent_run_id uuid references allrice_runtime_run_links(run_id),
  organization_id uuid not null,
  workspace_id uuid not null,
  task jsonb not null,
  foreign key (organization_id, workspace_id, run_id)
    references allrice_runs(organization_id, workspace_id, id),
  check ((run_id = root_run_id) = (parent_run_id is null))
);

create table allrice_runtime_budgets (
  root_run_id uuid not null references allrice_runtime_roots(root_run_id),
  metric text not null check (metric in (
    'input_tokens', 'cached_input_tokens', 'output_tokens', 'model_calls',
    'tool_calls', 'wall_time', 'output_bytes', 'cost'
  )),
  unit text not null,
  currency text,
  capacity bigint not null check (capacity between 0 and 9007199254740991),
  reserved bigint not null default 0 check (reserved between 0 and 9007199254740991),
  spent bigint not null default 0 check (spent between 0 and 9007199254740991),
  source jsonb not null,
  primary key (root_run_id, metric),
  check ((metric = 'cost') = (currency is not null)),
  check (reserved + spent <= 9007199254740991)
);

create table allrice_runtime_operations (
  id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  run_id uuid not null,
  root_run_id uuid not null,
  target_id uuid not null,
  device_id uuid,
  attempt_id uuid not null unique,
  attempt_number integer not null check (attempt_number = 1),
  generation bigint not null check (generation >= 0),
  fence bigint not null check (fence = 1),
  idempotency_key uuid not null,
  initial_snapshot jsonb not null,
  snapshot jsonb not null,
  next_sequence bigint not null default 0 check (next_sequence >= 0),
  bridge_payload jsonb,
  lease_owner uuid,
  lease_token_hash text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, run_id)
    references allrice_runs(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, root_run_id)
    references allrice_runtime_roots(organization_id, workspace_id, root_run_id),
  foreign key (organization_id, workspace_id, target_id)
    references allrice_execution_targets(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, idempotency_key),
  unique (organization_id, workspace_id, id),
  check (
    (lease_owner is null and lease_token_hash is null and lease_expires_at is null)
    or (lease_owner is not null and lease_token_hash is not null and lease_expires_at is not null)
  )
);
create index allrice_runtime_operations_device on allrice_runtime_operations(device_id, created_at);
create index allrice_runtime_operations_root on allrice_runtime_operations(root_run_id, id);
create index allrice_runtime_operations_lease on allrice_runtime_operations(lease_expires_at)
  where lease_expires_at is not null;

-- Approval adapters may read these immutable inputs without taking an operation
-- lock after policy locks. That avoids controls→operation / operation→controls
-- inversion while dispatch still owns the operation update lock.
create function allrice_runtime_operation_binding_immutable() returns trigger language plpgsql as $$
begin
  if row(new.id, new.organization_id, new.workspace_id, new.run_id, new.root_run_id,
         new.target_id, new.device_id, new.attempt_id, new.attempt_number,
         new.generation, new.fence, new.idempotency_key, new.initial_snapshot, new.bridge_payload)
     is distinct from
     row(old.id, old.organization_id, old.workspace_id, old.run_id, old.root_run_id,
         old.target_id, old.device_id, old.attempt_id, old.attempt_number,
         old.generation, old.fence, old.idempotency_key, old.initial_snapshot, old.bridge_payload)
    or new.snapshot->'binding' is distinct from old.snapshot->'binding'
    or (old.lease_token_hash is not null and
      (new.lease_token_hash is distinct from old.lease_token_hash
        or new.lease_owner is distinct from old.lease_owner)) then
    raise exception 'runtime operation identity and dispatch inputs are immutable';
  end if;
  return new;
end;
$$;
create trigger allrice_runtime_operation_binding_immutable
  before update on allrice_runtime_operations for each row
  execute function allrice_runtime_operation_binding_immutable();

-- The device's receipt sequence is not the shared operation event sequence.
-- Exact receipts deduplicate independently from transport and server events.
create table allrice_runtime_operation_receipts (
  receipt_id uuid primary key,
  operation_id uuid not null references allrice_runtime_operations(id),
  payload jsonb not null,
  disposition text not null check (disposition in ('applied', 'stale', 'conflict')),
  received_at timestamptz not null default now()
);
create table allrice_runtime_operation_events (
  id uuid primary key,
  operation_id uuid not null references allrice_runtime_operations(id),
  sequence bigint not null check (sequence >= 0),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (operation_id, sequence)
);

create table allrice_runtime_reservations (
  operation_id uuid not null references allrice_runtime_operations(id),
  root_run_id uuid not null,
  metric text not null,
  accounting_id uuid not null unique,
  amount bigint not null check (amount between 0 and 9007199254740991),
  settled_amount bigint check (settled_amount between 0 and 9007199254740991),
  observation_id uuid unique,
  observation jsonb,
  primary key (operation_id, metric),
  foreign key (root_run_id, metric) references allrice_runtime_budgets(root_run_id, metric),
  check ((settled_amount is null) = (observation_id is null)),
  check ((observation_id is null) = (observation is null))
);
