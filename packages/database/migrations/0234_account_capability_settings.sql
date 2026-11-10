-- Account-scoped configuration; employees do not acquire another setting column.
alter table allrice_user_preferences add column capability_settings jsonb not null
  default '{"allrice.cloud-project-development":{"configVersion":1,"enabled":false}}'::jsonb
  check (jsonb_typeof(capability_settings) = 'object');

-- NULL preserves conversations created before this feature and non-chat callers.
-- Only ordinary chat creation supplies the immutable account configuration.
alter table allrice_chat_sessions add column account_capability_snapshot jsonb
  check (account_capability_snapshot is null or jsonb_typeof(account_capability_snapshot) = 'object');

-- A Run references this exact conversation snapshot. No backfill from current
-- account settings and no mutation of an already created conversation.
create function allrice_chat_account_capability_immutable() returns trigger
language plpgsql as $$
begin
  if new.account_capability_snapshot is distinct from old.account_capability_snapshot then
    raise exception 'chat account capability snapshot is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger allrice_chat_account_capability_immutable
before update of account_capability_snapshot on allrice_chat_sessions
for each row execute function allrice_chat_account_capability_immutable();
