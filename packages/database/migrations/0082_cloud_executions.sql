-- P15: opt-in cloud execution. No default grant, capability or feature activation.
create table allrice_cloud_execution_grants (
 id uuid primary key, organization_id uuid not null, workspace_id uuid not null,
 owner_id uuid not null references allrice_users(id), target_id uuid not null,
 version integer not null check(version > 0), profile jsonb not null,
 enabled boolean not null default false, revoked_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id, workspace_id, target_id) references allrice_execution_targets(organization_id, workspace_id, id),
 unique(organization_id, workspace_id, id)
);
-- A proposal's declared data transfer scope. It is not effective authority until
-- the exact current P04 approval is consumed by ledger dispatch.
create table allrice_cloud_execution_inputs (
 operation_id uuid primary key, organization_id uuid not null, workspace_id uuid not null,
 owner_id uuid not null references allrice_users(id), run_id uuid not null,
 grant_id uuid not null, job_id uuid not null references allrice_jobs(id),
 worker_id uuid not null, job_lease_token uuid not null,
 binding jsonb not null, payload jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id, workspace_id, run_id) references allrice_runs(organization_id, workspace_id, id),
 foreign key(organization_id, workspace_id, grant_id) references allrice_cloud_execution_grants(organization_id, workspace_id, id),
 unique(organization_id, workspace_id, operation_id)
);
create function allrice_cloud_input_immutable() returns trigger language plpgsql as $$
begin raise exception 'cloud execution inputs are immutable'; end; $$;
create trigger allrice_cloud_input_immutable before update or delete on allrice_cloud_execution_inputs
 for each row execute function allrice_cloud_input_immutable();
-- Server-private recovery journal. Never serialize lease_token into UI/model/audit.
create table allrice_cloud_execution_attempts (
 operation_id uuid primary key references allrice_runtime_operations(id),
 lease_token text not null, container_id text, outcome jsonb,
 artifacts jsonb not null default '[]', cleanup_confirmed_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),
 check(container_id is null or container_id ~ '^[a-f0-9]{64}$')
);
