-- MET-82: platform-managed model catalog and immutable employee/session routing.

create table allrice_model_providers (
  id uuid primary key,
  provider_key text not null unique
    check (provider_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null,
  harness text not null check (harness in ('codex', 'dsh')),
  auth_mode text not null
    check (auth_mode in ('chatgpt_subscription', 'api_key', 'none')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table allrice_model_connections (
  id uuid primary key,
  provider_id uuid not null references allrice_model_providers(id),
  organization_id uuid references allrice_organizations(id),
  scope text not null check (scope in ('platform', 'organization')),
  name text not null,
  credential_reference text,
  base_url text,
  status text not null default 'ready'
    check (status in ('ready', 'degraded', 'disabled')),
  stability text not null default 'production'
    check (stability in ('production', 'experimental')),
  priority integer not null default 100 check (priority between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (scope = 'platform' and organization_id is null) or
    (scope = 'organization' and organization_id is not null)
  ),
  unique nulls not distinct (provider_id, scope, organization_id, name)
);

create table allrice_model_catalog_entries (
  id uuid primary key,
  provider_id uuid not null references allrice_model_providers(id),
  model text not null,
  display_name text not null,
  context_window_tokens integer check (context_window_tokens > 0),
  reasoning_efforts jsonb not null
    check (jsonb_typeof(reasoning_efforts) = 'array'),
  default_reasoning_effort text not null
    check (default_reasoning_effort in ('none', 'low', 'medium', 'high', 'xhigh')),
  input_modalities jsonb not null
    check (jsonb_typeof(input_modalities) = 'array'),
  output_modalities jsonb not null
    check (jsonb_typeof(output_modalities) = 'array'),
  enabled boolean not null default true,
  stability text not null default 'production'
    check (stability in ('production', 'experimental')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_id, model)
);

create table allrice_employee_model_policies (
  employee_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  connection_id uuid not null references allrice_model_connections(id),
  model_catalog_entry_id uuid not null references allrice_model_catalog_entries(id),
  reasoning_effort text not null
    check (reasoning_effort in ('none', 'low', 'medium', 'high', 'xhigh')),
  fallback_policy text not null default 'disabled'
    check (fallback_policy in ('disabled', 'explicit')),
  fallback_targets jsonb not null default '[]'
    check (jsonb_typeof(fallback_targets) = 'array'),
  revision integer not null default 1 check (revision > 0),
  updated_by uuid not null references allrice_users(id),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, employee_id)
    references allrice_employees(organization_id, workspace_id, id),
  check (
    (fallback_policy = 'disabled' and fallback_targets = '[]'::jsonb) or
    (fallback_policy = 'explicit' and jsonb_array_length(fallback_targets) > 0)
  )
);

create table allrice_session_model_snapshots (
  session_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  employee_id uuid not null,
  policy_revision integer not null check (policy_revision > 0),
  connection_id uuid not null references allrice_model_connections(id),
  model_catalog_entry_id uuid not null references allrice_model_catalog_entries(id),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  frozen_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, session_id)
    references allrice_chat_sessions(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, employee_id)
    references allrice_employees(organization_id, workspace_id, id)
);

create index allrice_model_connections_selection
  on allrice_model_connections (scope, organization_id, status, priority, id);
create index allrice_model_catalog_selection
  on allrice_model_catalog_entries (provider_id, enabled, stability, model);
create index allrice_employee_model_policy_tenant
  on allrice_employee_model_policies (organization_id, workspace_id, employee_id);

alter table allrice_route_decisions
  add column model_connection_id uuid references allrice_model_connections(id),
  add column model_catalog_entry_id uuid references allrice_model_catalog_entries(id),
  add column model_policy_revision integer check (model_policy_revision > 0);

create or replace function allrice_reject_route_decision_core_mutation()
returns trigger language plpgsql as $$
begin
  if
    new.organization_id is distinct from old.organization_id or
    new.workspace_id is distinct from old.workspace_id or
    new.actor_id is distinct from old.actor_id or
    new.employee_id is distinct from old.employee_id or
    new.run_id is distinct from old.run_id or
    new.input_checksum is distinct from old.input_checksum or
    new.candidates is distinct from old.candidates or
    new.selected_kind is distinct from old.selected_kind or
    new.selected_candidate_id is distinct from old.selected_candidate_id or
    new.harness is distinct from old.harness or
    new.provider is distinct from old.provider or
    new.model is distinct from old.model or
    new.model_connection_id is distinct from old.model_connection_id or
    new.model_catalog_entry_id is distinct from old.model_catalog_entry_id or
    new.model_policy_revision is distinct from old.model_policy_revision or
    new.generation is distinct from old.generation or
    new.attempt is distinct from old.attempt or
    new.reason_codes is distinct from old.reason_codes or
    new.created_at is distinct from old.created_at
  then
    raise exception 'route decision core is immutable';
  end if;
  return new;
end;
$$;

insert into allrice_model_providers (
  id, provider_key, name, harness, auth_mode
) values
  ('51000000-0000-4000-8000-000000000001', 'codex', 'Codex 订阅', 'codex', 'chatgpt_subscription'),
  ('51000000-0000-4000-8000-000000000002', 'minimax', 'MiniMax', 'dsh', 'api_key'),
  ('51000000-0000-4000-8000-000000000003', 'deepseek', 'DeepSeek', 'dsh', 'api_key');

insert into allrice_model_connections (
  id, provider_id, scope, name, credential_reference, base_url,
  status, stability, priority
) values
  (
    '52000000-0000-4000-8000-000000000001',
    '51000000-0000-4000-8000-000000000001',
    'platform', 'AllRice Codex 订阅', 'deployment:codex-default', null,
    'ready', 'production', 10
  ),
  (
    '52000000-0000-4000-8000-000000000002',
    '51000000-0000-4000-8000-000000000002',
    'platform', 'AllRice MiniMax', 'deployment:minimax-default',
    'https://api.minimaxi.com/v1', 'ready', 'production', 20
  ),
  (
    '52000000-0000-4000-8000-000000000003',
    '51000000-0000-4000-8000-000000000003',
    'platform', 'AllRice DeepSeek', 'deployment:deepseek-default',
    'https://api.deepseek.com/v1', 'degraded', 'experimental', 30
  );

insert into allrice_model_catalog_entries (
  id, provider_id, model, display_name, context_window_tokens,
  reasoning_efforts, default_reasoning_effort,
  input_modalities, output_modalities, stability
) values
  (
    '53000000-0000-4000-8000-000000000001',
    '51000000-0000-4000-8000-000000000001',
    'gpt-5.6-luna', 'GPT-5.6 Luna · 极高', null,
    '["low","medium","high","xhigh"]'::jsonb, 'xhigh',
    '["text","image","file"]'::jsonb, '["text"]'::jsonb, 'production'
  ),
  (
    '53000000-0000-4000-8000-000000000002',
    '51000000-0000-4000-8000-000000000002',
    'MiniMax-M3', 'MiniMax M3', null,
    '["low","medium","high"]'::jsonb, 'high',
    '["text","file"]'::jsonb, '["text"]'::jsonb, 'production'
  ),
  (
    '53000000-0000-4000-8000-000000000003',
    '51000000-0000-4000-8000-000000000003',
    'deepseek-v4-flash', 'DeepSeek V4 Flash', null,
    '["low","medium","high"]'::jsonb, 'high',
    '["text","file"]'::jsonb, '["text"]'::jsonb, 'experimental'
  );

insert into allrice_runtime_metadata (key, value)
values (
  'platform-model-pool-schema',
  '{"version":"0031","issue":"MET-82","default":{"provider":"codex","model":"gpt-5.6-luna","reasoningEffort":"xhigh"}}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
