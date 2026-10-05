-- Private deterministic QA reuses Automation occurrences and the Run queue.
alter table allrice_automations add column quality_binding jsonb;
alter table allrice_automations add constraint allrice_quality_automation_config check (
  quality_binding is null or (
    quality_binding = '{"version":1,"caseId":"project.static.v1","variant":"correct"}'::jsonb
    and trigger_type='schedule' and conversation_mode='new_each_run'
    and schedule->>'frequency'='daily' and schedule->>'timezone'='Asia/Shanghai'
    and employee_assignment_id is not null
  )
);
create unique index allrice_quality_automation_owner on allrice_automations(owner_id)
  where quality_binding is not null and deleted_at is null;
alter table allrice_automation_runs add column quality_occurrence jsonb;
alter table allrice_automation_runs add constraint allrice_quality_occurrence_object check (
  quality_occurrence is null or (jsonb_typeof(quality_occurrence)='object' and folder_event_id is null)
);
create index allrice_quality_dispatch_pending on allrice_automation_runs(created_at,id)
  where quality_occurrence is not null and run_id is null and status='queued';
alter table allrice_platform_quality_checks add column automation_run_id uuid unique
  references allrice_automation_runs(id);

create function allrice_quality_occurrence_immutable() returns trigger language plpgsql as $$
begin
  if old.quality_occurrence is not null and (
    new.quality_occurrence is distinct from old.quality_occurrence or
    new.id is distinct from old.id or new.automation_id is distinct from old.automation_id or
    new.organization_id is distinct from old.organization_id or new.workspace_id is distinct from old.workspace_id or
    new.scheduled_for is distinct from old.scheduled_for
  ) then raise exception 'quality occurrence is immutable'; end if;
  return new;
end $$;
create trigger allrice_quality_occurrence_immutable before update on allrice_automation_runs
  for each row execute function allrice_quality_occurrence_immutable();

create function allrice_quality_check_origin_immutable() returns trigger language plpgsql as $$
begin
  if new.automation_run_id is distinct from old.automation_run_id or
    (old.automation_run_id is not null and new.frozen is distinct from old.frozen)
  then raise exception 'quality check origin is immutable'; end if;
  return new;
end $$;
create trigger allrice_quality_check_origin_immutable before update on allrice_platform_quality_checks
  for each row execute function allrice_quality_check_origin_immutable();
