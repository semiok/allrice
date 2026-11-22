-- MET-285: append-only evidence of complete native observations and explicit
-- invalidations. No native order, latest head, due selection or wake authority.
create table allrice_native_schedule_observation_receipts (
  receipt_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  person_id uuid not null,
  vm_id uuid not null,
  employee_instance_id uuid not null,
  input_digest text not null check (input_digest ~ '^sha256:[a-f0-9]{64}$'),
  input_payload jsonb not null,
  received_at timestamptz not null default now(),
  constraint native_schedule_receipt_scope check (coalesce(
    jsonb_typeof(input_payload) = 'object'
    and jsonb_typeof(input_payload->'receiptId') = 'string'
    and lower(input_payload->>'receiptId') = receipt_id::text
    and jsonb_typeof(input_payload->'origin') = 'object'
    and (input_payload->'origin') ?& array[
      'organizationId','workspaceId','personId','vmId','instanceId','leaseEpoch',
      'employeeInstanceId','employeeRevision','employeeVersionId','bindingRef'
    ]
    and (input_payload->'origin') - array[
      'organizationId','workspaceId','personId','vmId','instanceId','leaseEpoch',
      'employeeInstanceId','employeeRevision','employeeVersionId','bindingRef'
    ] = '{}'::jsonb
    and lower(input_payload #>> '{origin,organizationId}') = organization_id::text
    and lower(input_payload #>> '{origin,workspaceId}') = workspace_id::text
    and lower(input_payload #>> '{origin,personId}') = person_id::text
    and lower(input_payload #>> '{origin,vmId}') = vm_id::text
    and lower(input_payload #>> '{origin,employeeInstanceId}') = employee_instance_id::text
    and jsonb_typeof(input_payload #> '{origin,instanceId}') = 'string'
    and jsonb_typeof(input_payload #> '{origin,employeeVersionId}') = 'string'
    and jsonb_typeof(input_payload #> '{origin,leaseEpoch}') = 'number'
    and (input_payload #>> '{origin,leaseEpoch}') ~ '^[1-9][0-9]*$'
    and jsonb_typeof(input_payload #> '{origin,employeeRevision}') = 'number'
    and (input_payload #>> '{origin,employeeRevision}') ~ '^[1-9][0-9]*$'
    and jsonb_typeof(input_payload #> '{origin,bindingRef}') = 'string'
    and length(input_payload #>> '{origin,bindingRef}') > 0,
    false
  )),
  -- Structural storage checks; the concrete writer validates the full DTO,
  -- canonical digest and exact references transactionally before insertion.
  constraint native_schedule_receipt_shape check (coalesce(
    jsonb_typeof(input_payload->'invalidateReceiptIds') = 'array'
    and case input_payload->>'kind'
      when 'snapshot' then
        input_payload ?& array['kind','receiptId','origin','invalidateReceiptIds','batch']
        and input_payload - array['kind','receiptId','origin','invalidateReceiptIds','batch'] = '{}'::jsonb
        and jsonb_typeof(input_payload->'batch') = 'object'
        and (input_payload->'batch') ?& array['items','fingerprint']
        and (input_payload->'batch') - array['items','fingerprint'] = '{}'::jsonb
        and jsonb_typeof(input_payload #> '{batch,items}') = 'array'
        and jsonb_typeof(input_payload #> '{batch,fingerprint}') = 'string'
        and (input_payload #>> '{batch,fingerprint}') ~ '^sha256:[a-f0-9]{64}$'
      when 'invalidation' then
        input_payload ?& array['kind','receiptId','origin','invalidateReceiptIds','reasonRef']
        and input_payload - array['kind','receiptId','origin','invalidateReceiptIds','reasonRef'] = '{}'::jsonb
        and jsonb_typeof(input_payload->'reasonRef') = 'string'
        and length(input_payload->>'reasonRef') > 0
        and jsonb_array_length(input_payload->'invalidateReceiptIds') > 0
      else false
    end,
    false
  ))
);

create function allrice_native_schedule_observation_receipt_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'native schedule observation receipts are append-only'
    using errcode = '23514';
end;
$$;
create trigger allrice_native_schedule_observation_receipt_immutable
  before update or delete on allrice_native_schedule_observation_receipts
  for each row execute function allrice_native_schedule_observation_receipt_immutable();
