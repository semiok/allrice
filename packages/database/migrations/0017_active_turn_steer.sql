create table allrice_conversation_followups (
  run_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  session_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  user_message_id uuid not null,
  assistant_message_id uuid not null,
  client_user_message_id uuid not null,
  mode text not null check (mode in ('follow_up', 'steer_fallback')),
  state text not null default 'queued'
    check (state in ('queued', 'released', 'running', 'consumed', 'canceled')),
  created_at timestamptz not null default now(),
  released_at timestamptz,
  consumed_at timestamptz,
  foreign key (organization_id, workspace_id, run_id)
    references allrice_runs(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, session_id)
    references allrice_chat_sessions(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, user_message_id)
    references allrice_messages(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, assistant_message_id)
    references allrice_messages(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, run_id),
  unique (organization_id, workspace_id, session_id, client_user_message_id)
);

create table allrice_conversation_commands (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  session_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  followup_run_id uuid not null unique,
  command_type text not null check (command_type = 'steer'),
  client_user_message_id uuid not null,
  expected_generation integer not null check (expected_generation >= 0),
  expected_turn_id text not null,
  message text not null,
  state text not null default 'pending'
    check (state in ('pending', 'claimed', 'consumed', 'rejected')),
  worker_id uuid,
  claimed_at timestamptz,
  consumed_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, session_id)
    references allrice_chat_sessions(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, followup_run_id)
    references allrice_conversation_followups(organization_id, workspace_id, run_id)
);

create index allrice_conversation_followups_fifo
  on allrice_conversation_followups (session_id, created_at, run_id)
  where state = 'queued';

create index allrice_conversation_commands_pending
  on allrice_conversation_commands (session_id, expected_generation, expected_turn_id, created_at)
  where state in ('pending', 'claimed');

insert into allrice_runtime_metadata (key, value)
values (
  'conversation-input-schema',
  '{"version":"0017","issue":"MET-66","steer":"turn/steer","followUp":"durable-fifo"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
