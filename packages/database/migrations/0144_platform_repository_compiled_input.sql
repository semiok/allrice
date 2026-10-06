-- A second immutable input is scoped to the existing private repair task.
-- Ordinary project/cloud inputs and historical v1 records keep their limits.
alter table allrice_platform_repair_tasks
  add column dependency_object_id uuid references allrice_storage_objects(id);
