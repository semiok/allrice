create table allrice_conversation_runtimes (
  organization_id uuid not null,
  workspace_id uuid not null,
  session_id uuid primary key,
  owner_id uuid not null references allrice_users(id),
  provider text not null default 'codex' check (provider = 'codex'),
  thread_id text,
  thread_generation integer not null default 0
    check (thread_generation >= 0),
  config_checksum text not null
    check (config_checksum ~ '^sha256:[a-f0-9]{64}$'),
  state text not null default 'idle'
    check (state in ('idle', 'running', 'interrupted', 'error')),
  active_run_id uuid,
  active_turn_id text,
  worker_id uuid,
  last_error_code text,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, session_id)
    references allrice_chat_sessions(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, active_run_id)
    references allrice_runs(organization_id, workspace_id, id),
  check (
    (state = 'running' and active_run_id is not null and worker_id is not null)
    or
    (state <> 'running' and active_run_id is null and active_turn_id is null
      and worker_id is null)
  )
);

create unique index allrice_conversation_runtimes_thread
  on allrice_conversation_runtimes (provider, thread_id)
  where thread_id is not null;

create index allrice_conversation_runtimes_active
  on allrice_conversation_runtimes (state, worker_id, updated_at)
  where state = 'running';

insert into allrice_runtime_metadata (key, value)
values (
  'durable-conversation-runtime-schema',
  '{"version":"0009","issue":"MET-51","provider":"codex-app-server","threadSource":"persistent","shell":"disabled"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
