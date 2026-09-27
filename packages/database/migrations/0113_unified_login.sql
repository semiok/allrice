-- 0112 is reserved by the concurrently developed session-reference change.
-- Existing identities retain their IDs and credentials until explicit migration.
alter table allrice_users add column username text;
alter table allrice_users add constraint allrice_users_username_format
  check (username is null or (username = lower(username)
    and length(username) between 2 and 64
    and username ~ '^[a-z][a-z0-9._-]*$'));
create unique index allrice_users_username_unique
  on allrice_users (lower(username)) where username is not null;
