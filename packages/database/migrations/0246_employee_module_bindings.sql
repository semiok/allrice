-- MET-224 fast lane: approved minimal instance/module gate and binding fact.
-- MET-253 owns this SAME store later. No module catalog, Run or task state.
create table allrice_employee_module_bindings (
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null,
  instance_id uuid not null,
  module_id text not null check (char_length(module_id) between 1 and 160),
  contract_version integer not null check (contract_version = 1),
  content_version text not null check (content_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  digest text not null check (digest ~ '^sha256:[a-f0-9]{64}$'),
  revision integer not null default 1 check (revision > 0),
  enabled_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  primary key (organization_id,workspace_id,owner_id,instance_id,module_id),
  foreign key (organization_id,workspace_id,owner_id,instance_id)
    references allrice_employee_instances(organization_id,workspace_id,owner_id,id),
  check (revoked_at is null or revoked_at >= enabled_at)
);
