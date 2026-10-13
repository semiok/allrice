-- Native scene reads belong to the exact Run/generation. Keep conservative
-- dependencies even if the native response is lost or a slash probe is unused.
alter table allrice_employee_runs add column content_scene_state jsonb,
  add check (content_scene_state is null or
    (content_generation_id is not null and jsonb_typeof(content_scene_state)='object'
     and jsonb_typeof(content_scene_state->'reads')='array'
     and jsonb_array_length(content_scene_state->'reads') between 1 and 16) is true);
create function allrice_employee_scene_state_immutable() returns trigger language plpgsql as $$
begin
  if old.content_scene_state is not null and
    (new.content_scene_state is null
     or not ((new.content_scene_state->'reads') @> (old.content_scene_state->'reads'))
     or (old.content_scene_state ? 'adopted' and
       (new.content_scene_state->'adopted') is distinct from (old.content_scene_state->'adopted'))) then
    raise exception 'scene reads and adoption are immutable';
  end if;
  return new;
end $$;
create trigger allrice_employee_scene_state_immutable before update on allrice_employee_runs
  for each row execute function allrice_employee_scene_state_immutable();
