-- Employee appearance follows DSH ui-theme preference values. Existing and new
-- accounts start light (user decision 10-27); other saved choices are kept.
alter table allrice_user_preferences
  add column appearance text not null default 'light'
    check (appearance in ('light', 'dark', 'system'));
