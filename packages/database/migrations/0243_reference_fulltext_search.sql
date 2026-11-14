-- R3 literal full-text queries use the pg_trgm extension installed by 0068.
-- This is a derived index, not a new source of publication or access authority.
create index allrice_reference_fulltext_search_idx
  on allrice_knowledge_documents using gin (full_text gin_trgm_ops)
  where active and full_text is not null;
