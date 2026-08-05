create table allrice_chat_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  project_id uuid,
  owner_id uuid not null references allrice_users(id),
  title text not null,
  visibility text not null default 'private'
    check (visibility in ('private', 'workspace', 'organization')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  foreign key (organization_id, workspace_id, project_id)
    references allrice_projects(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, id)
);

create table allrice_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  session_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content jsonb not null,
  visibility text not null default 'private'
    check (visibility in ('private', 'workspace', 'organization')),
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  foreign key (organization_id, workspace_id, session_id)
    references allrice_chat_sessions(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, id)
);

create table allrice_memories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  project_id uuid,
  owner_id uuid not null references allrice_users(id),
  content text not null,
  metadata jsonb not null default '{}',
  visibility text not null default 'private'
    check (visibility in ('private', 'workspace', 'organization')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  foreign key (organization_id, workspace_id, project_id)
    references allrice_projects(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, id)
);

create table allrice_rag_chunks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  memory_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  content text not null,
  embedding vector(1536) not null,
  visibility text not null default 'private'
    check (visibility in ('private', 'workspace', 'organization')),
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  foreign key (organization_id, workspace_id, memory_id)
    references allrice_memories(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, id)
);

create table allrice_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  project_id uuid,
  owner_id uuid not null references allrice_users(id),
  state text not null
    check (state in ('created', 'queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled')),
  visibility text not null default 'private'
    check (visibility in ('private', 'workspace', 'organization')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  foreign key (organization_id, workspace_id, project_id)
    references allrice_projects(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, id)
);

create table allrice_storage_quotas (
  organization_id uuid not null,
  workspace_id uuid not null,
  limit_bytes bigint not null check (limit_bytes >= 0),
  updated_at timestamptz not null default now(),
  primary key (organization_id, workspace_id),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id)
);

create table allrice_storage_objects (
  id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  object_key text not null unique,
  category text not null
    check (category in ('uploads', 'artifacts', 'memory', 'exports')),
  media_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  checksum text not null check (checksum ~ '^sha256:[a-f0-9]{64}$'),
  visibility text not null default 'private'
    check (visibility in ('private', 'workspace', 'organization')),
  state text not null default 'pending'
    check (state in ('pending', 'ready', 'deleted')),
  retention_until timestamptz,
  immutable boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  unique (organization_id, workspace_id, id),
  check (retention_until is null or retention_until > created_at),
  check ((state = 'deleted') = (deleted_at is not null))
);

create table allrice_storage_access_grants (
  nonce uuid primary key,
  object_id uuid not null references allrice_storage_objects(id),
  subject_id uuid not null references allrice_users(id),
  operation text not null check (operation in ('read', 'write')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (expires_at > created_at)
);

create table allrice_backup_manifests (
  id uuid primary key default gen_random_uuid(),
  schema_version text not null,
  database_artifact text not null,
  storage_artifact text not null,
  checksum text not null check (checksum ~ '^sha256:[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  restored_at timestamptz
);

create index allrice_messages_tenant_session
  on allrice_messages (organization_id, workspace_id, session_id, created_at);
create index allrice_memories_tenant_owner
  on allrice_memories (organization_id, workspace_id, owner_id, updated_at desc)
  where archived_at is null;
create index allrice_rag_chunks_tenant_owner
  on allrice_rag_chunks (organization_id, workspace_id, owner_id);
create index allrice_rag_chunks_embedding_hnsw
  on allrice_rag_chunks using hnsw (embedding vector_cosine_ops);
create index allrice_storage_objects_tenant_owner
  on allrice_storage_objects (organization_id, workspace_id, owner_id, created_at desc)
  where state = 'ready';
create index allrice_storage_grants_active
  on allrice_storage_access_grants (object_id, subject_id, expires_at)
  where revoked_at is null;

insert into allrice_runtime_metadata (key, value)
values (
  'data-storage-schema',
  '{"version":"0003","minAppVersion":"0.1.0","rollback":"previous application images remain compatible while 0003 tables are additive"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
