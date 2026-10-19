-- A failed verifier is distinct from an unknown physical execution. Historical
-- unknown rows remain immutable; only new, exact stopped attempts can close.
alter table allrice_static_browser_verifications
  add column execution_failure jsonb,
  drop constraint allrice_static_browser_verifications_state_check,
  add constraint allrice_static_browser_verifications_state_check
    check (state in ('admitted','running','completed','unknown','failed')),
  add constraint allrice_static_browser_failure_receipt_check
    check ((state='failed') = (execution_failure is not null)
      and (execution_failure is null or (outcome is null and completed_at is not null)));

create or replace function allrice_static_browser_input_immutable() returns trigger language plpgsql as $$
begin
  if (to_jsonb(old)-array['state','started_at','container_id','browser_version','outcome','report_version_id','screenshot_version_id','completed_at','execution_failure'])
    is distinct from (to_jsonb(new)-array['state','started_at','container_id','browser_version','outcome','report_version_id','screenshot_version_id','completed_at','execution_failure'])
    or (old.container_id is not null and old.container_id is distinct from new.container_id)
    or (old.outcome is not null and old.outcome is distinct from new.outcome)
    or (old.execution_failure is not null and old.execution_failure is distinct from new.execution_failure)
    or (old.state in ('completed','unknown','failed') and old.state is distinct from new.state)
  then raise exception 'static browser inputs and accepted evidence are immutable'; end if;
  return new;
end; $$;
