-- MET-210 PR4: DSH remains the question authority; this is its SaaS projection.
alter table allrice_chat_sessions add column native_question_sequence bigint;

create table allrice_native_questions (
  session_id uuid not null references allrice_chat_sessions(id) on delete cascade,
  native_session_id text not null,
  call_id text not null,
  source_run_id uuid not null references allrice_runs(id),
  state text not null check (state in ('open', 'continued', 'settled')),
  questions jsonb not null default '[]',
  answers jsonb,
  sequence bigint not null,
  native_present boolean not null default true,
  closed_at timestamptz,
  primary key (session_id, call_id)
);

insert into allrice_settings(scope_type,key,value)
values ('system','native_question_mode','"legacy"')
on conflict (scope_type,scope_id,key) do nothing;
