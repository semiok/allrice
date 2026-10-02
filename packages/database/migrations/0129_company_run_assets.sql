-- The publication remains authoritative. These are private input caches and
-- idempotent formal-Run facts, not another business deliverable directory.
create table allrice_company_asset_materials (
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null references allrice_workspaces(id),
  owner_id uuid not null references allrice_users(id),
  revision_id uuid not null references allrice_company_asset_revisions(id),
  object_id uuid not null unique references allrice_storage_objects(id),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,owner_id,revision_id)
);
create table allrice_company_run_assets (
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null references allrice_workspaces(id),
  owner_id uuid not null references allrice_users(id),
  run_id uuid not null references allrice_runs(id),
  asset_id uuid not null,
  revision_id uuid not null,
  digest text not null check(digest ~ '^sha256:[a-f0-9]{64}$'),
  kind text not null check(kind in ('rule','template')),
  material_object_id uuid references allrice_storage_objects(id),
  selected_at timestamptz,
  loaded_at timestamptz,
  read_at timestamptz,
  primary key(run_id,asset_id),
  foreign key(asset_id,revision_id) references allrice_company_asset_revisions(asset_id,id),
  check((kind='template')=(selected_at is not null))
);
create table allrice_company_asset_derivations (
  run_id uuid not null,
  asset_id uuid not null,
  deliverable_version_id uuid not null references allrice_deliverable_versions(id),
  created_at timestamptz not null default clock_timestamp(),
  primary key(run_id,asset_id,deliverable_version_id),
  foreign key(run_id,asset_id) references allrice_company_run_assets(run_id,asset_id)
);
create index allrice_company_run_asset_usage on allrice_company_run_assets(organization_id,asset_id,run_id);
create index allrice_company_run_material_lookup on allrice_company_run_assets(material_object_id,run_id) where material_object_id is not null;
