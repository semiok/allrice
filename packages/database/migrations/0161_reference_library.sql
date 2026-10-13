-- MET180: extend Knowledge, retain immutable files and persist processing state.
-- NULL ownership denotes existing workspace/ACL governed sources, unchanged.
alter table allrice_knowledge_sources add column ownership jsonb;
alter table allrice_knowledge_sources add constraint knowledge_ownership_shape check (
  ownership is null or coalesce((
    jsonb_typeof(ownership)='object' and
    (ownership->>'scope'='platform' or
     (ownership->>'organizationId'=organization_id::text and
      (ownership->>'scope'='company' or
       (ownership->>'scope'='department' and ownership->>'departmentId' is not null) or
       (ownership->>'scope'='personal' and ownership->>'ownerId'=created_by::text))))
  ),false)
);
alter table allrice_knowledge_revisions
  add column file_object_id uuid references allrice_storage_objects(id),
  add column file_name text,
  add column request_id uuid,
  add column request_input jsonb;
alter table allrice_knowledge_revisions add constraint knowledge_file_revision_shape check (
  (file_object_id is null and file_name is null and request_id is null and request_input is null) or
  (file_object_id is not null and file_name is not null and request_id is not null and request_input is not null)
);
create unique index knowledge_reference_upload_request
  on allrice_knowledge_revisions(organization_id,created_by,request_id) where request_id is not null;
create unique index knowledge_retained_object on allrice_knowledge_revisions(file_object_id) where file_object_id is not null;

create function allrice_preserve_reference_identity() returns trigger language plpgsql as $$
begin
  if tg_table_name='allrice_knowledge_sources' then
    if new.ownership is distinct from old.ownership then raise exception 'Knowledge ownership is immutable'; end if;
  elsif old.file_object_id is not null and old.published_at is not null and (to_jsonb(new)-'status') is distinct from (to_jsonb(old)-'status') then
    raise exception 'Reference revision is immutable';
  end if;
  return new;
end; $$;
create trigger knowledge_ownership_immutable before update on allrice_knowledge_sources
  for each row execute function allrice_preserve_reference_identity();
create trigger knowledge_reference_immutable before update on allrice_knowledge_revisions
  for each row execute function allrice_preserve_reference_identity();

create table allrice_knowledge_processing (
  revision_id uuid primary key references allrice_knowledge_revisions(id),
  state text not null default 'saved' check(state in ('saved','processing','ready','failed','unsupported')),
  attempts integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  failure text,
  indexed_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((state='processing')=(lease_token is not null and lease_until is not null))
);
create index knowledge_processing_pending on allrice_knowledge_processing(state,updated_at) where state in ('saved','processing');

create table allrice_knowledge_reference_actions (
  source_id uuid not null references allrice_knowledge_sources(id),
  actor_id uuid not null references allrice_users(id),
  request_id uuid not null,
  input jsonb not null,
  created_at timestamptz not null default now(),
  primary key(source_id,actor_id,request_id)
);
