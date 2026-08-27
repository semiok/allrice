-- MET-84: organization quotas, provider circuit breakers and durable usage.

create table allrice_organization_model_quotas (
  organization_id uuid primary key references allrice_organizations(id),
  monthly_run_limit integer not null default 10000 check (monthly_run_limit > 0),
  monthly_token_limit bigint not null default 10000000 check (monthly_token_limit > 0),
  monthly_cost_limit_cents bigint not null default 1000000
    check (monthly_cost_limit_cents >= 0),
  updated_by uuid references allrice_users(id),
  updated_at timestamptz not null default now()
);

create table allrice_model_usage_ledger (
  id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  route_decision_id uuid not null unique references allrice_route_decisions(id),
  connection_id uuid references allrice_model_connections(id),
  model_catalog_entry_id uuid references allrice_model_catalog_entries(id),
  status text not null check (status in ('succeeded', 'failed', 'canceled')),
  input_tokens integer not null check (input_tokens >= 0),
  cached_input_tokens integer not null check (cached_input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  cost_cents numeric(14,6) not null check (cost_cents >= 0),
  occurred_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id)
);

create index allrice_model_usage_quota_window
  on allrice_model_usage_ledger (organization_id, occurred_at);

create table allrice_provider_circuit_breakers (
  connection_id uuid primary key references allrice_model_connections(id),
  kill_switch boolean not null default false,
  circuit_state text not null default 'closed'
    check (circuit_state in ('closed', 'open', 'half_open')),
  consecutive_failures integer not null default 0
    check (consecutive_failures >= 0),
  opened_until timestamptz,
  last_error_code text,
  updated_by uuid references allrice_users(id),
  updated_at timestamptz not null default now()
);

create table allrice_operational_incidents (
  id uuid primary key,
  organization_id uuid,
  workspace_id uuid,
  connection_id uuid references allrice_model_connections(id),
  kind text not null check (kind in (
    'quota_exceeded', 'circuit_opened', 'kill_switch', 'provider_recovered'
  )),
  severity text not null check (severity in ('info', 'warning', 'critical')),
  detail_code text not null,
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

insert into allrice_runtime_metadata (key, value)
values (
  'model-governance',
  '{"version":"0035","issue":"MET-84","circuitFailureThreshold":3,"circuitOpenSeconds":60,"usageSource":"route-decisions"}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
