-- MET-223 A2. Deployment stops old writers before this one transaction.
-- Delete proved legacy records; never reinterpret them as current V2/A1 data.
-- Shared columns, current revisions/operations, knowledge and pgvector remain.
lock table allrice_memories, allrice_memory_revisions,
  allrice_employee_memory_operations, allrice_employee_runs,
  allrice_automations, allrice_automation_runs in share row exclusive mode;

-- 0236 left two independent technical receipts. A summary alone proves nothing.
create temporary table met223_pair_backfills on commit drop as
select r.memory_id, r.revision
from allrice_memory_revisions r
join allrice_memories m on m.id=r.memory_id and m.organization_id=r.organization_id
  and m.workspace_id=r.workspace_id
where r.reason='system:0236_employee_memory_pairs from revision '||(r.revision-1)
  and exists(select 1 from allrice_audit_events a
    where a.organization_id=m.organization_id and a.workspace_id=m.workspace_id
      and a.action='memory.migrate_pair' and a.resource_type='memory' and a.resource_id=m.id
      and a.actor_id is null and a.reason='system_backfill'
      and a.metadata->>'migration'='0236_employee_memory_pairs.sql'
      and a.metadata->'previousRevision'=to_jsonb(r.revision-1)
      and a.metadata->'revision'=to_jsonb(r.revision)
      and a.metadata->>'pairDigest'=allrice_native_control_document_digest(
        jsonb_build_object('version',2,'summary',r.summary,'details',r.details)));

-- V2 API receipts carry the exact pair/revision; legacy API receipts carried
-- content/contentDigest instead. Request hashes are not reversible provenance.
create temporary table met223_v2_memories on commit drop as
select distinct m.id from allrice_memories m
join allrice_employee_memory_operations op on op.memory_id=m.id
  and op.organization_id=m.organization_id and op.workspace_id=m.workspace_id
  and op.owner_id=m.owner_id and op.instance_id=m.instance_id
join allrice_memory_revisions r on r.memory_id=m.id
  and r.organization_id=m.organization_id and r.workspace_id=m.workspace_id
  and to_jsonb(r.revision)=op.response->'revision'
where op.operation in ('create','correct','promote')
  and op.response->>'id'=m.id::text and op.response->>'ownerId'=m.owner_id::text
  and op.response->>'instanceId'=m.instance_id::text
  and r.changed_by=m.owner_id and r.summary is not null
  and op.response->>'summary'=r.summary
  and op.response->'details'=coalesce(to_jsonb(r.details),'null'::jsonb)
  and op.response->>'pairDigest'=allrice_native_control_document_digest(
    jsonb_build_object('version',2,'summary',r.summary,'details',r.details))
  and not exists(select 1 from met223_pair_backfills b
    where b.memory_id=m.id and b.revision>=r.revision);

create temporary table met223_legacy_memories on commit drop as
select m.id from allrice_memories m
where not exists(select 1 from met223_v2_memories v where v.id=m.id)
  and (m.summary is null
    or exists(select 1 from allrice_experience_reviews e where e.memory_id=m.id)
    or exists(select 1 from allrice_brand_content_experiences b where b.memory_id=m.id)
    or exists(select 1 from met223_pair_backfills b where b.memory_id=m.id and b.revision=m.revision)
    or exists(select 1 from allrice_employee_memory_operations op
      where op.memory_id=m.id and op.organization_id=m.organization_id
        and op.workspace_id=m.workspace_id and op.owner_id=m.owner_id
        and op.response->>'id'=m.id::text and op.response->'revision'=to_jsonb(m.revision)
        and op.response ? 'contentDigest' and not (op.response ? 'pairDigest')));

do $$
declare item record;
begin
  -- One machine-readable line per retained identity, including re-confirmed
  -- backfills and unprovable summaries. No persistent retirement ledger.
  for item in select m.id, case
      when exists(select 1 from met223_v2_memories v where v.id=m.id)
        then 'v2_pair_receipt'
      else 'unproven_origin_or_later_revision' end as reason
    from allrice_memories m where not exists(select 1 from met223_legacy_memories l where l.id=m.id)
    order by m.id
  loop
    raise notice 'met223_memory_retained %',to_jsonb(item);
  end loop;
end $$;

create temporary table met223_legacy_automations on commit drop as
select id from allrice_automations where experience_binding is not null
union select automation_id from allrice_automation_runs where experience_occurrence is not null
  or experience_execution is not null or experience_receipt is not null
  or experience_validation_plan is not null or experience_adoption_plan is not null
union select automation_id from allrice_native_recurring_controls
  where immutable_identity->'dispatch'->>'consumer'='experience-consolidation-v1';
