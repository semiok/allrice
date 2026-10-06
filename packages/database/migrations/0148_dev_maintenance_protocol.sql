-- Facts for the Dev release lane; these tables are not a second job queue.
create table allrice_dev_control_owners (
  job_id uuid primary key references allrice_jobs(id),
  supervisor_boot_id uuid not null,
  installed_identity_digest text not null check(installed_identity_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp()
);
create table allrice_dev_maintenance (
  environment_id text primary key check(environment_id='dev'),
  epoch bigint not null default 0 check(epoch>=0),
  state text not null default 'open' check(state in ('open','requested','quiesced')),
  owner_job_id uuid references allrice_dev_control_owners(job_id),
  owner_attempt integer,
  owner_boot_id uuid,
  expected_instances jsonb not null default '{}',
  requested_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  check ((state='open' and owner_job_id is null and owner_attempt is null and owner_boot_id is null)
    or (state<>'open' and owner_job_id is not null and owner_attempt is not null and owner_boot_id is not null))
);
insert into allrice_dev_maintenance(environment_id) values ('dev');
create table allrice_dev_producer_permits (
  id uuid primary key,
  epoch bigint not null check(epoch>=0),
  instance_boot_id uuid not null,
  role text not null check(role in ('web','worker')),
  producer text not null,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  -- Missing completion stays busy. Age or process death never implies success.
  check(finished_at is null or finished_at>=started_at)
);
create index allrice_dev_producer_active on allrice_dev_producer_permits(instance_boot_id) where finished_at is null;
create table allrice_dev_maintenance_acks (
  epoch bigint not null,
  role text not null check(role in ('web','worker')),
  instance_boot_id uuid not null,
  owner_job_id uuid not null references allrice_dev_control_owners(job_id),
  owner_attempt integer not null,
  owner_boot_id uuid not null,
  manifest_digest text not null check(manifest_digest ~ '^sha256:[a-f0-9]{64}$'),
  coverage_version integer not null,
  in_flight integer not null check(in_flight>=0),
  unknown_producers text[] not null,
  observed_at timestamptz not null default clock_timestamp(),
  primary key(epoch,role)
);
