-- R3 literal full-text queries use the pg_trgm extension installed by 0068.
-- This is a derived index, not a new source of publication or access authority.
do $$
declare
  trgm_schema text;
begin
  select n.nspname into strict trgm_schema
  from pg_catalog.pg_extension e
  join pg_catalog.pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pg_trgm';

  execute pg_catalog.format(
    'create index allrice_reference_fulltext_search_idx
      on allrice_knowledge_documents using gin (full_text %I.gin_trgm_ops)
      where active and full_text is not null',
    trgm_schema
  );
end
$$;