create temporary table met223_legacy_occurrences on commit drop as
select id,run_id from allrice_automation_runs
where experience_occurrence is not null or automation_id in (select id from met223_legacy_automations);
create temporary table met223_legacy_tests on commit drop as
select id,experience_run_id as run_id from allrice_platform_employee_test_runs
where purpose='experience_validation';
create temporary table met223_legacy_runs on commit drop as
select run_id as id from met223_legacy_occurrences where run_id is not null
union select run_id from met223_legacy_tests where run_id is not null
union select id from allrice_runs where execution_spec->>'handler'='allrice.experience.consolidate'
union select run_id from allrice_jobs where payload->>'type'='allrice.experience.consolidate'
union select run_id from allrice_employee_runs
  where memory_context_state->>'schemaVersion'='1'
    or jsonb_array_length(experience_reads)>0 or experience_action_receipt is not null
    -- V1-shaped identity-only task/preview transport is still current. Only
    -- an actual nonempty pre-V2 MEMORY body proves the retired projection.
    or (prompt_snapshot->'employeeDocuments'->>'schemaVersion' is distinct from '2'
      and jsonb_typeof(prompt_snapshot#>'{employeeDocuments,memory}')='string'
      and length(prompt_snapshot#>>'{employeeDocuments,memory}')>0)
    or coalesce(jsonb_array_length(prompt_snapshot->'memories'),0)>0;

-- Current A1 material and current V2 frozen Runs are not expendable history.
-- Shared incoming FKs remain authoritative and will also abort the transaction.
do $$
declare ids jsonb;
begin
  select jsonb_agg(r.id order by r.id) into ids
    from allrice_runs r join met223_legacy_runs l on l.id=r.id
    where r.state not in ('succeeded','failed','canceled','cancelled');
  if ids is not null then
    raise exception 'met223_retired_runs_require_stopped_terminal_state' using detail=ids::text;
  end if;
  if exists(select 1 from allrice_memory_sources s where s.run_id in (select id from met223_legacy_runs)
      or s.capture_run_id in (select id from met223_legacy_runs))
    or exists(select 1 from allrice_employee_runs r
      where r.memory_context_state->>'schemaVersion'='2' and r.run_id in (select id from met223_legacy_runs)) then
    raise exception 'met223_current_memory_run_dependency';
  end if;
  if exists(select 1 from allrice_memories m join allrice_employee_runs r
      on r.organization_id=m.organization_id and r.workspace_id=m.workspace_id
      and m.source_type='message' and m.source_id in (r.user_message_id,r.assistant_message_id)
    where r.run_id in (select id from met223_legacy_runs)
      and not exists(select 1 from met223_legacy_memories l where l.id=m.id)) then
    raise exception 'met223_retained_memory_source_run_dependency';
  end if;
end $$;

-- Only this exact platform source ID, or byte-identical tenant copies with
-- proved immutable provenance, is retired. A user's same-name Skill survives.
create temporary table met223_experience_skill_bodies on commit drop as
select name,checksum,content from allrice_platform_dsh_skills
where id='18300000-0002-4000-8000-000000000001' and source='allrice' and name='experience-consolidation'
union select s->>'name',s->>'checksum',s->>'content'
from allrice_employee_versions v
cross join lateral jsonb_array_elements(coalesce(v.manifest#>'{runtimePackage,skills}','[]'::jsonb)) s
where s->>'id'='18300000-0002-4000-8000-000000000001' and s->>'name'='experience-consolidation'
union select s->>'name',s->>'checksum',s->>'content'
from allrice_platform_employee_revisions v
cross join lateral jsonb_array_elements(coalesce(v.runtime_profile#>'{runtimePackage,skills}','[]'::jsonb)) s
where s->>'id'='18300000-0002-4000-8000-000000000001' and s->>'name'='experience-consolidation';
create temporary table met223_experience_tenant_skills on commit drop as
select s.id from allrice_dsh_skills s where exists(
  select 1 from met223_experience_skill_bodies b
  where b.name=s.name and b.checksum=s.checksum and b.content=s.content);
delete from allrice_employee_dsh_skill_bindings where skill_id in (select id from met223_experience_tenant_skills);
delete from allrice_dsh_skills where id in (select id from met223_experience_tenant_skills);
update allrice_platform_employee_revisions v set status='disabled'
where coalesce(v.definition#>'{capabilities,nativeSkillIds}','[]'::jsonb) ? '18300000-0002-4000-8000-000000000001'
  or exists(select 1 from jsonb_array_elements(coalesce(v.runtime_profile#>'{runtimePackage,skills}','[]'::jsonb)) s
    where s->>'id'='18300000-0002-4000-8000-000000000001');

-- Named history guards only, for rows selected above. Every FK and every
-- COMMIT/lease fence remains enabled. Restore all named guards below.
create temporary table met223_history_guards(relation_name text,trigger_name text) on commit drop;
insert into met223_history_guards values
 ('allrice_platform_skill_bundle_versions','allrice_skill_bundle_immutable'),
 ('allrice_employee_runs','allrice_employee_runs_no_delete'),
 ('allrice_employee_run_steps','allrice_employee_run_steps_no_delete'),
 ('allrice_subscription_usage_budget_reviews','allrice_usage_budget_review_immutable'),
 ('allrice_route_subscription_snapshots','allrice_route_subscription_snapshots_immutable'),
 ('allrice_native_context_retirements','allrice_native_context_retirement_immutable'),
 ('allrice_native_calendar_retirements','native_calendar_retirement_immutable'),
 ('allrice_native_calendar_retirement_intents','native_calendar_retirement_intent_immutable'),
 ('allrice_native_calendar_decisions','native_calendar_decision_immutable'),
 ('allrice_native_calendar_arms','native_calendar_arm_no_delete'),
 ('allrice_native_calendar_periods','native_calendar_period_no_delete'),
 ('allrice_native_calendar_plans','native_calendar_plan_no_delete'),
 ('allrice_native_recurring_journal','native_recurring_journal_immutable'),
 ('allrice_native_recurring_occurrences','native_recurring_occurrence_no_delete'),
 ('allrice_native_recurring_controls','native_recurring_control_no_delete'),
 ('allrice_native_recurring_versions','native_recurring_versions_immutable'),
 ('allrice_native_recurring_operations','native_recurring_operation_no_delete');
do $$
declare g record;
begin
  for g in select * from met223_history_guards loop
    if not exists(select 1 from pg_trigger where tgrelid=g.relation_name::regclass
      and tgname=g.trigger_name and not tgisinternal and tgenabled='O') then
      raise exception 'met223_expected_history_guard_missing: %.%',g.relation_name,g.trigger_name;
    end if;
    execute format('alter table %I disable trigger %I',g.relation_name,g.trigger_name);
  end loop;
end $$;

delete from allrice_platform_skill_bundle_versions where skill_id='18300000-0002-4000-8000-000000000001';
delete from allrice_platform_dsh_skills where id='18300000-0002-4000-8000-000000000001';

-- Drop leaf objects first. Unknown/shared incoming references fail naturally.
drop function allrice_employee_memory_pair_preflight();
drop table allrice_brand_content_experience_uses;
drop table allrice_brand_content_experiences;
drop table allrice_experience_coverage_reassessments;
drop table allrice_experience_reviews;
drop table allrice_rag_chunks;
delete from allrice_employee_memory_operations where memory_id in (select id from met223_legacy_memories);
delete from allrice_memory_revisions where memory_id in (select id from met223_legacy_memories);
delete from allrice_audit_events where resource_type='memory' and resource_id in (select id from met223_legacy_memories);
delete from allrice_memories where id in (select id from met223_legacy_memories);

-- Dedicated experience Calendar rows only. The shared partition, native Task
-- namespace, ordinary monthly parents, versions, proofs and journals survive.
delete from allrice_native_calendar_retirements where control_id in (
  select control_id from allrice_native_recurring_controls where automation_id in (select id from met223_legacy_automations));
delete from allrice_native_calendar_retirement_intents where arm_id in (
  select arm_id from allrice_native_calendar_arms a join allrice_native_calendar_periods p using(period_id)
  where p.automation_id in (select id from met223_legacy_automations));
delete from allrice_native_calendar_decisions where period_id in (
  select period_id from allrice_native_calendar_plans where automation_id in (select id from met223_legacy_automations));
delete from allrice_platform_employee_test_runs where id in (select id from met223_legacy_tests);
delete from allrice_automation_runs where id in (select id from met223_legacy_occurrences);
delete from allrice_native_recurring_journal where control_id in (
  select control_id from allrice_native_recurring_controls where automation_id in (select id from met223_legacy_automations));
delete from allrice_native_recurring_occurrences where automation_id in (select id from met223_legacy_automations);
delete from allrice_native_calendar_arms where period_id in (
  select period_id from allrice_native_calendar_periods where automation_id in (select id from met223_legacy_automations));
delete from allrice_native_calendar_periods where automation_id in (select id from met223_legacy_automations);
delete from allrice_native_calendar_plans where automation_id in (select id from met223_legacy_automations);
delete from allrice_native_recurring_controls where automation_id in (select id from met223_legacy_automations);
delete from allrice_native_recurring_versions where automation_id in (select id from met223_legacy_automations);
delete from allrice_native_recurring_operations where automation_id in (select id from met223_legacy_automations);
delete from allrice_automations where id in (select id from met223_legacy_automations);
delete from allrice_settings where key='employee_experience_policy' and scope_type in ('system','organization');

-- Core evidence owned solely by a retired Run. Other business/artifact FKs
-- deliberately block cleanup rather than recursively deleting current content.
delete from allrice_native_context_retirements where context_kind='experience_consolidation';
delete from allrice_native_session_bindings where context_kind='experience_consolidation';
delete from allrice_conversation_commands where followup_run_id in (select id from met223_legacy_runs);
delete from allrice_conversation_followups where run_id in (select id from met223_legacy_runs);
delete from allrice_native_questions where source_run_id in (select id from met223_legacy_runs);
delete from allrice_run_feedback where run_id in (select id from met223_legacy_runs);
delete from allrice_employee_run_steps where run_id in (select id from met223_legacy_runs);
delete from allrice_employee_runs where run_id in (select id from met223_legacy_runs);
delete from allrice_subscription_usage_budget_reviews where route_decision_id in (
  select id from allrice_route_decisions where run_id in (select id from met223_legacy_runs));
delete from allrice_route_subscription_snapshots where route_decision_id in (
  select id from allrice_route_decisions where run_id in (select id from met223_legacy_runs));
delete from allrice_model_usage_ledger where route_decision_id in (
  select id from allrice_route_decisions where run_id in (select id from met223_legacy_runs));
delete from allrice_route_decisions where run_id in (select id from met223_legacy_runs);
delete from allrice_run_events where run_id in (select id from met223_legacy_runs);
delete from allrice_jobs where run_id in (select id from met223_legacy_runs);
delete from allrice_runs where id in (select id from met223_legacy_runs);

do $$
declare g record;
begin
  for g in select * from met223_history_guards loop
    execute format('alter table %I enable trigger %I',g.relation_name,g.trigger_name);
  end loop;
end $$;

-- Stop old writers from creating new records in the retained shared columns.
alter table allrice_employee_runs alter column memory_context_state drop default;
alter table allrice_platform_employee_test_runs
  drop constraint allrice_platform_employee_test_runs_purpose_check,
  add constraint allrice_platform_employee_test_runs_purpose_check check(purpose='platform_preview');
alter table allrice_automations
  drop constraint allrice_experience_automation_config,
  add constraint allrice_experience_automation_config check(experience_binding is null);
alter table allrice_automation_runs add constraint allrice_retired_experience_occurrence
  check(experience_occurrence is null and experience_execution is null and experience_receipt is null
    and experience_validation_plan is null and experience_adoption_plan is null);
drop trigger allrice_experience_occurrence_immutable on allrice_automation_runs;
drop trigger allrice_experience_validation_plan_guard on allrice_automation_runs;
drop trigger allrice_experience_validation_guard on allrice_platform_employee_test_runs;
drop trigger experience_calendar_clock_fence on allrice_automations;
drop function allrice_experience_origin_immutable();
drop function allrice_experience_source_reservation_immutable();
drop function allrice_experience_reassessment_immutable();
drop function allrice_experience_occurrence_immutable();
drop function allrice_experience_validation_plan_immutable();
drop function allrice_experience_validation_immutable();

-- These entry points also protect ordinary monthly. Replace only the removed
-- consumer branches; keep the original business, journal and lease proof calls.
create or replace function allrice_native_calendar_control_valid(c jsonb) returns boolean language sql immutable as $$
select case c->'dispatch'->>'consumer'
  when 'ordinary-monthly-v1' then allrice_ordinary_monthly_control_valid(c)
  else false end
$$;
create or replace function allrice_native_calendar_revision_valid(v jsonb) returns boolean language sql stable as $$
select case v->>'consumer'
  when 'ordinary-monthly-v1' then allrice_ordinary_monthly_revision_valid(v)
  else false end
$$;
create or replace function allrice_native_calendar_plan_proved(id uuid) returns boolean language sql as $$
select allrice_ordinary_monthly_plan_proved(id)
$$;
create or replace function allrice_native_calendar_business_handoff_proved(occurrence uuid) returns boolean language sql as $$
select allrice_ordinary_monthly_handoff_proved(occurrence)
$$;
create or replace function allrice_native_calendar_decision_fence() returns trigger language plpgsql as $$
begin
  if allrice_ordinary_monthly_decision_proved(new.decision_id) is not true then
    raise exception 'ordinary monthly decision lacks exact original business/lease/operation proof' using errcode='P1921';
  end if;
  return new;
end $$;
create or replace function allrice_native_calendar_no_business_run() returns trigger language plpgsql as $$
begin
  if new.native_recurring_occurrence_id is not null and exists(select 1 from allrice_native_recurring_occurrences o
    where o.occurrence_id=new.native_recurring_occurrence_id and o.calendar_period_id is not null) then
    if allrice_ordinary_monthly_handoff_proved(new.native_recurring_occurrence_id) is not true then
      raise exception 'ordinary monthly Run lacks exact frozen original chat handoff' using errcode='P1921';
    end if;
    if tg_op='INSERT' and (new.status<>'queued' or not allrice_ordinary_monthly_authorized(new.automation_id)
      or not exists(select 1 from allrice_native_recurring_occurrences o
        where o.occurrence_id=new.native_recurring_occurrence_id and o.outbox_owner_id is not null
          and o.outbox_epoch>0 and o.outbox_token_digest is not null and o.outbox_expires_at>clock_timestamp())) then
      raise exception 'ordinary monthly Run birth COMMIT authority/lease lost' using errcode='P1921';
    end if;
  end if;
  return new;
end $$;

-- 0207 made the experience-named trigger a shared monthly dispatch fence.
-- Rename its generic responsibility; never drop this protection outright.
drop trigger experience_calendar_dispatch_fence on allrice_native_recurring_occurrences;
create function allrice_native_calendar_dispatch_fence() returns trigger language plpgsql as $$
begin
  if new.outbox_state='enqueued' and (new.outbox_owner_id is null or new.outbox_epoch<1
    or new.outbox_token_digest is null or new.outbox_expires_at<=clock_timestamp()
    or not allrice_native_calendar_business_handoff_proved(new.occurrence_id)) then
    raise exception 'calendar explicit consumer dispatch COMMIT proof lost' using errcode='P1921';
  end if;
  return new;
end $$;
create constraint trigger native_calendar_dispatch_fence after update on allrice_native_recurring_occurrences
  deferrable initially deferred for each row when (new.calendar_period_id is not null)
  execute function allrice_native_calendar_dispatch_fence();

create or replace function allrice_native_calendar_period_plan_fence() returns trigger language plpgsql as $$
begin
  if exists(select 1 from allrice_automations a where a.id=new.automation_id and a.clock_owner='native_recurring'
    and exists(select 1 from allrice_native_recurring_controls c
      where c.automation_id=a.id and c.immutable_identity->'dispatch'->>'consumer'='ordinary-monthly-v1')) and not exists(select 1 from allrice_native_calendar_plans p
      where p.period_id=new.plan_id and p.period_id=new.period_id and p.partition_id=new.partition_id and p.control_id=new.control_id
        and p.automation_id=new.automation_id and p.revision=new.revision and p.business_scheduled_for=new.business_scheduled_for
        and p.closed_decision_id is not distinct from new.business_decision_id) then
    raise exception 'calendar native period lacks exact business plan' using errcode='23514';
  end if;
  return new;
end $$;

drop function allrice_experience_calendar_dispatch_fence();
drop function allrice_experience_calendar_clock_fence();
drop function allrice_experience_calendar_clock_proved(uuid);
drop function allrice_experience_calendar_plan_proved(uuid);
drop function allrice_experience_calendar_handoff_proved(uuid);
drop function allrice_experience_calendar_control_valid(jsonb);
drop function allrice_experience_calendar_revision_valid(jsonb);

alter table allrice_automations drop constraint native_recurring_request_shape;
alter table allrice_automations add constraint native_recurring_request_shape check ((
  (clock_owner<>'native_recurring' and native_recurring_request_id is null and native_recurring_request_digest is null
    and native_recurring_revision is null and native_recurring_resume_after is null)
  or (clock_owner='native_recurring' and trigger_type='schedule' and employee_assignment_id is not null
    and native_recurring_request_id is not null and native_recurring_request_digest ~ '^sha256:[a-f0-9]{64}$'
    and native_recurring_revision between 1 and revision and (
      (quality_binding is null and schedule->>'frequency'='native_recurring' and (conversation_mode='reuse' or (conversation_mode='new_each_run' and brand_content_binding is null and experience_binding is null)) and session_id is not null)
      or (quality_binding='{"version":1,"caseId":"project.static.v1","variant":"correct"}'::jsonb
        and schedule->>'frequency'='daily' and schedule->>'timezone'='Asia/Shanghai'
        and conversation_mode='new_each_run' and session_id is null and native_recurring_request_id=id)

    ))) is true);
