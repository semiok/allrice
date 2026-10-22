-- Display preferences share the existing authenticated account identity.
-- Existing streaming preferences are preserved; no execution package changes.
alter table allrice_user_preferences
  add column font_size integer not null default 14
    check (font_size between 10 and 22),
  add column transcript_view text not null default 'detailed'
    check (transcript_view in ('compact', 'standard', 'detailed', 'verbose')),
  add column collapse_timing text not null default 'completion'
    check (collapse_timing in ('completion', 'next-input'));
