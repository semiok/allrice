create table allrice_context_checkpoints (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  session_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  harness text not null check (harness in ('codex', 'dsh')),
  thread_id text,
  thread_generation integer not null check (thread_generation >= 0),
  covered_through_message_id uuid,
  summary_version text not null check (summary_version = 'extractive-v1'),
  summary text not null,
  checksum text not null check (checksum ~ '^sha256:[a-f0-9]{64}$'),
  config_checksum text not null check (config_checksum ~ '^sha256:[a-f0-9]{64}$'),
  estimated_tokens integer not null check (estimated_tokens >= 0),
  message_count integer not null check (message_count >= 0),
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, session_id)
    references allrice_chat_sessions(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, covered_through_message_id)
    references allrice_messages(organization_id, workspace_id, id),
  unique (session_id, thread_generation, checksum),
  unique (organization_id, workspace_id, id)
);

create index allrice_context_checkpoints_latest
  on allrice_context_checkpoints (
    organization_id, workspace_id, session_id, created_at desc
  );

insert into allrice_runtime_metadata (key, value)
values (
  'context-checkpoint-schema',
  '{"version":"0016","issue":"MET-65","summary":"extractive-v1"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
