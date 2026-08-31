alter table allrice_conversation_runtimes
  add column dsh_context_as_of_seq integer,
  add column dsh_context_pressure_tokens integer
    check (dsh_context_pressure_tokens >= 0),
  add column dsh_context_projected_tokens integer
    check (dsh_context_projected_tokens >= 0),
  add column dsh_context_window_tokens integer
    check (dsh_context_window_tokens > 0),
  add column dsh_context_observed_at timestamptz;

comment on column allrice_conversation_runtimes.context_pressure_tokens is
  'ChatFlow recovery-checkpoint pressure; not the DSH model context occupancy.';

comment on column allrice_conversation_runtimes.dsh_context_projected_tokens is
  'DSH contextPressure projectedTokens, the native WebUI occupancy numerator.';
