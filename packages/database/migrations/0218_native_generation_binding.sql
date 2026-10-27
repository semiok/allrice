-- Native contexts bind to the DSH generation; a recorded artifactId (origin, binding,
-- Run, control reference) is provenance and is never rewritten here. Removes what the
-- archived drafts 0213–0216 created wherever they ran (M1 Dev applied them on 10-25) and
-- retires the 0202 control-upgrade ledger: a control reference is immutable again
-- (0195). Kept: 0199 retirements, the 0202 digest helpers, 0212 close evidence.
set local lock_timeout = '15s';  -- hot tables need ACCESS EXCLUSIVE; fail fast, not hang with Dev down

-- 0. No archived ledger may contain facts. Fresh databases never had these tables.
do $$ declare ledger text; populated boolean; begin
  foreach ledger in array array['allrice_native_chat_executor_transitions',
    'allrice_native_control_cloud_absences', 'allrice_native_control_upgrades',
    'allrice_native_control_upgrade_plans'] loop
    if to_regclass(format('%I.%I', current_schema(), ledger)) is not null then
      execute format('select exists(select 1 from %I.%I)', current_schema(), ledger) into populated;
      if populated then raise exception 'MET221_0218_LEDGER_NOT_EMPTY %', ledger; end if;
    end if;
  end loop;
  if exists (select 1 from allrice_native_context_retirements where context_kind <> 'chat') then
    raise exception 'MET221_0218_TERMINAL_RETIREMENTS_PRESENT'; end if;
end $$;

-- 1. Restore the 0210 guard verbatim. Run artifacts remain origin provenance.
create or replace function allrice_employee_execution_binding_guard() returns trigger language plpgsql as $$
declare origin jsonb;
begin
  if tg_op = 'UPDATE' then
    if new.native_execution_binding is distinct from old.native_execution_binding then
      raise exception 'employee execution binding is immutable';
    end if;
    return new;
  end if;
  select native_root_origin into origin from allrice_chat_sessions
    where id=new.session_id and organization_id=new.organization_id
      and workspace_id=new.workspace_id and owner_id=new.owner_id;
  if origin->>'schemaVersion' = '2' then
    if new.native_execution_binding is null
      or new.native_execution_binding->>'schemaVersion' is distinct from '1'
      or new.native_execution_binding->>'kind' is distinct from 'current_employee_execution'
      or new.native_execution_binding#>>'{scope,organizationId}' is distinct from new.organization_id::text
      or new.native_execution_binding#>>'{scope,workspaceId}' is distinct from new.workspace_id::text
      or new.native_execution_binding#>>'{scope,ownerId}' is distinct from new.owner_id::text
      or new.native_execution_binding#>>'{scope,sessionId}' is distinct from new.session_id::text
      or new.native_execution_binding#>>'{scope,runId}' is distinct from new.run_id::text
      or new.native_execution_binding#>>'{source,employeeVersionId}' is distinct from new.employee_version_id::text
      or new.native_execution_binding#>>'{execution,artifactId}' is distinct from origin->>'artifactId'
      or new.native_execution_binding#>>'{execution,generation}' is distinct from origin->>'distributionGeneration'
      or new.native_execution_binding#>>'{execution,profileId}' is distinct from 'restricted'
      or new.native_execution_binding#>>'{sourcePolicy,family}' is distinct from origin#>>'{sourcePolicy,family}' then
      raise exception 'current employee execution binding required';
    end if;
  elsif new.native_execution_binding is not null then
    raise exception 'historical employee execution cannot be rebound';
  end if;
  return new;
end;
$$;
drop trigger if exists employee_execution_binding_guard on allrice_employee_runs;
create trigger employee_execution_binding_guard before insert or update on allrice_employee_runs
  for each row execute function allrice_employee_execution_binding_guard();



-- 2. Control reference immutable again: 0195 body, no upgrade-ledger exception.
create or replace function allrice_native_once_partition_guard() returns trigger language plpgsql as $$
begin
  if new.partition_id<>old.partition_id or new.reference<>old.reference then
    raise exception 'native once reference is immutable' using errcode='23514';
  end if;
  if new.epoch=old.epoch then
    if new.owner_id is distinct from old.owner_id or new.token_digest is distinct from old.token_digest
      or (old.closed and not new.closed) or (old.closed and new.close_proof<>old.close_proof) then
      raise exception 'native once epoch fence' using errcode='23514';
    end if;
  elsif new.epoch<>old.epoch+1 or not old.closed or new.closed
    or new.owner_id is null or new.token_digest is null then
    raise exception 'native once acquire requires explicit close' using errcode='23514';
  end if;
  return new;
