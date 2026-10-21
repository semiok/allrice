-- File sharing belongs to the file/series, never to its original chat.
create table allrice_workbench_file_policies (
  object_id uuid primary key references allrice_storage_objects(id),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null references allrice_workspaces(id),
  owner_id uuid not null references allrice_users(id),
  series_id uuid,
  file_name text not null check (length(file_name) between 1 and 1000),
  scope text not null check (scope in ('personal', 'departments', 'company')),
  department_ids uuid[] not null default '{}',
  reference_source_id uuid references allrice_knowledge_sources(id),
  reference_enabled boolean not null default false,
  revision integer not null default 1 check (revision > 0),
  upload_request_id uuid,
  upload_digest text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (organization_id, series_id),
  unique (reference_source_id),
  unique (organization_id, owner_id, upload_request_id),
  check ((scope = 'departments') = (cardinality(department_ids) > 0)),
  check (cardinality(department_ids) <= 64),
  check (not reference_enabled or reference_source_id is not null),
  check ((upload_request_id is null) = (upload_digest is null))
);

create index allrice_workbench_file_policies_company
  on allrice_workbench_file_policies (organization_id, scope, updated_at desc);

-- Reference bytes remain immutable snapshots. Every new snapshot resolves the
-- live authority of its original file, including after a sharing reduction.
create table allrice_workbench_reference_bindings (
  source_id uuid primary key references allrice_knowledge_sources(id),
  origin_object_id uuid not null references allrice_storage_objects(id),
  organization_id uuid not null references allrice_organizations(id),
  created_at timestamptz not null default clock_timestamp()
);

create index allrice_workbench_reference_bindings_origin
  on allrice_workbench_reference_bindings (origin_object_id);

create table allrice_workbench_file_mutations (
  organization_id uuid not null references allrice_organizations(id),
  actor_id uuid not null references allrice_users(id),
  request_id uuid not null,
  object_id uuid not null references allrice_storage_objects(id),
  input_digest text not null,
  result_revision integer not null check (result_revision > 0),
  created_at timestamptz not null default clock_timestamp(),
  primary key (organization_id, actor_id, request_id)
);
