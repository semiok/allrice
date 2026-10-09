-- Immutable reports authenticate an installation, never a company browser login.
create table allrice_platform_maintenance_reports (
  id uuid primary key,
  deployment_id uuid not null references allrice_platform_maintenance_deployments(id),
  source_report_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  credential_revision integer not null check (credential_revision > 0),
  source_kind text not null check (source_kind in ('deployment_health','quality_check')),
  payload_digest text not null check (payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb not null,
  assessment jsonb not null,
  received_at timestamptz(3) not null default clock_timestamp(),
  unique(deployment_id,source_report_id),
  unique(id,deployment_id)
);
create index allrice_maintenance_reports_owner_time on allrice_platform_maintenance_reports(owner_id,received_at desc,id desc);
-- Installation-side transport outbox. Source bytes and id remain frozen across
-- lost receipts/restarts; it does not hold repair or GitHub credentials.
create table allrice_platform_maintenance_outbox (
  id uuid primary key,
  connection_digest text not null,
  deployment_id uuid not null,
  source_kind text not null,
  local_source_id text not null,
  payload jsonb not null,
  payload_digest text not null,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default clock_timestamp(),
  sending_until timestamptz,
  receipt jsonb,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  unique(connection_digest,source_kind,local_source_id)
);
create index allrice_maintenance_outbox_due on allrice_platform_maintenance_outbox(connection_digest,next_attempt_at) where delivered_at is null;
create table allrice_platform_maintenance_source_state (
  connection_digest text primary key,
  deployment_id uuid not null,
  next_check_at timestamptz not null default clock_timestamp(),
  last_sampled_at timestamptz,
  last_facts_digest text,
  sequence integer not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  last_delivery_at timestamptz,
  last_error text,
  updated_at timestamptz not null default clock_timestamp()
);
