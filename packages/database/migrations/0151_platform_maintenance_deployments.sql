-- Deployment provenance belongs to the platform, never a customer workspace.
create table allrice_platform_maintenance_deployments (
  id uuid primary key,
  owner_id uuid not null references allrice_users(id),
  request_id uuid not null,
  input_digest text not null,
  company_slug text not null check (company_slug ~ '^[a-z][a-z0-9-]{0,47}$'),
  company_name text not null check (length(company_name) between 1 and 80),
  deployment_name text not null check (length(deployment_name) between 1 and 80),
  credential_digest text not null,
  credential_revision integer not null default 1 check (credential_revision > 0),
  policy jsonb not null,
  revision integer not null default 1 check (revision > 0),
  enabled_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (owner_id, request_id),
  unique (owner_id, company_slug, deployment_name)
);
create index allrice_maintenance_deployments_owner
  on allrice_platform_maintenance_deployments(owner_id, created_at desc, id);