end $$;

-- 3. 0214 + 0202 upgrade ledger (FK order: absences -> upgrades -> plans).
drop table if exists allrice_native_control_cloud_absences;
drop table if exists allrice_native_control_upgrades;
drop table if exists allrice_native_control_upgrade_plans;
drop function if exists
  allrice_native_control_upgrade_idle_for(jsonb,jsonb),
  allrice_native_control_cloud_coverage(jsonb,jsonb),
  allrice_native_control_cloud_absence_guard(),
  allrice_native_control_cloud_inventory_valid(jsonb,jsonb),
  allrice_native_control_cloud_inventory_identity(jsonb),
  allrice_native_control_historical_cloud_snapshot(),
  allrice_native_control_upgrade_commit_fence(),
  allrice_native_control_upgrade_guard(),
  allrice_native_control_upgrade_plan_guard(),
  allrice_native_control_upgrade_offline_valid(jsonb,jsonb),
  allrice_native_control_upgrade_facts(text),
  allrice_native_control_upgrade_idle(),
  allrice_native_control_upgrade_workspace_allowed(text,jsonb,text,text),
  allrice_native_control_json_pin(jsonb);

-- 4. 0215: 25 triggers, then 14 functions.
drop trigger if exists terminal_native_test_source on allrice_platform_employee_test_runs;
drop trigger if exists terminal_native_technical_source on allrice_platform_technical_tasks;
drop trigger if exists terminal_native_experience_source on allrice_automation_runs;
drop trigger if exists terminal_native_binding_fence on allrice_native_session_bindings;
drop trigger if exists terminal_native_owner_fence on allrice_dsh_runtime_close_observations;
drop trigger if exists terminal_native_retirement_guard on allrice_native_context_retirements;
drop trigger if exists terminal_native_retirement_commit on allrice_native_context_retirements;
drop trigger if exists terminal_native_run_fence on allrice_runs;
drop trigger if exists terminal_native_job_fence on allrice_jobs;
drop trigger if exists terminal_native_event_fence on allrice_run_events;
drop trigger if exists terminal_native_child_fence on allrice_runtime_run_links;
drop trigger if exists terminal_native_operation_fence on allrice_runtime_operations;
drop trigger if exists terminal_native_model_admission_fence on allrice_assistant_model_admissions;
drop trigger if exists terminal_native_assistant_fence on allrice_assistant_instances;
drop trigger if exists terminal_native_assistant_message_fence on allrice_assistant_messages;
drop trigger if exists terminal_native_wait_fence on allrice_task_resource_waits;
drop trigger if exists terminal_native_task_call_fence on allrice_task_calls;
drop trigger if exists terminal_native_question_fence on allrice_native_question_waits;
drop trigger if exists terminal_native_dispatch_fence on allrice_native_task_dispatches;
drop trigger if exists terminal_native_validation_consumer on allrice_platform_employee_test_runs;
drop trigger if exists terminal_native_recurring_consumer on allrice_native_recurring_occurrences;
drop trigger if exists terminal_native_once_consumer on allrice_native_once_occurrences;
drop trigger if exists terminal_native_registry_fence on allrice_dsh_runtime_instances;
drop trigger if exists terminal_native_method_binding_fence on allrice_employee_method_tests;
drop trigger if exists terminal_native_method_file_fence on allrice_employee_method_file_steps;
drop function if exists
  allrice_terminal_native_source_fence(), allrice_terminal_native_admission_fence(),
  allrice_terminal_native_retirement_guard(), allrice_terminal_native_retirement_commit(),
  allrice_terminal_native_queue_fence(), allrice_terminal_native_consumer_fence(),
  allrice_terminal_native_registry_fence(), allrice_terminal_native_method_fence(),
  allrice_terminal_native_run_contexts(uuid,jsonb), allrice_terminal_native_test_facts(text,uuid,uuid,uuid,uuid),
  allrice_terminal_native_test_available(text,uuid), allrice_terminal_native_owner_confirmed(uuid,uuid),
  allrice_terminal_native_test_roots(text,uuid), allrice_terminal_native_test_lock(text,uuid);

-- 5. 0213 + 0216 (the binding guard no longer references them after step 1).
drop table if exists allrice_native_chat_executor_transitions;
drop function if exists
  allrice_native_chat_executor_guard(), allrice_native_chat_adoption_facts(uuid,uuid),
  allrice_native_chat_effective_origin(uuid), allrice_native_chat_executor_facts(uuid,uuid),
  allrice_native_chat_executor_idle(uuid), allrice_employee_execution_binding_guard_before_transition();

