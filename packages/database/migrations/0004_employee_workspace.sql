create table allrice_employees (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  employee_key text not null,
  name text not null,
  status text not null default 'active'
    check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  unique (organization_id, workspace_id, employee_key),
  unique (organization_id, workspace_id, id)
);

create table allrice_employee_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  employee_id uuid not null,
  version integer not null check (version > 0),
  name text not null,
  model text not null,
  system_prompt text not null,
  capabilities jsonb not null,
  config_checksum text not null check (config_checksum ~ '^sha256:[a-f0-9]{64}$'),
  published_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, employee_id)
    references allrice_employees(organization_id, workspace_id, id),
  unique (employee_id, version),
  unique (organization_id, workspace_id, id),
  unique (organization_id, workspace_id, employee_id, id)
);

create table allrice_employee_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  employee_id uuid not null,
  employee_version_id uuid not null,
  user_id uuid not null references allrice_users(id),
  is_default boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, employee_id)
    references allrice_employees(organization_id, workspace_id, id),
  foreign key (
    organization_id, workspace_id, employee_id, employee_version_id
  ) references allrice_employee_versions(
    organization_id, workspace_id, employee_id, id
  ),
  unique (organization_id, workspace_id, user_id, employee_id),
  unique (organization_id, workspace_id, id)
);
create unique index allrice_employee_assignments_one_default
  on allrice_employee_assignments (organization_id, workspace_id, user_id)
  where active and is_default;

alter table allrice_chat_sessions
  add column employee_assignment_id uuid;
alter table allrice_chat_sessions
  add foreign key (organization_id, workspace_id, employee_assignment_id)
    references allrice_employee_assignments(organization_id, workspace_id, id);

alter table allrice_messages
  add column client_message_id uuid,
  add column reply_to_id uuid,
  add column status text not null default 'completed'
    check (status in ('pending', 'completed', 'failed')),
  add column error_code text,
  add column completed_at timestamptz;
alter table allrice_messages
  add foreign key (organization_id, workspace_id, reply_to_id)
    references allrice_messages(organization_id, workspace_id, id);
create unique index allrice_messages_client_idempotency
  on allrice_messages (session_id, owner_id, client_message_id)
  where client_message_id is not null;

create table allrice_message_attachments (
  organization_id uuid not null,
  workspace_id uuid not null,
  message_id uuid not null,
  object_id uuid not null,
  attached_by uuid not null references allrice_users(id),
  file_name text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, object_id),
  foreign key (organization_id, workspace_id, message_id)
    references allrice_messages(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, object_id)
    references allrice_storage_objects(organization_id, workspace_id, id)
);

create table allrice_file_references (
  organization_id uuid not null,
  workspace_id uuid not null,
  object_id uuid not null,
  session_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  file_name text not null,
  created_at timestamptz not null default now(),
  primary key (object_id, session_id),
  foreign key (organization_id, workspace_id, object_id)
    references allrice_storage_objects(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, session_id)
    references allrice_chat_sessions(organization_id, workspace_id, id)
);

alter table allrice_memories
  add column source_type text not null default 'user'
    check (source_type in ('user', 'message', 'file')),
  add column source_id uuid,
  add column embedding_model text not null default 'allrice/hash-embedding-v1';

create index allrice_sessions_owner_activity
  on allrice_chat_sessions (
    organization_id, workspace_id, owner_id, updated_at desc, id desc
  );
create index allrice_messages_session_order
  on allrice_messages (
    organization_id, workspace_id, session_id, created_at, id
  );
create index allrice_memories_source
  on allrice_memories (
    organization_id, workspace_id, source_type, source_id
  ) where archived_at is null;

insert into allrice_runtime_metadata (key, value)
values (
  'employee-workspace-schema',
  '{"version":"0004","scope":"default employee, chat/session, attachments and traceable memory"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
