-- MET-79: expose the frozen Harness routing decision in ChatFlow traces.

alter table allrice_run_events drop constraint if exists allrice_run_events_event_type_check;
alter table allrice_run_events add constraint allrice_run_events_event_type_check check (event_type in (
  'run.created', 'run.started', 'run.retrying',
  'session.bound',
  'turn.started', 'turn.completed', 'turn.failed', 'turn.canceled',
  'routing.selected',
  'step.started', 'step.completed', 'step.waiting_approval', 'step.retrying',
  'step.compensating', 'step.compensated',
  'assistant.text.delta', 'assistant.text.completed',
  'tool.started', 'tool.completed', 'tool.failed',
  'artifact.created', 'approval.requested', 'approval.decided',
  'knowledge.retrieved',
  'context.compaction.started', 'context.compaction.completed',
  'context.compaction.failed', 'context.checkpoint.created',
  'usage.updated',
  'run.succeeded', 'run.failed', 'run.canceled', 'run.needs_attention',
  'heartbeat'
));

insert into allrice_runtime_metadata (key, value)
values (
  'chatflow-event-contract',
  '{"version":"0030","issue":"MET-79","routingEvent":"routing.selected"}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
