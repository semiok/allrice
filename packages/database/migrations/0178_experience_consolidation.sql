-- Private experience work reuses Automation/Run/Job and the existing source reviews.
alter table allrice_route_subscription_snapshots
  drop constraint allrice_route_subscription_snapshots_snapshot_check1;
alter table allrice_route_subscription_snapshots add constraint allrice_route_subscription_identity_check check (
  snapshot @> '{"billingMode":"subscription","harness":"dsh","provider":"openai-codex","authMode":"chatgpt_subscription","baseUrl":null}'::jsonb
  and (
    snapshot->>'version'='1'
    or (snapshot->>'version'='2' and snapshot->'sessionId'='null'::jsonb
      and jsonb_typeof(snapshot->'occurrenceId')='string')
  )
);
alter table allrice_automations add column experience_binding jsonb;
alter table allrice_automations add constraint allrice_experience_automation_config check (
  experience_binding is null or (
    jsonb_typeof(experience_binding)='object' and quality_binding is null
    and trigger_type='schedule' and conversation_mode='new_each_run'
    and employee_assignment_id is not null and session_id is null
  )
);
create unique index allrice_experience_automation_instance on allrice_automations
  (organization_id,workspace_id,owner_id,(experience_binding->>'instanceId'))
  where experience_binding is not null and deleted_at is null;
alter table allrice_automation_runs
  add column experience_occurrence jsonb,
  add column experience_execution jsonb,
  add column experience_receipt jsonb;
alter table allrice_automation_runs add check (
  experience_occurrence is null or (
    jsonb_typeof(experience_occurrence)='object' and session_id is null
    and folder_event_id is null and quality_occurrence is null
  )
);
alter table allrice_automation_runs add check (
  (experience_execution is null and experience_receipt is null)
  or experience_occurrence is not null
);
create index allrice_experience_dispatch_pending on allrice_automation_runs(created_at,id)
  where experience_occurrence is not null and run_id is null and status='queued';
alter table allrice_experience_reviews
  add column consolidation_occurrence_id uuid references allrice_automation_runs(id),
  add column consolidated_at timestamptz;
alter table allrice_experience_reviews add check
  (consolidation_occurrence_id is null or origin_kind='incremental');
create index allrice_experience_unprocessed on allrice_experience_reviews
  (organization_id,workspace_id,owner_id,instance_id,created_at,memory_id)
  where origin_kind='incremental' and consolidation_occurrence_id is null;

-- Keep the original source and completed reviews immutable. Only the two
-- monotonic consolidation progress fields extend the existing update allowlist.
create or replace function allrice_experience_origin_immutable() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' or
    (to_jsonb(new)-array['status','reviewed_by','reviewed_at','review_reason','consolidation_occurrence_id','consolidated_at'])
      is distinct from
    (to_jsonb(old)-array['status','reviewed_by','reviewed_at','review_reason','consolidation_occurrence_id','consolidated_at'])
    or old.status<>'pending'
  then raise exception 'experience origin and completed reviews are immutable'; end if;
  if (new.consolidation_occurrence_id is distinct from old.consolidation_occurrence_id or
      new.consolidated_at is distinct from old.consolidated_at) and
      (old.origin_kind<>'incremental' or
       (new.consolidated_at is not null and new.consolidation_occurrence_id is null) or
       (old.consolidated_at is not null and new.consolidated_at is distinct from old.consolidated_at))
  then raise exception 'experience consolidation progress is immutable'; end if;
  return new;
end $$;

create function allrice_experience_occurrence_immutable() returns trigger language plpgsql as $$
begin
  if old.experience_occurrence is not null and (
    new.experience_occurrence is distinct from old.experience_occurrence or
    new.id is distinct from old.id or new.automation_id is distinct from old.automation_id or
    new.organization_id is distinct from old.organization_id or new.workspace_id is distinct from old.workspace_id or
    new.scheduled_for is distinct from old.scheduled_for or
    (old.run_id is not null and new.run_id is distinct from old.run_id) or
    (old.experience_execution is not null and new.experience_execution is distinct from old.experience_execution) or
    (old.experience_receipt is not null and new.experience_receipt is distinct from old.experience_receipt)
  ) then raise exception 'experience occurrence is immutable'; end if;
  return new;
end $$;
create trigger allrice_experience_occurrence_immutable before update on allrice_automation_runs
  for each row execute function allrice_experience_occurrence_immutable();
create function allrice_experience_source_reservation_immutable() returns trigger language plpgsql as $$
begin
  if old.consolidation_occurrence_id is not null and
    new.consolidation_occurrence_id is distinct from old.consolidation_occurrence_id
  then raise exception 'experience source reservation is immutable'; end if;
  return new;
end $$;
create trigger allrice_experience_source_reservation_immutable before update on allrice_experience_reviews
  for each row execute function allrice_experience_source_reservation_immutable();
