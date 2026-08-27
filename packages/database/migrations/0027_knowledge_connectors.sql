-- MET-72: tenant-safe Knowledge index, opaque Connector bindings and approvals.

create table allrice_knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  knowledge_revision_id uuid not null,
  source_ref text not null,
  storage_object_id uuid,
  owner_id uuid not null references allrice_users(id),
  visibility text not null check (visibility in ('private', 'workspace', 'organization')),
  title text not null,
  media_type text not null,
  checksum text not null check (checksum ~ '^sha256:[a-f0-9]{64}$'),
  source_updated_at timestamptz not null,
  indexed_at timestamptz not null default now(),
  active boolean not null default true,
  foreign key (organization_id, workspace_id, knowledge_revision_id)
    references allrice_knowledge_revisions(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, storage_object_id)
    references allrice_storage_objects(organization_id, workspace_id, id),
  unique (knowledge_revision_id, source_ref),
  unique (organization_id, workspace_id, id)
);

create table allrice_knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  document_id uuid not null,
  ordinal integer not null check (ordinal >= 0),
  content text not null,
  embedding vector(1536) not null,
  locator jsonb not null check (jsonb_typeof(locator) = 'object'),
  token_count integer not null check (token_count > 0),
  owner_id uuid not null references allrice_users(id),
  visibility text not null check (visibility in ('private', 'workspace', 'organization')),
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, document_id)
    references allrice_knowledge_documents(organization_id, workspace_id, id)
    on delete cascade,
  unique (document_id, ordinal),
  unique (organization_id, workspace_id, id)
);

create index allrice_knowledge_chunks_embedding_hnsw
  on allrice_knowledge_chunks using hnsw (embedding vector_cosine_ops);
create index allrice_knowledge_documents_source
  on allrice_knowledge_documents (
    organization_id, workspace_id, knowledge_revision_id, source_updated_at desc
  ) where active;

create table allrice_connector_definitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  connector_key text not null check (connector_key ~ '^[a-z0-9]+(?:[.-][a-z0-9]+)*$'),
  name text not null,
  description text not null,
  capabilities jsonb not null check (jsonb_typeof(capabilities) = 'array'),
  input_schema jsonb not null check (jsonb_typeof(input_schema) = 'object'),
  risk text not null check (risk in ('read_only', 'write', 'external_send', 'high_risk_data')),
  identity_modes jsonb not null check (jsonb_typeof(identity_modes) = 'array'),
  resource_scopes jsonb not null check (jsonb_typeof(resource_scopes) = 'array'),
  enabled boolean not null default true,
  created_by uuid not null references allrice_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  unique (organization_id, workspace_id, connector_key),
  unique (organization_id, workspace_id, id)
);

create table allrice_connector_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  connector_id uuid not null,
  identity_mode text not null check (identity_mode in ('user', 'service')),
  user_id uuid references allrice_users(id),
  credential_reference text not null,
  resource_scope jsonb not null check (jsonb_typeof(resource_scope) = 'object'),
  enabled boolean not null default true,
  created_by uuid not null references allrice_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, connector_id)
    references allrice_connector_definitions(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, id),
  check (
    (identity_mode = 'user' and user_id is not null) or
    (identity_mode = 'service' and user_id is null)
  )
);

create table allrice_approval_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  run_id uuid not null,
  actor_id uuid not null references allrice_users(id),
  resource_type text not null,
  resource_id uuid not null,
  action text not null,
  input_digest text not null check (input_digest ~ '^sha256:[a-f0-9]{64}$'),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'expired')),
  requested_at timestamptz not null default now(),
  decided_by uuid references allrice_users(id),
  decided_at timestamptz,
  decision_reason text,
  foreign key (organization_id, workspace_id, run_id)
    references allrice_runs(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, id),
  check ((status = 'pending') = (decided_at is null))
);

create table allrice_connector_calls (
  id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  run_id uuid not null,
  actor_id uuid not null references allrice_users(id),
  connector_binding_id uuid not null,
  operation text not null,
  identity_mode text not null check (identity_mode in ('user', 'service')),
  input_digest text not null check (input_digest ~ '^sha256:[a-f0-9]{64}$'),
  output_digest text check (output_digest is null or output_digest ~ '^sha256:[a-f0-9]{64}$'),
  approval_id uuid references allrice_approval_requests(id),
  status text not null check (status in ('allowed', 'waiting_approval', 'denied', 'succeeded', 'failed')),
  side_effect boolean not null,
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (organization_id, workspace_id, run_id)
    references allrice_runs(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, connector_binding_id)
    references allrice_connector_bindings(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, id)
);

create index allrice_approvals_pending
  on allrice_approval_requests (organization_id, workspace_id, actor_id, requested_at)
  where status = 'pending';
create index allrice_connector_calls_run
  on allrice_connector_calls (organization_id, workspace_id, run_id, created_at);

insert into allrice_runtime_metadata (key, value)
values (
  'knowledge-connector-schema',
  '{"version":"0027","issue":"MET-72","credentials":"opaque-references-only","approval":"before-side-effect"}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
