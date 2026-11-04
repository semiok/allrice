-- Employee-memory API receipts are tenant storage, not an Agent state machine.
-- No historical row is mapped, deleted or adopted by this migration.
create table allrice_employee_memory_operations (
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null,
  instance_id uuid not null,
  operation_key text not null check (length(operation_key) between 1 and 255),
  operation text not null check (operation in ('create','correct','promote','archive')),
  request_digest text not null check (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  memory_id uuid not null,
  response jsonb not null check (jsonb_typeof(response)='object'),
  created_at timestamptz not null default now(),
  primary key (organization_id,workspace_id,owner_id,instance_id,operation_key),
  foreign key (organization_id,workspace_id,owner_id,instance_id)
    references allrice_employee_instances(organization_id,workspace_id,owner_id,id),
  foreign key (organization_id,workspace_id,memory_id)
    references allrice_memories(organization_id,workspace_id,id)
);

create index allrice_employee_memory_scope
  on allrice_memories(organization_id,workspace_id,owner_id,instance_id,updated_at desc,id)
  where archived_at is null and instance_id is not null;
