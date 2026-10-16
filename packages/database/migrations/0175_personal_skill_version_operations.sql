-- Source provenance may change without changing the instruction bytes.
-- Version identity is immutable; updates and rollback only move the library pointer.
drop index allrice_personal_skill_version_content;
create table allrice_personal_skill_version_operations (
  id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null references allrice_workspaces(id),
  owner_id uuid not null,
  installation_id uuid not null,
  session_id uuid not null references allrice_chat_sessions(id),
  user_message_id uuid not null references allrice_messages(id),
  request_input jsonb not null,
  preview jsonb not null,
  candidate jsonb not null,
  state text not null check(state in ('pending','applied','unchanged','canceled')),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp()+interval '24 hours',
  foreign key(organization_id,owner_id,installation_id)
    references allrice_personal_skill_installations(organization_id,owner_id,id)
);
create index allrice_personal_skill_version_operation_owner
  on allrice_personal_skill_version_operations(organization_id,owner_id,installation_id,created_at);

create function allrice_personal_skill_operation_fixed() returns trigger language plpgsql as $$
begin
  if (to_jsonb(new)-array['state','preview']) is distinct from (to_jsonb(old)-array['state','preview'])
    or (new.preview-array['status','appliedVersionId','appliedRevision']) is distinct from
       (old.preview-array['status','appliedVersionId','appliedRevision'])
    or old.state<>'pending' or new.state not in ('applied','canceled') then
    raise exception 'personal Skill candidate and completed receipt are immutable';
  end if;
  return new;
end $$;
create trigger allrice_personal_skill_operation_fixed before update on allrice_personal_skill_version_operations
  for each row execute function allrice_personal_skill_operation_fixed();
