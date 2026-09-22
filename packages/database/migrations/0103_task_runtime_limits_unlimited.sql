-- MET-153: allow unlimited (0) task runtime limits and align max timeout with governance (86400000).
-- 1 hour (3600000) is the platform default.
-- Preserve initial deadlines to enable exact wait-suspension extension.

do $$
declare
  c_name text;
begin
  for c_name in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'allrice_model_resource_limits'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%max_runtime_ms%'
  loop
    execute format('alter table allrice_model_resource_limits drop constraint %I', c_name);
  end loop;
end;
$$;

alter table allrice_model_resource_limits
  add constraint allrice_model_resource_limits_max_runtime_ms_check
  check (max_runtime_ms = 0 or (max_runtime_ms between 1000 and 86400000));

do $$
declare
  c_name text;
begin
  for c_name in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'allrice_employee_model_policies'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%timeout_ms%'
  loop
    execute format('alter table allrice_employee_model_policies drop constraint %I', c_name);
  end loop;
end;
$$;

alter table allrice_employee_model_policies
  alter column timeout_ms set default 3600000,
  add constraint allrice_employee_model_policies_timeout_ms_check
  check (timeout_ms = 0 or (timeout_ms between 1000 and 86400000));

do $$
declare
  c_name text;
begin
  for c_name in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'allrice_skill_installations'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%timeout_ms%'
  loop
    execute format('alter table allrice_skill_installations drop constraint %I', c_name);
  end loop;
end;
$$;

alter table allrice_skill_installations
  alter column timeout_ms set default 3600000,
  add constraint allrice_skill_installations_timeout_ms_check
  check (timeout_ms = 0 or (timeout_ms between 1000 and 86400000));

alter table allrice_runtime_roots
  add column if not exists initial_deadline_at timestamptz;

update allrice_runtime_roots
  set initial_deadline_at = deadline_at
  where initial_deadline_at is null;

create or replace function allrice_set_initial_root_deadline()
returns trigger language plpgsql as $$
begin
  if new.initial_deadline_at is null then
    new.initial_deadline_at := new.deadline_at;
  end if;
  return new;
end;
$$;

drop trigger if exists allrice_runtime_roots_initial_deadline_trigger on allrice_runtime_roots;
create trigger allrice_runtime_roots_initial_deadline_trigger
  before insert on allrice_runtime_roots
  for each row
  execute function allrice_set_initial_root_deadline();

alter table allrice_jobs
  add column if not exists initial_timeout_at timestamptz;

update allrice_jobs
  set initial_timeout_at = timeout_at
  where initial_timeout_at is null;

create or replace function allrice_set_initial_job_timeout()
returns trigger language plpgsql as $$
begin
  if new.initial_timeout_at is null then
    new.initial_timeout_at := new.timeout_at;
  end if;
  return new;
end;
$$;

drop trigger if exists allrice_jobs_initial_timeout_trigger on allrice_jobs;
create trigger allrice_jobs_initial_timeout_trigger
  before insert on allrice_jobs
  for each row
  execute function allrice_set_initial_job_timeout();

insert into allrice_runtime_metadata (key, value)
values (
  'task-runtime-limits-unlimited',
  '{"version":"0103","issue":"MET-153","allowUnlimited":true,"defaultTimeoutMs":3600000}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
