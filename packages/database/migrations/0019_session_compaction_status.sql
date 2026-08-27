alter table allrice_conversation_runtimes
  add column compact_threshold_tokens integer not null default 40000
    check (compact_threshold_tokens between 1000 and 1000000),
  add column context_pressure_tokens integer not null default 0
    check (context_pressure_tokens >= 0);

update allrice_conversation_runtimes
set context_pressure_tokens = dynamic_context_tokens;

insert into allrice_runtime_metadata (key, value)
values (
  'session-compaction-status-schema',
  '{"version":"0019","issue":"MET-61","semantics":"floor-pressure-percent"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