-- 6. SQL projection of NativeJournalContractRowSchema in native-journal-contract-store.ts:
-- strict {highWater: integer 1..999999999, since?: string 1..40 UTF-16 code units}.
-- The DB integration test checks acceptance against that exported schema.
create function allrice_dsh_journal_contract_monotonic() returns trigger language plpgsql as $$
declare high_water numeric;
begin
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.key = 'dsh-journal-contract' and new.key is distinct from old.key) then
    raise exception 'DSH_NATIVE_JOURNAL_CONTRACT_IMMUTABLE';
  end if;
  if jsonb_typeof(new.value) is distinct from 'object'
    or jsonb_typeof(new.value->'highWater') is distinct from 'number' then
    raise exception 'DSH_NATIVE_JOURNAL_CONTRACT_REGRESSION';
  end if;
  high_water := (new.value->>'highWater')::numeric;
  if high_water < 1 or high_water > 999999999 or high_water <> trunc(high_water)
    or new.value - 'highWater' - 'since' <> '{}'::jsonb then
    raise exception 'DSH_NATIVE_JOURNAL_CONTRACT_REGRESSION';
  end if;
  if new.value ? 'since' then
    if jsonb_typeof(new.value->'since') is distinct from 'string'
      or (select coalesce(sum(case when ascii(c)>65535 then 2 else 1 end),0)
          from regexp_split_to_table(new.value->>'since','') c) not between 1 and 40 then
      raise exception 'DSH_NATIVE_JOURNAL_CONTRACT_REGRESSION';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.key = 'dsh-journal-contract'
    and high_water < (old.value->>'highWater')::numeric then
    raise exception 'DSH_NATIVE_JOURNAL_CONTRACT_REGRESSION';
  end if;
  return new;
end $$;
create trigger allrice_dsh_journal_contract_insert before insert on allrice_runtime_metadata
  for each row when (new.key = 'dsh-journal-contract') execute function allrice_dsh_journal_contract_monotonic();
create trigger allrice_dsh_journal_contract_update before update on allrice_runtime_metadata
  for each row when (new.key = 'dsh-journal-contract' or old.key = 'dsh-journal-contract')
  execute function allrice_dsh_journal_contract_monotonic();
create trigger allrice_dsh_journal_contract_delete before delete on allrice_runtime_metadata
  for each row when (old.key = 'dsh-journal-contract') execute function allrice_dsh_journal_contract_monotonic();
-- Preserve a pre-existing Worker value and validate it through the same trigger.
insert into allrice_runtime_metadata (key, value)
  values ('dsh-journal-contract', '{"highWater": 1, "since": "0218"}')
  on conflict (key) do update set value = allrice_runtime_metadata.value;

-- 7. Close evidence is read per boot.
create index if not exists allrice_dsh_close_boot on allrice_dsh_runtime_close_observations (worker_boot_id)
  where observation_kind = 'owned';

-- 8. End state: nothing kept refers to anything dropped (PL/pgSQL bodies are not in pg_depend).
do $$ declare leftover text; begin
  select string_agg(format('%s.%s', tgrelid::regclass, tgname), ', ') into leftover from pg_trigger
   where tgrelid in (select oid from pg_class where relnamespace=current_schema()::regnamespace)
     and not tgisinternal and (tgname like 'terminal\_native\_%' or tgname like 'native\_chat\_executor\_%'
     or tgname like 'native\_control\_upgrade\_%' or tgname like 'native\_control\_cloud\_absence\_%');
  if leftover is not null then raise exception 'MET221_0218_LEFTOVER_TRIGGERS %', leftover; end if;
  select string_agg(p.oid::regprocedure::text, ', ') into leftover from pg_proc p
   where p.pronamespace = current_schema()::regnamespace and p.prosrc ~
     '\m(allrice_native_chat_executor_transitions|allrice_native_chat_(effective_origin|adoption_facts|executor_facts|executor_idle|executor_guard)|allrice_native_control_cloud_[a-z_]+|allrice_native_control_upgrade[a-z_]*|allrice_native_control_json_pin|allrice_native_control_historical_cloud_snapshot|allrice_terminal_native_[a-z_]+|allrice_employee_execution_binding_guard_before_transition)\M';
  if leftover is not null then raise exception 'MET221_0218_DANGLING_REFERENCE %', leftover; end if;
end $$;
