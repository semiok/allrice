-- Server-captured source text is private execution evidence. Public message
-- content contains only source labels/IDs; never accept snapshots from clients.
alter table allrice_messages add column session_references jsonb not null default '[]'::jsonb
  check (jsonb_typeof(session_references) = 'array' and jsonb_array_length(session_references) <= 3);
