-- P09-c: durable identity and finite lifetime for an existing approved operation.
create table allrice_local_services (
  operation_id uuid primary key references allrice_runtime_operations(id),
  hard_deadline_at timestamptz not null,
  container_id text check (container_id ~ '^[a-f0-9]{64}$'),
  ready boolean not null default false,
  state text not null default 'starting' check (state in ('starting','ready','waiting_input','stopping')),
  last_sequence integer not null default -1 check (last_sequence between -1 and 63),
  stop_requested boolean not null default false,
  created_at timestamptz not null default clock_timestamp()
);
create table allrice_local_service_events (
  operation_id uuid not null references allrice_local_services(operation_id),
  sequence integer not null check (sequence between 0 and 63),
  payload jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(operation_id,sequence)
);
create table allrice_local_service_inputs (
  operation_id uuid not null references allrice_local_services(operation_id),
  request_id uuid not null,
  sequence integer not null check (sequence between 0 and 15),
  request jsonb not null,
  input_id uuid unique,
  input_payload jsonb,
  delivery jsonb,
  created_at timestamptz not null default clock_timestamp(),
  primary key(operation_id,request_id),
  unique(operation_id,sequence)
);
