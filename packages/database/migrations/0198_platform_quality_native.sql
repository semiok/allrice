-- Platform daily QA keeps its existing private rule/occurrence/check IDs. Only
-- ownership of the clock changes; ordinary chat and once shapes remain intact.
alter table allrice_automations drop constraint native_recurring_request_shape;
alter table allrice_automations add constraint native_recurring_request_shape check ((
  (clock_owner<>'native_recurring' and native_recurring_request_id is null and native_recurring_request_digest is null
    and native_recurring_revision is null and native_recurring_resume_after is null)
  or (clock_owner='native_recurring' and trigger_type='schedule' and employee_assignment_id is not null
    and native_recurring_request_id is not null and native_recurring_request_digest ~ '^sha256:[a-f0-9]{64}$'
    and native_recurring_revision between 1 and revision and (
      (quality_binding is null and schedule->>'frequency'='native_recurring' and conversation_mode='reuse' and session_id is not null)
      or (quality_binding='{"version":1,"caseId":"project.static.v1","variant":"correct"}'::jsonb
        and schedule->>'frequency'='daily' and schedule->>'timezone'='Asia/Shanghai'
        and conversation_mode='new_each_run' and session_id is null and native_recurring_request_id=id)
    ))) is true);

-- Immutable delivery to the original business queue. It intentionally outlives
-- the dispatch lease and later configuration edits; current authority is checked
-- again by the original quality enqueue/claim path. No fake Run or login is used.
create function allrice_quality_native_handoff_proved(occurrence uuid) returns boolean language sql as $$
select exists(select 1 from allrice_native_recurring_occurrences o
  join allrice_native_recurring_controls c on c.partition_id=o.partition_id and c.control_id=o.control_id and c.automation_id=o.automation_id
  join allrice_native_recurring_versions v on v.automation_id=o.automation_id and v.revision=o.revision
  join allrice_automations a on a.id=o.automation_id and a.clock_owner='native_recurring'
  join allrice_automation_runs ar on ar.native_recurring_occurrence_id=o.occurrence_id and ar.automation_id=o.automation_id
  where o.occurrence_id=occurrence and o.payload->'control'=c.immutable_identity
    and c.immutable_identity->'dispatch'='{"consumer":"platform-quality-v1"}'::jsonb
    and c.native_task_id=o.payload->>'nativeTaskId'
    and v.configuration->>'consumer'='platform-quality-v1'
    and v.configuration->'rule'->>'kind'='daily' and v.configuration->'rule'->>'timezone'='Asia/Shanghai'
    and o.payload->'revision'=jsonb_build_object('revision',v.revision,'rule',v.configuration->'rule',
      'reservationDigest',v.configuration->>'reservationDigest','acceptedAt',v.configuration->>'acceptedAt')
    and a.quality_binding='{"version":1,"caseId":"project.static.v1","variant":"correct"}'::jsonb
    and a.organization_id::text=c.immutable_identity->>'organizationId'
    and a.workspace_id::text=c.immutable_identity->>'workspaceId' and a.owner_id::text=c.immutable_identity->>'ownerId'
    and ar.organization_id=a.organization_id and ar.workspace_id=a.workspace_id and ar.scheduled_for=o.scheduled_at
    and ar.quality_occurrence=jsonb_build_object('version',1,'caseId','project.static.v1','variant','correct',
      'automationId',a.id::text,'occurrenceId',ar.id::text,'revision',v.revision,'ownerId',a.owner_id::text,
      'organizationId',a.organization_id::text,'workspaceId',a.workspace_id::text,
      'scheduledFor',o.payload->'receipt'->>'scheduledAt','dispatchDeadlineAt',ar.quality_occurrence->>'dispatchDeadlineAt',
      'configurationDigest',v.configuration->>'qualityConfigurationDigest')
    and (ar.quality_occurrence->>'dispatchDeadlineAt')::timestamptz=o.scheduled_at+interval '15 minutes'
    and ((o.outbox_state='enqueued' and o.business_binding=jsonb_build_object(
      'consumer','platform-quality-v1','automationRunId',ar.id::text,'organizationId',a.organization_id::text,
      'workspaceId',a.workspace_id::text,'ownerId',a.owner_id::text,'payloadDigest',o.payload_digest,'origin',ar.quality_occurrence))
      or (o.outbox_state='blocked' and o.business_binding is null and ar.status='failed' and ar.run_id is null
        and ar.session_id is null and ar.completed_at is not null and ar.error_code=o.outbox_reason)))
