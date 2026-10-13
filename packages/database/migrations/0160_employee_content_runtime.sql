-- Keep immutable manifests/bodies intact. Publication and explicit correction
-- are separate metadata, like the existing company asset publication ledger.
create table allrice_employee_content_publications (
  set_id uuid not null,
  revision_id uuid not null,
  published_at timestamptz not null default clock_timestamp(),
  invalidated_at timestamptz,
  primary key(set_id,revision_id),
  foreign key(set_id,revision_id) references allrice_employee_content_revisions(set_id,id)
);
insert into allrice_employee_content_publications(set_id,revision_id)
  select id,active_revision_id from allrice_employee_content_sets
  where active_revision_id is not null;

-- Provenance only: bodies stay in their existing immutable stores. Replacing
-- this generation creates a new native thread and a safe history boundary;
-- an old Run cannot rebind and replay its tools after invalidation.
create table allrice_employee_content_contexts (
  generation_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  session_id uuid not null references allrice_chat_sessions(id),
  history_from_message_id uuid references allrice_messages(id),
  invalidated_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  unique(organization_id,workspace_id,owner_id,session_id,generation_id)
);
create unique index allrice_employee_content_context_current
  on allrice_employee_content_contexts(session_id) where invalidated_at is null;
alter table allrice_employee_runs add column content_generation_id uuid,
  add foreign key(organization_id,workspace_id,owner_id,session_id,content_generation_id)
    references allrice_employee_content_contexts(organization_id,workspace_id,owner_id,session_id,generation_id);
create index allrice_employee_runs_content_generation
  on allrice_employee_runs(session_id,content_generation_id)
  where content_generation_id is not null;

create function allrice_employee_content_run_binding_immutable() returns trigger language plpgsql as $$
begin
  if old.content_generation_id is not null and new.content_generation_id is distinct from old.content_generation_id then
    raise exception 'content generation binding is immutable';
  end if;
  return new;
end $$;
create trigger allrice_employee_content_run_binding_immutable
  before update on allrice_employee_runs for each row execute function allrice_employee_content_run_binding_immutable();
