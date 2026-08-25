alter table allrice_conversation_runtimes
  add column usage_baseline_input_tokens integer
    check (usage_baseline_input_tokens >= 0),
  add column last_input_tokens integer
    check (last_input_tokens >= 0),
  add column last_cached_input_tokens integer
    check (last_cached_input_tokens >= 0),
  add column dynamic_context_tokens integer not null default 0
    check (dynamic_context_tokens >= 0);

with usage_events as (
  select
    er.session_id,
    e.occurred_at,
    e.id,
    (e.payload -> 'usage' ->> 'inputTokens')::integer as input_tokens,
    coalesce((e.payload -> 'usage' ->> 'cachedInputTokens')::integer, 0)
      as cached_input_tokens
  from allrice_run_events e
  join allrice_employee_runs er on er.run_id = e.run_id
  join allrice_conversation_runtimes runtime
    on runtime.session_id = er.session_id
  where e.event_type = 'heartbeat'
    and jsonb_typeof(e.payload -> 'usage') = 'object'
    and (e.payload -> 'usage' ->> 'inputTokens') ~ '^[0-9]+$'
    and (e.payload ->> 'generation') ~ '^[0-9]+$'
    and (e.payload ->> 'generation')::integer = runtime.thread_generation
), usage_watermarks as (
  select distinct on (session_id)
    session_id,
    first_value(input_tokens) over (
      partition by session_id order by occurred_at, id
    ) as baseline_input_tokens,
    input_tokens as last_input_tokens,
    cached_input_tokens as last_cached_input_tokens
  from usage_events
  order by session_id, occurred_at desc, id desc
)
update allrice_conversation_runtimes runtime
set usage_baseline_input_tokens = watermark.baseline_input_tokens,
    last_input_tokens = watermark.last_input_tokens,
    last_cached_input_tokens = watermark.last_cached_input_tokens,
    dynamic_context_tokens = greatest(
      watermark.last_input_tokens - watermark.baseline_input_tokens,
      0
    )
from usage_watermarks watermark
where runtime.session_id = watermark.session_id;

update allrice_conversation_followups followup
set state = case
      when run.state = 'succeeded' then 'consumed'
      else 'canceled'
    end,
    consumed_at = case
      when run.state = 'succeeded' then coalesce(run.completed_at, now())
      else followup.consumed_at
    end
from allrice_runs run
where run.id = followup.run_id
  and followup.state in ('released', 'running')
  and run.state in ('succeeded', 'failed', 'canceled');

insert into allrice_runtime_metadata (key, value)
values (
  'conversation-usage-watermark-schema',
  '{"version":"0018","issue":"MET-51","strategy":"baseline-relative-max-visible"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
