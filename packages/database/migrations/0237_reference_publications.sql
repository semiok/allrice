-- MET-247: new publications are independent fixed copies. NULL preserves every
-- legacy ownership/binding contract; no existing source is migrated here.
alter table allrice_knowledge_sources
  add column publication_kind text check (publication_kind in ('file','upload')),
  add column publication_origin_object_id uuid references allrice_storage_objects(id),
  add constraint knowledge_publication_identity check (
    (publication_kind is null and publication_origin_object_id is null) or
    (publication_kind='upload' and publication_origin_object_id is null and ownership->>'scope'='personal') or
    (publication_kind='file' and publication_origin_object_id is not null and ownership->>'scope'='personal')
  );

-- A source is the publication identity. Revoke, then explicitly publish again
-- creates a new identity; changing its audience never duplicates the source.
create unique index knowledge_active_file_publication
  on allrice_knowledge_sources(organization_id,created_by,publication_origin_object_id)
  where publication_kind='file' and status='active';

create function allrice_preserve_publication_identity() returns trigger
language plpgsql as $$
begin
  if new.publication_kind is distinct from old.publication_kind or
     new.publication_origin_object_id is distinct from old.publication_origin_object_id then
    raise exception 'Reference publication identity is immutable';
  end if;
  if old.publication_kind is not null and old.status='archived' and new.status<>'archived' then
    raise exception 'Revoked reference publications cannot be restored';
  end if;
  return new;
end; $$;
create trigger knowledge_publication_identity_immutable
  before update on allrice_knowledge_sources for each row
  execute function allrice_preserve_publication_identity();
