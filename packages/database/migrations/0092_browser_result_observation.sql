-- Post-action capture correlation is separate from immutable receipt evidence.
-- Historical operations intentionally remain NULL: no clock-based backfill can
-- prove that a workspace's current observation was captured after that action.
alter table allrice_browser_operation_inputs add column result_observation_id uuid;

create function allrice_browser_result_observation_immutable() returns trigger language plpgsql as $$
begin
 if old.result_observation_id is not null and old.result_observation_id is distinct from new.result_observation_id
 then raise exception 'browser result observation is immutable'; end if;
 return new;
end; $$;
create trigger allrice_browser_result_observation_immutable before update on allrice_browser_operation_inputs
 for each row execute function allrice_browser_result_observation_immutable();
