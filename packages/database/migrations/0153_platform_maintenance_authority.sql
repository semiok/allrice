-- Central diagnoses are separate from immutable installation assertions.
create table allrice_platform_maintenance_defects (
  id uuid primary key,
  repository_id bigint not null check(repository_id=1323769790),
  defect_key text not null unique check(defect_key ~ '^sha256:[a-f0-9]{64}$'),
  spec_id text not null,
  before_checksum text not null,
  failure_signature text not null,
  created_at timestamptz(3) not null default clock_timestamp()
);
create table allrice_platform_maintenance_diagnoses (
  id uuid primary key,
  report_id uuid not null references allrice_platform_maintenance_reports(id),
  report_digest text not null,
  target_sha text not null check(target_sha ~ '^[a-f0-9]{40}$'),
  proof jsonb not null,
  proof_digest text not null,
  defect_id uuid references allrice_platform_maintenance_defects(id),
  created_at timestamptz(3) not null default clock_timestamp(),
  unique(report_id,target_sha)
);
create table allrice_platform_maintenance_grants (
  id uuid primary key,
  issuer_id uuid not null references allrice_users(id),
  request_id uuid not null,
  request_digest text not null,
  report_id uuid not null,
  deployment_id uuid not null,
  diagnosis_id uuid not null references allrice_platform_maintenance_diagnoses(id),
  defect_id uuid not null references allrice_platform_maintenance_defects(id),
  policy_revision integer not null,
  credential_revision integer not null,
  origin text not null check(origin in ('manual','automatic')),
  frozen jsonb not null,
  frozen_digest text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  repair_task_id uuid unique references allrice_platform_repair_tasks(id),
  publication_id uuid references allrice_platform_repository_publications(id),
  created_at timestamptz(3) not null default clock_timestamp(),
  unique(issuer_id,request_id),
  foreign key(report_id,deployment_id) references allrice_platform_maintenance_reports(id,deployment_id)
);
-- Every source keeps its own authorization and request idempotency. A separate
-- central attempt deduplicates work, without lending another source's grant.
create table allrice_platform_maintenance_attempts (
  id uuid primary key,
  defect_id uuid not null unique references allrice_platform_maintenance_defects(id),
  primary_grant_id uuid not null references allrice_platform_maintenance_grants(id),
  repair_task_id uuid unique references allrice_platform_repair_tasks(id),
  publication_id uuid references allrice_platform_repository_publications(id),
  created_at timestamptz(3) not null default clock_timestamp()
);
create table allrice_platform_maintenance_grant_attempts (
  grant_id uuid primary key references allrice_platform_maintenance_grants(id),
  attempt_id uuid not null references allrice_platform_maintenance_attempts(id)
);
