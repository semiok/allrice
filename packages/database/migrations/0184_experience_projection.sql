-- Optional, rebuildable metadata on the existing index. Memories, revisions and
-- adoption proofs remain authoritative. Old rows keep their original content.
alter table allrice_rag_chunks add column experience_projection jsonb
  check (experience_projection is null or jsonb_typeof(experience_projection) = 'object');
create unique index allrice_experience_projection_once on allrice_rag_chunks(memory_id)
  where experience_projection is not null;
