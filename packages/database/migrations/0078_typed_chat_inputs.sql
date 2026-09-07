-- P10 adds receipts to the existing message/Run/FIFO, never a second agent queue.
create table allrice_chat_input_requests (
  user_message_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  session_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  client_message_id uuid not null,
  request_digest text not null check(request_digest ~ '^sha256:[a-f0-9]{64}$'),
  kind text not null check(kind in ('message','steer_current','queue_next','ask_user','plan_review','version_feedback')),
  created_at timestamptz not null default now(),
  foreign key(organization_id,workspace_id,user_message_id) references allrice_messages(organization_id,workspace_id,id),
  foreign key(organization_id,workspace_id,session_id) references allrice_chat_sessions(organization_id,workspace_id,id),
  unique(organization_id,workspace_id,session_id,owner_id,client_message_id)
);
alter table allrice_conversation_followups drop constraint allrice_conversation_followups_mode_check;
alter table allrice_conversation_followups add constraint allrice_conversation_followups_mode_check
  check(mode in ('follow_up','steer_fallback','steer_only'));
alter table allrice_conversation_commands add column input_kind text
  check(input_kind in ('steer_current','ask_user'));
alter table allrice_conversation_commands add column native_proof jsonb;
alter table allrice_conversation_commands add column delivery_attempts integer not null default 0;
alter table allrice_conversation_commands add column next_attempt_at timestamptz not null default now();
-- Unanswered legacy forms are not ordinary follow-up prompts, either.
update allrice_conversation_followups f set mode='steer_only'
  from allrice_conversation_commands c where c.followup_run_id=f.run_id and f.state='queued'
  and c.state in ('pending','claimed') and c.message like 'allrice:user-question:v1:%';
update allrice_conversation_commands set input_kind='ask_user'
  where state in ('pending','claimed') and message like 'allrice:user-question:v1:%';
-- A response is an immutable instruction for a distinct Run, not action authority.
create table allrice_review_continuations (
  response_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  session_id uuid not null,
  actor_id uuid not null references allrice_users(id),
  artifact_id uuid not null,
  checksum text not null check(checksum ~ '^sha256:[a-f0-9]{64}$'),
  kind text not null check(kind in ('plan_review','version_feedback')),
  feedback_id uuid references allrice_artifact_feedback(id),
  run_id uuid not null,
  created_at timestamptz not null default now(),
  check((kind='version_feedback')=(feedback_id is not null)),
  foreign key(organization_id,workspace_id,artifact_id) references allrice_deliverable_versions(organization_id,workspace_id,id),
  foreign key(organization_id,workspace_id,run_id) references allrice_runs(organization_id,workspace_id,id),
  foreign key(organization_id,workspace_id,session_id) references allrice_chat_sessions(organization_id,workspace_id,id)
);
create unique index allrice_review_continuation_once on allrice_review_continuations
  (organization_id,workspace_id,actor_id,artifact_id,kind,coalesce(feedback_id,'00000000-0000-0000-0000-000000000000'::uuid));
create trigger allrice_review_continuation_immutable before update or delete on allrice_review_continuations
  for each row execute function allrice_workbench_artifact_immutable();
