-- Brand reminders reuse the native clock and their existing deterministic
-- message sink. Control revision is an attempt index, not the business revision.
create table allrice_brand_native_reminder_targets (
  reminder_id uuid primary key references allrice_brand_content_reminders(id),
  automation_id uuid not null unique references allrice_automations(id),
  business_revision integer not null check(business_revision>0),
  attempt integer not null check(attempt between 1 and 8),
  partition_id text not null,
  control_id text not null,
  foreign key(partition_id,control_id,automation_id,attempt)
    references allrice_native_once_controls(partition_id,control_id,automation_id,revision)
);
create function allrice_brand_native_target_guard() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then raise exception 'brand native attempt history retained'; end if;
  if tg_op='UPDATE' then
    if (to_jsonb(new)-array['attempt','control_id']) is distinct from (to_jsonb(old)-array['attempt','control_id'])
      or new.attempt<>old.attempt+1 or new.control_id=old.control_id
      or not exists(select 1 from allrice_native_once_controls c join allrice_native_once_journal j
        on j.partition_id=c.partition_id and j.control_id=c.control_id
        where c.partition_id=old.partition_id and c.control_id=old.control_id and c.native_task_id is null
          and c.snapshot->'task'='null'::jsonb and c.snapshot->'control'->'command'->>'status'='blocked'
          and j.mutation->>'kind'='reject_command' and j.mutation->>'reason'='target_not_future'
          and j.mutation->>'commandId'=c.snapshot->'control'->'command'->>'id'
          and j.mutation->'absence'->>'controlSessionId'=c.control_session_id
          and j.mutation->'absence'->>'taskCount'='0'
          and j.after_snapshot=c.snapshot and not exists(select 1 from allrice_native_once_occurrences o
            where o.partition_id=c.partition_id and o.control_id=c.control_id)) then
      raise exception 'brand native attempt transition has no exact absence proof';
    end if;
  end if;
  if not exists(select 1 from allrice_native_once_controls c join allrice_brand_content_reminders r on r.id=new.reminder_id
    join allrice_automations a on a.id=r.automation_id and a.brand_content_binding=r.id
    where c.partition_id=new.partition_id and c.control_id=new.control_id and c.automation_id=new.automation_id
      and c.revision=new.attempt and a.id=new.automation_id and a.revision=new.business_revision
      and a.clock_owner='native_once' and r.state='registered'
      and c.immutable_control->'dispatch'->>'consumer'='brand-reminder-v1'
      and c.immutable_control->'dispatch'->>'reminderId'=r.id::text
      and (c.immutable_control->'dispatch'->>'businessRevision')::integer=new.business_revision
      and c.immutable_control->'dispatch'->>'businessOccurrenceId'=r.reserved_occurrence_id::text
      and c.immutable_control->'dispatch'->>'businessMessageId'=r.reserved_message_id::text) then
    raise exception 'brand native original target mismatch';
  end if;
  return new;
end $$;
create trigger brand_native_target_guard before insert or update or delete on allrice_brand_native_reminder_targets
  for each row execute function allrice_brand_native_target_guard();

