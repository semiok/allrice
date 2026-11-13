-- MET-247: complete extractable text and natural locators are derived data.
-- NULL leaves every existing document, publication, pin and processing state intact.
alter table allrice_knowledge_documents
  add column full_text text,
  add column full_text_locations jsonb,
  add column full_text_metadata jsonb,
  add constraint knowledge_full_text_shape check (
    (full_text is null and full_text_locations is null and full_text_metadata is null)
    or
    coalesce((full_text is not null and length(full_text)>0
      and jsonb_typeof(full_text_locations)='object'
      and jsonb_typeof(full_text_locations->'units')='array'
      and jsonb_typeof(full_text_metadata)='object'),false)
  );

-- Reuse the existing lease for derived-text backfill without withdrawing ready
-- references. No state value, scheduler, publication or source identity changes.
do $$
declare lease_constraint text;
begin
  for lease_constraint in
    select conname from pg_constraint
    where conrelid='allrice_knowledge_processing'::regclass and contype='c'
      and pg_get_constraintdef(oid) like '%lease_token%'
  loop
    execute format('alter table allrice_knowledge_processing drop constraint %I', lease_constraint);
  end loop;
end; $$;
alter table allrice_knowledge_processing
  add constraint knowledge_processing_lease_shape check (
    (lease_token is null)=(lease_until is null)
    and (state<>'processing' or lease_token is not null)
    and (lease_token is null or state in ('processing','ready'))
  );
