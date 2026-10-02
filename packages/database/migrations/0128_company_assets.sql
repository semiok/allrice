-- Explicit company publications are independent snapshots of selected material.
-- Private conversations and deliverable versions retain their own lifecycle.
create table allrice_company_assets (
  id uuid primary key,
  organization_id uuid not null references allrice_organizations(id),
  owner_id uuid not null references allrice_users(id),
  kind text not null check(kind in ('rule','template')),
  state text not null default 'draft' check(state in ('draft','published','paused','withdrawn','archived')),
  revision integer not null default 1 check(revision>0),
  latest_revision_id uuid,
  published_revision_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(organization_id,id)
);
create table allrice_company_asset_revisions (
  id uuid primary key,
  organization_id uuid not null,
  asset_id uuid not null,
  number integer not null check(number>0),
  content jsonb not null,
  digest text not null check(digest ~ '^sha256:[a-f0-9]{64}$'),
  snapshot_object_id uuid references allrice_storage_objects(id),
  file_metadata jsonb,
  source_version_id uuid references allrice_deliverable_versions(id),
  source_memory_id uuid references allrice_memories(id),
  source_memory_revision_id uuid references allrice_memory_revisions(id),
  base_asset_revision integer not null check(base_asset_revision>=0),
  created_by uuid not null references allrice_users(id),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(organization_id,asset_id) references allrice_company_assets(organization_id,id),
  unique(asset_id,number),unique(asset_id,id),
  check((snapshot_object_id is null)=(file_metadata is null)),
  check((source_memory_id is null)=(source_memory_revision_id is null))
);
alter table allrice_company_assets add foreign key(id,latest_revision_id) references allrice_company_asset_revisions(asset_id,id);
alter table allrice_company_assets add foreign key(id,published_revision_id) references allrice_company_asset_revisions(asset_id,id);
create table allrice_company_asset_publications (
  asset_id uuid not null,
  revision_id uuid not null,
  published_by uuid not null references allrice_users(id),
  published_at timestamptz not null default clock_timestamp(),
  primary key(asset_id,revision_id),
  foreign key(asset_id,revision_id) references allrice_company_asset_revisions(asset_id,id)
);
create function allrice_company_revision_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'company publication revision is immutable';
end $$;
create trigger allrice_company_revision_immutable before update or delete on allrice_company_asset_revisions
  for each row execute function allrice_company_revision_immutable();
create index allrice_company_assets_directory on allrice_company_assets(organization_id,state,id);
create index allrice_company_snapshot_lookup on allrice_company_asset_revisions(snapshot_object_id) where snapshot_object_id is not null;