-- Validate a complete deterministic business result at the same COMMIT clock as
-- the independent dispatcher lease. Ordinary Run/Job proof below is unchanged.
create function allrice_brand_native_delivery_proved(occurrence text) returns boolean language sql as $$
select exists(select 1 from allrice_native_once_occurrences o
  join allrice_brand_native_reminder_targets t on t.partition_id=o.partition_id and t.control_id=o.control_id and t.attempt=o.revision
  join allrice_native_once_controls c on c.partition_id=o.partition_id and c.control_id=o.control_id
  join allrice_brand_content_reminders r on r.id=t.reminder_id and r.automation_id=o.automation_id
  join allrice_automations a on a.id=r.automation_id and a.brand_content_binding=r.id and a.clock_owner='native_once'
  join allrice_automation_runs ar on ar.id=r.reserved_occurrence_id and ar.automation_id=r.automation_id and ar.native_once_occurrence_id=o.occurrence_id
  left join allrice_messages m on m.id=r.reserved_message_id
  where o.occurrence_id=occurrence and o.payload->'control'->'dispatch'=c.immutable_control->'dispatch'
    and c.native_task_id=o.payload->>'nativeTaskId' and o.payload->'control'->'dispatch'->>'consumer'='brand-reminder-v1'
    and o.payload->'control'->'dispatch'->>'reminderId'=r.id::text
    and o.payload->'control'->'dispatch'->>'businessOccurrenceId'=ar.id::text
    and o.payload->'control'->'dispatch'->>'businessMessageId'=r.reserved_message_id::text
    and (o.payload->'control'->'dispatch'->>'plannedAt')::timestamptz=r.scheduled_for
    and (o.payload->'control'->'dispatch'->>'businessRevision')::integer=t.business_revision
    and ar.scheduled_for=r.scheduled_for and ar.run_id is null and ar.session_id=r.session_id
    and ar.organization_id=r.organization_id and ar.workspace_id=r.workspace_id
    and o.outbox_owner_id is not null and o.outbox_epoch>0 and o.outbox_token_digest is not null and o.outbox_expires_at>clock_timestamp()
    and ((ar.status='succeeded' and r.state='reminded' and r.automation_run_id=ar.id and r.delivery_message_id=m.id
      and m.organization_id=r.organization_id and m.workspace_id=r.workspace_id and m.owner_id=r.owner_id and m.session_id=r.session_id
      and m.role='assistant' and m.visibility='private' and m.status='completed'
      and not exists(select 1 from allrice_employee_runs er where er.assistant_message_id=m.id or er.user_message_id=m.id)
      and m.client_message_id=r.reserved_message_id and m.completed_at is not null
      and o.outbox_state='enqueued' and o.business_binding=jsonb_build_object('consumer','brand-reminder-v1','reminderId',r.id::text,
        'automationRunId',ar.id::text,'messageId',m.id::text,'organizationId',r.organization_id::text,'workspaceId',r.workspace_id::text,
        'ownerId',r.owner_id::text,'sessionId',r.session_id::text,'payloadDigest',o.payload_digest))
      or (ar.status='failed' and r.state='blocked' and r.automation_run_id=ar.id and r.delivery_message_id is null
        and m.id is null and o.outbox_state='blocked' and o.business_binding is null)))
$$;
create function allrice_brand_native_occurrence_fence() returns trigger language plpgsql as $$
begin
  if new.native_once_occurrence_id is not null and exists(select 1 from allrice_automations a
    where a.id=new.automation_id and a.brand_content_binding is not null) and
    not allrice_brand_native_delivery_proved(new.native_once_occurrence_id) then
    raise exception 'native brand reminder business COMMIT proof lost' using errcode='P1921';
  end if;
  return new;
end $$;
create constraint trigger brand_native_occurrence_fence after insert on allrice_automation_runs
  deferrable initially deferred for each row execute function allrice_brand_native_occurrence_fence();

create or replace function allrice_native_once_dispatch_commit_fence() returns trigger language plpgsql as $$
begin
  if new.payload->'control'->'dispatch'->>'consumer'='brand-reminder-v1' then
    if old.outbox_state='pending' and new.outbox_state='enqueued' and
      not allrice_brand_native_delivery_proved(new.occurrence_id) then
      raise exception 'native brand reminder COMMIT proof lost' using errcode='P1921';
    end if;
    return new;
  end if;
  if old.outbox_state='pending' and new.outbox_state='enqueued' then
    if new.outbox_owner_id is null or new.outbox_epoch<1 or new.outbox_token_digest is null
      or new.outbox_expires_at<=clock_timestamp()
      or not exists(select 1 from allrice_native_once_occurrences o
        join allrice_automation_runs ar on ar.native_once_occurrence_id=o.occurrence_id and ar.automation_id=o.automation_id
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
      raise exception 'native once COMMIT dispatch fence lost' using errcode='P1921';
    end if;
  end if;
  return new;
end $$;
