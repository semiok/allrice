-- Company templates are read-only Knowledge projections. Their existing
-- publication history remains the sole authority for sharing and parameters.
alter table allrice_knowledge_sources
  add column legacy_company_asset_id uuid unique,
  add unique(id,legacy_company_asset_id),
  add foreign key(organization_id,legacy_company_asset_id)
    references allrice_company_assets(organization_id,id);
alter table allrice_knowledge_revisions
  add column legacy_company_asset_id uuid,
  add column legacy_company_revision_id uuid unique,
  add check ((legacy_company_asset_id is null)=(legacy_company_revision_id is null)),
  add foreign key(knowledge_source_id,legacy_company_asset_id)
    references allrice_knowledge_sources(id,legacy_company_asset_id),
  add foreign key(legacy_company_asset_id,legacy_company_revision_id)
    references allrice_company_asset_revisions(asset_id,id);
-- A parameter-only revision can intentionally retain the same immutable file.
drop index knowledge_retained_object;
create unique index knowledge_retained_object on allrice_knowledge_revisions(file_object_id)
  where file_object_id is not null and legacy_company_revision_id is null;

create function allrice_preserve_reference_mapping() returns trigger language plpgsql as $$
begin
  if new.legacy_company_asset_id is distinct from old.legacy_company_asset_id then
    raise exception 'Reference source mapping is immutable';
  end if;
  return new;
end; $$;
create trigger knowledge_legacy_mapping_immutable before update on allrice_knowledge_sources
  for each row execute function allrice_preserve_reference_mapping();

-- Repeatable backfill and publication hook. Asset -> source is also the lock
-- order used by readers. No source file, Session, storage object or quota is copied.
create function allrice_sync_company_template_reference(asset uuid) returns void language plpgsql as $$
declare a record; r record; s record; definition jsonb; ownership jsonb;
        manifest text; mapped uuid;
begin
  select * into a from allrice_company_assets where id=asset for update;
  if not found or a.kind<>'template' then return; end if;
  for r in
    select cr.*,p.published_at,o.workspace_id as storage_workspace_id,
      o.organization_id as storage_organization_id,o.checksum as storage_checksum,
      o.size_bytes,o.media_type,o.state as storage_state,o.immutable,o.deleted_at,o.retention_until
    from allrice_company_asset_publications p
    join allrice_company_asset_revisions cr on cr.asset_id=p.asset_id and cr.id=p.revision_id
    join allrice_storage_objects o on o.id=cr.snapshot_object_id
    where p.asset_id=asset order by cr.number
  loop
    -- Never turn a mutable/original/expired object into shared Knowledge.
    if r.storage_organization_id<>a.organization_id or r.storage_state<>'ready'
      or not r.immutable or r.deleted_at is not null or r.retention_until is not null
      or r.file_metadata->>'objectId'<>r.snapshot_object_id::text
      or r.file_metadata->>'checksum'<>r.storage_checksum
      or (r.file_metadata->>'sizeBytes')::bigint<>r.size_bytes
      or r.file_metadata->>'mediaType'<>r.media_type then
      raise exception 'Company template snapshot is not retained: %',r.id;
    end if;
    ownership=jsonb_build_object('scope','company','organizationId',a.organization_id::text);
    insert into allrice_knowledge_sources(organization_id,workspace_id,slug,name,description,created_by,ownership,legacy_company_asset_id)
      values(a.organization_id,r.storage_workspace_id,'company-reference-'||a.id,
        r.file_metadata->>'fileName',r.content->>'title',a.owner_id,ownership,a.id)
      on conflict(legacy_company_asset_id) do nothing;
    select * into s from allrice_knowledge_sources where legacy_company_asset_id=a.id for update;
    definition=jsonb_build_object('schemaVersion',1,'sourceKind','managed','connectorBindingId',null,
      'resourceRef','file:'||r.snapshot_object_id,'indexing','hybrid','updatePolicy','manual',
      'citationRequired',true,'allowedScopes',jsonb_build_array('organization'));
    manifest='sha256:'||encode(sha256(convert_to(jsonb_build_object('definition',definition,
      'ownership',ownership,'companyRevisionId',r.id,'companyDigest',r.digest,
      'checksum',r.storage_checksum)::text,'UTF8')),'hex');
    insert into allrice_knowledge_revisions(organization_id,workspace_id,knowledge_source_id,
      revision,name,description,status,definition,checksum,created_by,published_at,created_at,
      file_object_id,file_name,request_id,request_input,legacy_company_asset_id,legacy_company_revision_id)
      values(a.organization_id,s.workspace_id,s.id,r.number,r.file_metadata->>'fileName',r.content->>'title',
        'published',definition,manifest,r.created_by,r.published_at,r.created_at,
        r.snapshot_object_id,r.file_metadata->>'fileName',r.id,jsonb_build_object('companyRevisionId',r.id),a.id,r.id)
      on conflict(legacy_company_revision_id) do nothing;
    select id into mapped from allrice_knowledge_revisions where legacy_company_revision_id=r.id;
    insert into allrice_knowledge_processing(revision_id) values(mapped) on conflict do nothing;
  end loop;
end; $$;
create function allrice_company_reference_published() returns trigger language plpgsql as $$
begin
  perform allrice_sync_company_template_reference(new.asset_id);
  return new;
end; $$;
create trigger company_reference_published after insert on allrice_company_asset_publications
  for each row execute function allrice_company_reference_published();

do $$ declare a record; begin
  for a in select id from allrice_company_assets where kind='template' order by id loop
    perform allrice_sync_company_template_reference(a.id);
  end loop;
end; $$;
