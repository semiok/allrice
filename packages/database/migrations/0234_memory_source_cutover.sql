-- Reuse the existing collection watermark; do not enable a policy or reset
-- pending/ignored/captured history. Old sources and receipts stay historical.
-- Both inherited and organization policies need the same deployment boundary.
update allrice_settings
set value = jsonb_set(
      jsonb_set(value, '{collectionStartedAt}', to_jsonb(to_char(
        greatest((value->>'collectionStartedAt')::timestamptz, clock_timestamp())
          at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))),
      '{revision}', to_jsonb((value->>'revision')::integer + 1)),
    updated_at = clock_timestamp()
where key = 'employee_experience_policy'
  and scope_type in ('system', 'organization');
