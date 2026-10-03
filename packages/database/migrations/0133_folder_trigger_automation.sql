-- Folder events reuse the existing Automation, Bridge file command and Run queue.
alter table allrice_automations drop constraint allrice_automations_trigger_type_check;
alter table allrice_automations add constraint allrice_automations_trigger_type_check check(trigger_type in ('schedule','folder'));
alter table allrice_automations alter column schedule drop not null;
alter table allrice_automations add column folder jsonb;
alter table allrice_automations add column revision integer not null default 1 check(revision>0);
alter table allrice_automations add column deleted_at timestamptz;
alter table allrice_automations add constraint allrice_automations_trigger_config_check check(
  (trigger_type='schedule' and schedule is not null and folder is null) or
  (trigger_type='folder' and schedule is null and folder is not null and employee_assignment_id is not null and conversation_mode='new_each_run' and next_run_at is null)
);
create table allrice_automation_folder_events(
  id uuid primary key,
  organization_id uuid not null,workspace_id uuid not null,owner_id uuid not null references allrice_users(id),
  automation_id uuid not null,revision integer not null check(revision>0),device_id uuid not null,
  folder_grant_id uuid not null,folder_grant_version integer not null,
  path text not null,expected jsonb not null,request_digest text not null,
  observed_at timestamptz not null,reserved_session_id uuid not null,
  session_id uuid,command_id uuid,object_id uuid,run_id uuid,
  state text not null default 'received' check(state in ('received','import_pending','queued','blocked')),
  error_code text,error_message text,
  recovery_lease_until timestamptz,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  unique(organization_id,workspace_id,id),
  foreign key(organization_id,workspace_id,automation_id) references allrice_automations(organization_id,workspace_id,id),
  foreign key(organization_id,workspace_id,session_id) references allrice_chat_sessions(organization_id,workspace_id,id),
  foreign key(organization_id,workspace_id,run_id) references allrice_runs(organization_id,workspace_id,id)
);
create unique index allrice_folder_event_version_unique on allrice_automation_folder_events(device_id,automation_id,revision,path,(expected->>'version'),(expected->>'checksum'));
create index allrice_folder_event_recovery on allrice_automation_folder_events(state,created_at) where state in ('received','import_pending');
alter table allrice_automation_runs add column folder_event_id uuid references allrice_automation_folder_events(id);
alter table allrice_automation_runs drop constraint allrice_automation_runs_automation_id_scheduled_for_key;
create unique index allrice_automation_scheduled_run_unique on allrice_automation_runs(automation_id,scheduled_for) where folder_event_id is null;
create unique index allrice_automation_folder_run_unique on allrice_automation_runs(folder_event_id) where folder_event_id is not null;
alter table allrice_bridge_commands add column folder_event_id uuid references allrice_automation_folder_events(id);
create unique index allrice_folder_event_command_unique on allrice_bridge_commands(folder_event_id) where folder_event_id is not null;
create table allrice_folder_trigger_observations(
  automation_id uuid primary key references allrice_automations(id),revision integer not null,device_id uuid not null,
  status text not null check(status in ('listening','paused','error')),error_code text,observed_at timestamptz not null default now()
);
