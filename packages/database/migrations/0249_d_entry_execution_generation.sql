-- MET-271: immutable product writer ownership, not DSH distribution or Agent state.
-- The release owner must stop old writers before the first 4.0 thread is created.
set local lock_timeout = '15s';

alter table allrice_chat_sessions
  add column execution_generation text not null default '3.x'
    check (execution_generation in ('3.x', '4.0'));

create function allrice_chat_execution_generation_immutable() returns trigger
language plpgsql as $$
begin
  if new.execution_generation is distinct from old.execution_generation then
    raise exception 'chat execution generation is immutable'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger allrice_chat_execution_generation_immutable
  before update of execution_generation on allrice_chat_sessions
  for each row execute function allrice_chat_execution_generation_immutable();
