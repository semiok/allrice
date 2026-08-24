alter table allrice_automations
  add column conversation_mode text not null default 'new_each_run'
    check (conversation_mode in ('new_each_run', 'reuse'));

alter table allrice_automation_runs
  add column session_id uuid;

alter table allrice_automation_runs
  add foreign key (organization_id, workspace_id, session_id)
    references allrice_chat_sessions(organization_id, workspace_id, id);

create index allrice_automation_runs_session
  on allrice_automation_runs (organization_id, workspace_id, session_id)
  where session_id is not null;

insert into allrice_runtime_metadata (key, value)
values (
  'automation-conversation-schema',
  '{"version":"0012","modes":["new_each_run","reuse"]}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
