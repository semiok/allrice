-- MET-79: ChatFlow Runtime durable event convergence and transactional wakeups.

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

create or replace function allrice_notify_run_event()
returns trigger
language plpgsql
as $$
begin
  perform pg_notify(
    'allrice_run_events',
    json_build_object('runId', new.run_id, 'sequence', new.sequence)::text
  );
  return new;
end;
$$;

drop trigger if exists allrice_run_event_notify on allrice_run_events;
create trigger allrice_run_event_notify
after insert on allrice_run_events
for each row execute function allrice_notify_run_event();

insert into allrice_runtime_metadata (key, value)
values (
  'chatflow-runtime',
  '{"version":"0029","issue":"MET-79","durableSource":"run_events","wakeup":"postgres-listen-notify","fallback":"sse-polling","futureTransports":["redis-streams","nats"]}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
