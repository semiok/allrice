-- A retained Knowledge revision may originate from one exact business delivery.
-- Provenance is immutable with the revision; the public reader exposes only
-- filename/version/checksum, never private Session or Run contents.
alter table allrice_knowledge_revisions
  add column source_artifact_version_id uuid,
  add column source_target_key text,
  add column artifact_snapshot jsonb,
  add constraint knowledge_artifact_source_fk
    foreign key (organization_id,workspace_id,source_artifact_version_id)
    references allrice_deliverable_versions(organization_id,workspace_id,id),
  add constraint knowledge_artifact_source_shape check (
    (source_artifact_version_id is null and source_target_key is null and artifact_snapshot is null) or
    (source_artifact_version_id is not null and source_target_key is not null and
      file_object_id is not null and artifact_snapshot is not null and jsonb_typeof(artifact_snapshot)='object')
  );
create unique index knowledge_artifact_target
  on allrice_knowledge_revisions(organization_id,source_artifact_version_id,source_target_key)
  where source_artifact_version_id is not null;

-- Include duplicate-save aliases, and share the request namespace with uploads.
-- A retry cannot silently change operation, source version, purpose or target.
create table allrice_knowledge_save_requests (
  organization_id uuid not null references allrice_organizations(id),
  actor_id uuid not null references allrice_users(id),
  request_id uuid not null,
  operation text not null check(operation in ('upload','artifact')),
  input jsonb not null,
  revision_id uuid not null references allrice_knowledge_revisions(id),
  created_at timestamptz not null default now(),
  primary key(organization_id,actor_id,request_id)
);
insert into allrice_knowledge_save_requests(organization_id,actor_id,request_id,operation,input,revision_id)
  select organization_id,created_by,request_id,'upload',request_input,id
  from allrice_knowledge_revisions where request_id is not null;
