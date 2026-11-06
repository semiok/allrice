-- Reuse the existing collection watermark; do not enable a policy or reset
-- pending/ignored/captured history. Old sources and receipts stay historical.
-- Both inherited and organization policies need the same deployment boundary.
-- An operator must first use the existing policy-off transaction to close
-- retained experience plans. Do not silently change their authority proof.
do $$
begin
  if exists (
    select 1 from allrice_native_calendar_plans p
    join allrice_native_recurring_controls c on c.control_id=p.control_id
    where p.closed_decision_id is null
      and c.immutable_identity->'dispatch'->>'consumer'='experience-consolidation-v1'
  ) then
    raise exception 'memory_source_cutover_requires_experience_policy_off';
  end if;
end $$;

update allrice_settings
set value = jsonb_set(
      jsonb_set(value, '{collectionStartedAt}', to_jsonb(to_char(
        greatest((value->>'collectionStartedAt')::timestamptz, clock_timestamp())
          at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))),
      '{revision}', to_jsonb((value->>'revision')::integer + 1)),
    updated_at = clock_timestamp()
where key = 'employee_experience_policy'
  and scope_type in ('system', 'organization');
