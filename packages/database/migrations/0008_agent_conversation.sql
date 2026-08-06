alter table allrice_run_events
  drop constraint if exists allrice_run_events_event_type_check;

alter table allrice_run_events
  add constraint allrice_run_events_event_type_check
  check (event_type in (
    'run.created', 'run.started', 'run.retrying',
    'step.started', 'step.completed',
    'assistant.text.delta', 'assistant.text.completed',
    'tool.started', 'tool.completed', 'tool.failed',
    'artifact.created', 'approval.requested', 'approval.decided',
    'run.succeeded', 'run.failed', 'run.canceled', 'heartbeat'
  ));

insert into allrice_runtime_metadata (key, value)
values (
  'agent-conversation-schema',
  '{"version":"0008","issue":"MET-51","eventSchemaVersion":1,"shell":"disabled"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
