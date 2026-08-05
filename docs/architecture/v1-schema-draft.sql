-- MET-49 contract schema draft. This is not an executable migration.
-- MET-41/MET-42 own the reviewed migrations that implement these constraints.

create type visibility as enum ('private', 'workspace', 'organization');
create type membership_role as enum ('admin', 'member', 'viewer');
create type job_status as enum (
  'queued', 'claimed', 'running', 'retry_wait',
  'succeeded', 'failed', 'dead_letter', 'canceled'
);

create table organizations (
  id uuid primary key,
  slug text not null unique,
  name text not null,
  created_at timestamptz not null,
  archived_at timestamptz
);

create table workspaces (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  slug text not null,
  name text not null,
  created_at timestamptz not null,
  archived_at timestamptz,
  unique (organization_id, slug),
  unique (organization_id, id)
);

create table memberships (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  workspace_id uuid,
  user_id uuid not null,
  role membership_role not null,
  active boolean not null,
  foreign key (organization_id, workspace_id)
    references workspaces(organization_id, id),
  unique nulls not distinct (organization_id, workspace_id, user_id)
);

create table policy_snapshots (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  subject_id uuid not null,
  version integer not null check (version > 0),
  payload jsonb not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > issued_at),
  unique (organization_id, subject_id, version)
);

create table jobs (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  workspace_id uuid not null,
  owner_id uuid not null,
  status job_status not null,
  idempotency_key text not null,
  payload_version integer not null check (payload_version > 0),
  payload jsonb not null,
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null check (max_attempts > 0),
  available_at timestamptz not null,
  timeout_at timestamptz not null,
  lease_worker_id uuid,
  lease_token uuid,
  lease_heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  foreign key (organization_id, workspace_id)
    references workspaces(organization_id, id),
  unique (organization_id, idempotency_key),
  check ((lease_token is null) = (lease_expires_at is null))
);

create table runs (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  workspace_id uuid not null,
  owner_id uuid not null,
  job_id uuid not null references jobs(id),
  policy_snapshot_id uuid not null references policy_snapshots(id),
  employee_version_id uuid,
  skill_version_id uuid,
  status text not null,
  created_at timestamptz not null,
  terminal_at timestamptz,
  foreign key (organization_id, workspace_id)
    references workspaces(organization_id, id)
);

create table run_events (
  event_id uuid primary key,
  run_id uuid not null references runs(id),
  sequence bigint not null check (sequence >= 0),
  schema_version integer not null check (schema_version > 0),
  event_type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  unique (run_id, sequence)
);

create table storage_objects (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  workspace_id uuid not null,
  owner_id uuid not null,
  visibility visibility not null,
  object_key text not null unique,
  checksum text not null check (checksum ~ '^sha256:[a-f0-9]{64}$'),
  media_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  immutable boolean not null default false,
  retention_until timestamptz,
  deleted_at timestamptz,
  foreign key (organization_id, workspace_id)
    references workspaces(organization_id, id)
);

create table audit_events (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  workspace_id uuid,
  actor_id uuid,
  action text not null,
  resource_type text not null,
  resource_id uuid,
  decision text not null check (decision in ('allowed', 'denied', 'recorded')),
  reason text not null,
  request_id uuid,
  metadata jsonb not null default '{}',
  occurred_at timestamptz not null
);

-- Every repository query receives organization_id from trusted context.
-- Composite foreign keys prevent child rows from naming a workspace in another tenant.
-- Row-level security may add defense in depth, but is not a substitute for repositories.
