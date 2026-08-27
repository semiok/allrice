-- MET-82: complete the employee model policy contract with explicit run limits
-- and deterministic fallback conditions. Existing policies receive safe defaults;
-- immutable session snapshots keep their original JSON and parse with the same
-- defaults when replayed.

alter table allrice_employee_model_policies
  add column fallback_on jsonb not null default
    '["provider_unavailable","rate_limited","timeout","transient_error"]'::jsonb
    check (jsonb_typeof(fallback_on) = 'array'),
  add column timeout_ms integer not null default 300000
    check (timeout_ms between 1000 and 3600000),
  add column max_input_tokens integer not null default 120000
    check (max_input_tokens between 1000 and 2000000),
  add column max_output_tokens integer not null default 16000
    check (max_output_tokens between 1 and 200000),
  add column max_total_tokens integer not null default 136000
    check (max_total_tokens between 1000 and 2000000),
  add column max_cost_cents integer
    check (max_cost_cents between 0 and 1000000),
  add constraint allrice_employee_model_policy_total_limit
    check (
      max_total_tokens >= max_input_tokens and
      max_total_tokens >= max_output_tokens
    );

insert into allrice_runtime_metadata (key, value)
values (
  'platform-model-policy-limits',
  '{"version":"0032","issue":"MET-82","timeoutMs":300000,"maxInputTokens":120000,"maxOutputTokens":16000,"maxTotalTokens":136000}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
