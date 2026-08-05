create table allrice_users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  display_name text not null,
  password_hash text not null,
  status text not null default 'active'
    check (status in ('invited', 'active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email = lower(email))
);
create unique index allrice_users_email_unique
  on allrice_users (lower(email));

create table allrice_organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table allrice_workspaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references allrice_organizations(id),
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (organization_id, slug),
  unique (organization_id, id)
);

create table allrice_projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  name text not null,
  visibility text not null default 'private'
    check (visibility in ('private', 'workspace', 'organization')),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  unique (organization_id, workspace_id, id)
);

create table allrice_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid,
  user_id uuid not null references allrice_users(id),
  role text not null check (role in ('admin', 'member', 'viewer')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  unique nulls not distinct (organization_id, workspace_id, user_id)
);

create table allrice_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid,
  email text not null,
  role text not null check (role in ('admin', 'member', 'viewer')),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  created_by uuid references allrice_users(id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  check (email = lower(email)),
  check (expires_at > created_at)
);

create table allrice_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references allrice_users(id),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create table allrice_policy_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references allrice_organizations(id),
  subject_id uuid not null references allrice_users(id),
  version integer not null check (version > 0),
  payload jsonb not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (organization_id, subject_id, version),
  check (expires_at > issued_at)
);

create table allrice_settings (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null
    check (scope_type in ('system', 'organization', 'workspace', 'user')),
  scope_id uuid,
  key text not null,
  value jsonb not null,
  updated_by uuid references allrice_users(id),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (scope_type, scope_id, key),
  check ((scope_type = 'system' and scope_id is null)
    or (scope_type <> 'system' and scope_id is not null))
);

create table allrice_credential_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid,
  owner_id uuid references allrice_users(id),
  provider text not null,
  label text not null,
  vault_key text not null unique,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id)
);

create table allrice_audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid,
  actor_id uuid references allrice_users(id),
  action text not null,
  resource_type text not null,
  resource_id uuid,
  decision text not null check (decision in ('allowed', 'denied', 'recorded')),
  reason text not null,
  request_id uuid,
  metadata jsonb not null default '{}',
  occurred_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id)
);

create index allrice_memberships_user_active
  on allrice_memberships (user_id, organization_id, workspace_id)
  where active;
create index allrice_sessions_active
  on allrice_sessions (token_hash, expires_at)
  where revoked_at is null;
create index allrice_audit_tenant_time
  on allrice_audit_events (organization_id, occurred_at desc);
