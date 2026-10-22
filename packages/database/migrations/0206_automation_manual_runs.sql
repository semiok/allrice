-- A human manual request is independent of every native period/receipt. No
-- existing row is relabeled, and the native Task/clock tables are untouched.
alter table allrice_automation_runs
  add column manual_request_id uuid,
  add column manual_request_digest text,
  add column manual_revision bigint,
  add column manual_source text,
  add column manual_requested_at timestamptz;
alter table allrice_automation_runs add constraint automation_manual_shape check ((
  (manual_request_id is null and manual_request_digest is null and manual_revision is null
    and manual_source is null and manual_requested_at is null)
  or (manual_request_id is not null and manual_request_digest ~ '^sha256:[a-f0-9]{64}$'
    and manual_revision>0 and manual_source='user' and manual_requested_at is not null
    and scheduled_for=manual_requested_at and folder_event_id is null
    and native_once_occurrence_id is null and native_recurring_occurrence_id is null
    and native_root_origin is null and quality_occurrence is null and experience_occurrence is null)
) is true);
-- scheduled_for remains a non-null legacy storage column. On an explicitly
-- manual row it records requested_at, never P; it has no scheduling uniqueness.
drop index allrice_automation_scheduled_run_unique;
create unique index allrice_automation_scheduled_run_unique
  on allrice_automation_runs(automation_id,scheduled_for)
  where folder_event_id is null and manual_request_id is null;
create unique index allrice_automation_manual_request_unique
  on allrice_automation_runs(automation_id,manual_request_id)
  where manual_request_id is not null;

create function allrice_automation_manual_immutable() returns trigger language plpgsql as $$
begin
  if old.manual_request_id is null then
    if tg_op='UPDATE' and new.manual_request_id is not null then
      raise exception 'cannot relabel scheduled history as manual' using errcode='23514';
    end if;
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='DELETE' then
    raise exception 'manual automation history is immutable' using errcode='23514';
  end if;
  if (new.id,new.organization_id,new.workspace_id,new.automation_id,new.scheduled_for,new.created_at,
      new.manual_request_id,new.manual_request_digest,new.manual_revision,new.manual_source,new.manual_requested_at)
    is distinct from
     (old.id,old.organization_id,old.workspace_id,old.automation_id,old.scheduled_for,old.created_at,
      old.manual_request_id,old.manual_request_digest,old.manual_revision,old.manual_source,old.manual_requested_at)
    or (old.run_id is not null and new.run_id is distinct from old.run_id)
    or (old.session_id is not null and new.session_id is distinct from old.session_id) then
    raise exception 'manual automation identity is immutable' using errcode='23514';
  end if;
  return new;
end $$;
create trigger automation_manual_immutable before update or delete on allrice_automation_runs
  for each row execute function allrice_automation_manual_immutable();

-- Message, frozen employee, ordinary Run and Job must all commit together. This
-- INSERT fence does not revalidate old history after a later plan edit/delete.
create function allrice_automation_manual_commit_fence() returns trigger language plpgsql as $$
begin
  if new.manual_request_id is null then return new; end if;
  if not exists (
    select 1 from allrice_automation_runs ar
    join allrice_automations a on a.id=ar.automation_id and a.organization_id=ar.organization_id and a.workspace_id=ar.workspace_id
    join allrice_chat_sessions s on s.id=ar.session_id and s.organization_id=a.organization_id and s.workspace_id=a.workspace_id and s.owner_id=a.owner_id
    join allrice_runs r on r.id=ar.run_id and r.organization_id=a.organization_id and r.workspace_id=a.workspace_id and r.owner_id=a.owner_id
    join allrice_jobs j on j.run_id=r.id and j.organization_id=r.organization_id and j.workspace_id=r.workspace_id and j.owner_id=r.owner_id
    join allrice_employee_runs er on er.run_id=r.id and er.session_id=s.id and er.employee_assignment_id=a.employee_assignment_id
    join allrice_messages m on m.id=er.user_message_id and m.session_id=s.id and m.organization_id=a.organization_id and m.workspace_id=a.workspace_id and m.owner_id=a.owner_id
    where ar.id=new.id and ar.manual_source='user' and ar.manual_revision=a.revision
      and a.clock_owner in ('native_once','native_recurring') and a.trigger_type='schedule'
      and a.brand_content_binding is null and a.quality_binding is null and a.experience_binding is null
      and a.conversation_mode='reuse' and a.session_id=s.id and a.deleted_at is null
      and a.native_once_cancelled_at is null and s.archived_at is null
      and m.role='user' and m.client_message_id=ar.id
      and j.idempotency_key='employee-message:'||ar.id::text
      and j.payload->>'type'='allrice.employee.run'
  ) then
    raise exception 'manual automation business binding not committed' using errcode='23514';
  end if;
  return new;
end $$;
create constraint trigger automation_manual_commit_fence after insert on allrice_automation_runs
  deferrable initially deferred for each row execute function allrice_automation_manual_commit_fence();
