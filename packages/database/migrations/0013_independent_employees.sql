alter table allrice_memories
  add column employee_id uuid;

alter table allrice_memories
  add foreign key (organization_id, workspace_id, employee_id)
    references allrice_employees(organization_id, workspace_id, id);

create index allrice_memories_employee
  on allrice_memories (
    organization_id, workspace_id, employee_id, updated_at desc
  ) where archived_at is null;

insert into allrice_runtime_metadata (key, value)
values (
  'independent-employee-schema',
  '{"version":"0013","scope":"user-created employees and employee-scoped memory"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