$$;

-- Covers both delivered and explicitly skipped occurrences. A lease that expires
-- at COMMIT rolls back both records, so the same receipt can be recovered safely.
create function allrice_quality_native_occurrence_fence() returns trigger language plpgsql as $$
begin
  if new.quality_occurrence is not null and new.native_recurring_occurrence_id is not null and (
    not allrice_quality_native_handoff_proved(new.native_recurring_occurrence_id) or
    not exists(select 1 from allrice_native_recurring_occurrences o where o.occurrence_id=new.native_recurring_occurrence_id
      and o.outbox_owner_id is not null and o.outbox_epoch>0 and o.outbox_token_digest is not null
      and o.outbox_expires_at>clock_timestamp())) then
    raise exception 'native quality business COMMIT proof lost' using errcode='P1921';
  end if;
  return new;
end $$;
create constraint trigger quality_native_occurrence_fence after insert on allrice_automation_runs
  deferrable initially deferred for each row execute function allrice_quality_native_occurrence_fence();

-- Freeze native provenance even while the original quality Run is bound later.
create function allrice_quality_native_origin_guard() returns trigger language plpgsql as $$
begin
  if old.quality_occurrence is not null and new.native_recurring_occurrence_id is distinct from old.native_recurring_occurrence_id then
    raise exception 'quality native provenance is immutable';
  end if;
  return new;
end $$;
create trigger quality_native_origin_guard before update on allrice_automation_runs
  for each row execute function allrice_quality_native_origin_guard();

create or replace function allrice_native_recurring_dispatch_commit_fence() returns trigger language plpgsql as $$
begin
  if new.payload->'control'->'dispatch'->>'consumer'='platform-quality-v1' then
    if old.outbox_state='pending' and new.outbox_state='enqueued' and
      (new.outbox_owner_id is null or new.outbox_epoch<1 or new.outbox_token_digest is null
       or new.outbox_expires_at<=clock_timestamp()
       or not allrice_quality_native_handoff_proved(new.occurrence_id)) then
      raise exception 'native quality COMMIT dispatch fence lost' using errcode='P1921';
    end if;
    return new;
  end if;
  if old.outbox_state='pending' and new.outbox_state='enqueued' then
    if new.outbox_owner_id is null or new.outbox_epoch<1 or new.outbox_token_digest is null
      or new.outbox_expires_at<=clock_timestamp()
      or not exists(select 1 from allrice_native_recurring_occurrences o
        join allrice_automation_runs ar on ar.native_recurring_occurrence_id=o.occurrence_id and ar.automation_id=o.automation_id
        join allrice_jobs j on j.run_id=ar.run_id
        join allrice_employee_runs er on er.run_id=j.run_id and er.session_id=ar.session_id
        where o.occurrence_id=new.occurrence_id and o.outbox_state='enqueued'
          and o.outbox_owner_id=new.outbox_owner_id and o.outbox_epoch=new.outbox_epoch
          and o.outbox_token_digest=new.outbox_token_digest and o.business_binding=new.business_binding
          and j.id::text=new.business_binding->>'jobId' and j.run_id::text=new.business_binding->>'runId'
          and j.organization_id::text=new.business_binding->>'organizationId'
          and j.workspace_id::text=new.business_binding->>'workspaceId' and j.owner_id::text=new.business_binding->>'ownerId'
          and er.session_id::text=new.business_binding->>'sessionId'
          and er.user_message_id::text=new.business_binding->>'userMessageId'
          and er.assistant_message_id::text=new.business_binding->>'assistantMessageId') then
      raise exception 'native recurring COMMIT dispatch fence lost' using errcode='P1921';
    end if;
  end if;
  return new;
end $$;
