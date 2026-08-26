-- MET-84: four-level resource limits, provider release controls and fair queueing.

create table allrice_model_resource_limits (
  id uuid primary key,
  organization_id uuid references allrice_organizations(id),
  scope_type text not null check (scope_type in (
    'tenant', 'user', 'employee', 'provider'
  )),
  scope_id uuid not null,
  monthly_run_limit integer not null check (monthly_run_limit > 0),
  monthly_token_limit bigint not null check (monthly_token_limit > 0),
  concurrent_run_limit integer not null check (concurrent_run_limit > 0),
  max_runtime_ms integer not null check (
    max_runtime_ms between 1000 and 86400000
  ),
  updated_by uuid references allrice_users(id),
  updated_at timestamptz not null default now(),
  unique (scope_type, scope_id)
);

create table allrice_provider_release_controls (
  connection_id uuid primary key references allrice_model_connections(id),
  release_stage text not null default 'experimental'
    check (release_stage in ('experimental', 'canary', 'production', 'disabled')),
  allowlisted_organization_ids uuid[] not null default '{}',
  production_approved boolean not null default false,
  approved_by uuid references allrice_users(id),
  approved_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into allrice_provider_release_controls (
  connection_id, release_stage, allowlisted_organization_ids,
  production_approved
)
select id,
  case when name = 'AllRice Codex 订阅' then 'experimental' else 'production' end,
  case when name = 'AllRice Codex 订阅' then
    coalesce((select array_agg(id order by id) from allrice_organizations), '{}')
    else '{}'::uuid[] end,
  name <> 'AllRice Codex 订阅'
from allrice_model_connections
where scope = 'platform'
on conflict (connection_id) do nothing;

insert into allrice_runtime_metadata (key, value)
values (
  'multilevel-resource-governance',
  '{"version":"0037","issue":"MET-84","scopes":["tenant","user","employee","provider"],"scheduler":"least-active-tenant","refreshLock":"postgres-advisory-and-skip-locked"}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
