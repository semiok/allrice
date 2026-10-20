-- MET194 P5: one deterministic private-session message, clocked exclusively
-- by the existing Automation once scanner. No model, Run or external post.
alter table allrice_brand_content_plans add column reminder_message_id uuid,
  add foreign key(organization_id,workspace_id,reminder_message_id)
    references allrice_messages(organization_id,workspace_id,id);

create table allrice_brand_content_reminders (
  id uuid primary key,
  organization_id uuid not null, workspace_id uuid not null,
  owner_id uuid not null, instance_id uuid not null, assignment_id uuid not null,
  brand_id uuid not null, plan_id uuid not null, plan_revision integer not null check(plan_revision>0),
  article_id uuid not null, bundle_id uuid not null, review_id uuid not null,
  bundle_digest text not null check(bundle_digest ~ '^sha256:[a-f0-9]{64}$'),
  session_id uuid not null,
  workflow_revision_id uuid not null,
  package_digest text not null check(package_digest ~ '^sha256:[a-f0-9]{64}$'),
  automation_id uuid not null unique references allrice_automations(id),
  scheduled_for timestamptz not null,
  request_id text not null check(length(request_id) between 1 and 200),
  request_digest text not null check(request_digest ~ '^sha256:[a-f0-9]{64}$'),
  authority text not null check(authority in ('user','workflow')),
  reserved_occurrence_id uuid not null unique,
  reserved_message_id uuid not null unique,
  state text not null default 'registered' check(state in ('registered','reminded','blocked','superseded')),
  automation_run_id uuid unique references allrice_automation_runs(id),
  delivery_message_id uuid unique,
  delivery_content_digest text check(delivery_content_digest is null or delivery_content_digest ~ '^sha256:[a-f0-9]{64}$'),
  error_code text,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  foreign key(organization_id,workspace_id,owner_id,assignment_id,instance_id)
    references allrice_employee_instances(organization_id,workspace_id,owner_id,assignment_id,id),
  foreign key(organization_id,workspace_id,owner_id,instance_id,brand_id,plan_id)
    references allrice_brand_content_plans(organization_id,workspace_id,owner_id,instance_id,brand_id,id),
  foreign key(organization_id,workspace_id,owner_id,instance_id,brand_id,article_id,bundle_id)
    references allrice_brand_content_bundles(organization_id,workspace_id,owner_id,instance_id,brand_id,article_id,id),
  foreign key(organization_id,workspace_id,owner_id,instance_id,brand_id,article_id,review_id)
    references allrice_brand_content_reviews(organization_id,workspace_id,owner_id,instance_id,brand_id,article_id,id),
  foreign key(organization_id,workspace_id,session_id)
    references allrice_chat_sessions(organization_id,workspace_id,id),
  foreign key(organization_id,workspace_id,workflow_revision_id)
    references allrice_workflow_packages(organization_id,workspace_id,workflow_revision_id),
  foreign key(organization_id,workspace_id,delivery_message_id)
    references allrice_messages(organization_id,workspace_id,id),
  unique(organization_id,workspace_id,owner_id,instance_id,request_id),
  check(automation_run_id is null or automation_run_id=reserved_occurrence_id),
  check(delivery_message_id is null or delivery_message_id=reserved_message_id),
  check(
    (state='registered' and automation_run_id is null and delivery_message_id is null and delivery_content_digest is null and completed_at is null and error_code is null)
    or (state='reminded' and automation_run_id is not null and delivery_message_id is not null and delivery_content_digest is not null and completed_at is not null and error_code is null)
    or (state='blocked' and automation_run_id is not null and delivery_message_id is null and delivery_content_digest is null and completed_at is not null and error_code is not null)
    or (state='superseded' and automation_run_id is null and delivery_message_id is null and delivery_content_digest is null and completed_at is not null and error_code is not null)
  )
);
create index allrice_brand_content_reminder_plan
  on allrice_brand_content_reminders(plan_id,created_at,id);

alter table allrice_automations add column brand_content_binding uuid,
  add foreign key(brand_content_binding) references allrice_brand_content_reminders(id)
    deferrable initially deferred,
  add constraint allrice_brand_content_automation_type check(
    brand_content_binding is null or
    (trigger_type='schedule' and schedule->>'frequency'='once'
      and conversation_mode='reuse' and employee_assignment_id is not null and session_id is not null
      and quality_binding is null and experience_binding is null)
  );

create function allrice_brand_content_reminder_fixed() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then raise exception 'brand reminder history is immutable'; end if;
  if old.state<>'registered' or
    (to_jsonb(new)-array['state','automation_run_id','delivery_message_id','delivery_content_digest','error_code','completed_at'])
      is distinct from
    (to_jsonb(old)-array['state','automation_run_id','delivery_message_id','delivery_content_digest','error_code','completed_at']) then
    raise exception 'brand reminder binding and terminal receipt are immutable';
  end if;
  return new;
end $$;
create trigger allrice_brand_content_reminder_fixed
  before update or delete on allrice_brand_content_reminders
  for each row execute function allrice_brand_content_reminder_fixed();

create function allrice_brand_content_automation_fixed() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    if old.brand_content_binding is not null then raise exception 'brand reminder Automation history is retained'; end if;
    return old;
  end if;
  if old.brand_content_binding is not null and
    (new.organization_id,new.workspace_id,new.owner_id,new.name,new.description,new.prompt,new.trigger_type,new.schedule,
     new.conversation_mode,new.employee_assignment_id,new.session_id,new.brand_content_binding)
    is distinct from
    (old.organization_id,old.workspace_id,old.owner_id,old.name,old.description,old.prompt,old.trigger_type,old.schedule,
     old.conversation_mode,old.employee_assignment_id,old.session_id,old.brand_content_binding) then
    raise exception 'brand reminder Automation configuration is immutable';
  end if;
  return new;
end $$;
create trigger allrice_brand_content_automation_fixed
  before update or delete on allrice_automations
  for each row execute function allrice_brand_content_automation_fixed();
