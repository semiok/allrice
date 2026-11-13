-- A private preference, never a file access grant.
create table allrice_workbench_file_favorites (
  organization_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null references allrice_users(id),
  object_id uuid not null,
  primary key (organization_id, workspace_id, user_id, object_id),
  foreign key (organization_id, workspace_id, object_id)
    references allrice_storage_objects(organization_id, workspace_id, id)
);
