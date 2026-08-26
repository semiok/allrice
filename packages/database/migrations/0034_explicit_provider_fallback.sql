-- MET-83: auditable, condition-gated Provider fallback across durable attempts.

alter table allrice_route_decisions
  add column fallback_from_decision_id uuid references allrice_route_decisions(id),
  add column fallback_condition text check (fallback_condition in (
    'provider_unavailable', 'rate_limited', 'timeout', 'transient_error'
  ));

create or replace function allrice_reject_route_decision_core_mutation()
returns trigger language plpgsql as $$
begin
  if
    new.organization_id is distinct from old.organization_id or
    new.workspace_id is distinct from old.workspace_id or
    new.actor_id is distinct from old.actor_id or
    new.employee_id is distinct from old.employee_id or
    new.run_id is distinct from old.run_id or
    new.input_checksum is distinct from old.input_checksum or
    new.candidates is distinct from old.candidates or
    new.selected_kind is distinct from old.selected_kind or
    new.selected_candidate_id is distinct from old.selected_candidate_id or
    new.harness is distinct from old.harness or
    new.provider is distinct from old.provider or
    new.model is distinct from old.model or
    new.model_connection_id is distinct from old.model_connection_id or
    new.model_catalog_entry_id is distinct from old.model_catalog_entry_id or
    new.model_policy_revision is distinct from old.model_policy_revision or
    new.fallback_from_decision_id is distinct from old.fallback_from_decision_id or
    new.fallback_condition is distinct from old.fallback_condition or
    new.generation is distinct from old.generation or
    new.attempt is distinct from old.attempt or
    new.reason_codes is distinct from old.reason_codes or
    new.created_at is distinct from old.created_at
  then
    raise exception 'route decision core is immutable';
  end if;
  return new;
end;
$$;

insert into allrice_runtime_metadata (key, value)
values (
  'explicit-provider-fallback',
  '{"version":"0034","issue":"MET-83","mode":"durable-attempt","silentFallback":false}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
