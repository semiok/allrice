create table allrice_dsh_runtime_instances (
  id uuid primary key,
  worker_id uuid not null,
  organization_id uuid not null,
  workspace_id uuid not null,
  session_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  thread_id text not null,
  provider_route text not null,
  model text not null,
  reasoning_effort text not null,
  profile_fingerprint text not null
    check (profile_fingerprint ~ '^[a-f0-9]{64}$'),
  native_tools jsonb not null default '[]'::jsonb,
  status text not null default 'live'
    check (status in ('live', 'offline')),
  started_at timestamptz not null,
  last_activity_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, session_id)
    references allrice_chat_sessions(organization_id, workspace_id, id),
  unique (thread_id),
  check ((status = 'live' and ended_at is null)
    or (status = 'offline' and ended_at is not null))
);

create index allrice_dsh_runtime_instances_worker_live
  on allrice_dsh_runtime_instances (worker_id, status, last_seen_at desc);
create index allrice_dsh_runtime_instances_session_recent
  on allrice_dsh_runtime_instances (session_id, last_seen_at desc);

insert into allrice_runtime_metadata (key, value)
values (
  'dsh-runtime-registry',
  '{"version":"0044","issue":"MET-90","authority":"worker-heartbeat","console":"read-only"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
