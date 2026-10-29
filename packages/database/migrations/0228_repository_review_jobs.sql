-- Reviews are ordinary independent Jobs. Keep existing historical facts, but
-- their assistant report is no longer execution or merge authority.
-- Resolve the exact column/target pair: PostgreSQL shortens generated names
-- (the subject table + reviewer_run_id + _fkey is 64 bytes).
do $$
declare
  relation_name text;
  constraint_name text;
begin
  foreach relation_name in array array[
    'allrice_platform_repository_review_subjects',
    'allrice_platform_repository_reviews'
  ] loop
    select c.conname into strict constraint_name from pg_constraint c
      join pg_attribute a on a.attrelid=c.conrelid and a.attname='reviewer_run_id'
      where c.conrelid=relation_name::regclass and c.contype='f'
        and c.confrelid='allrice_assistant_instances'::regclass
        and c.conkey=array[a.attnum];
    execute format('alter table %I drop constraint %I', relation_name, constraint_name);
    execute format('alter table %I add constraint %I foreign key (reviewer_run_id) references allrice_runs(id)', relation_name, constraint_name);
  end loop;
end $$;
-- 0101/0102 are the separate legacy development workflow; PR2b deletes that
-- closed dependency set. This migration does not change those tables.
