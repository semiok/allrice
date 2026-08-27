-- MET-81: platform-owned Codex subscription authorization broker.
-- OAuth tokens never enter PostgreSQL. They are written and refreshed by DSH's
-- official credential service in its private Harness home; these tables contain public device challenges,
-- lifecycle metadata and opaque deployment credential references.

create table allrice_provider_authorization_flows (
  id uuid primary key,
  provider_id uuid not null references allrice_model_providers(id),
  connection_id uuid not null references allrice_model_connections(id),
  requested_by uuid not null references allrice_users(id),
  state text not null default 'pending'
    check (state in (
      'pending', 'running', 'awaiting_user', 'connected', 'failed',
      'expired', 'canceled'
    )),
  verification_uri text,
  user_code text,
  detail_code text,
  claimed_by uuid,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  check (
    (state <> 'awaiting_user') or
    (verification_uri is not null and user_code is not null)
  )
);

create unique index allrice_provider_authorization_one_active
  on allrice_provider_authorization_flows (connection_id)
  where state in ('pending', 'running', 'awaiting_user');

create index allrice_provider_authorization_claim
  on allrice_provider_authorization_flows (state, created_at)
  where state in ('pending', 'running', 'awaiting_user');

create table allrice_provider_grants (
  id uuid primary key,
  provider_id uuid not null references allrice_model_providers(id),
  connection_id uuid not null unique references allrice_model_connections(id),
  auth_mode text not null check (auth_mode = 'chatgpt_subscription'),
  status text not null check (status in ('connected', 'disconnected', 'error')),
  credential_reference text not null,
  authorized_by uuid references allrice_users(id),
  authorized_at timestamptz,
  last_checked_at timestamptz,
  detail_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into allrice_runtime_metadata (key, value)
values (
  'codex-subscription-auth-broker',
  '{"version":"0033","issue":"MET-81","tokenStorage":"dsh-private-credential-store","databaseStoresTokens":false}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
