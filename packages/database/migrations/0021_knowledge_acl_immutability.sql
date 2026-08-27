-- Knowledge ACL is part of the immutable revision checksum. Build revisions as
-- draft, attach ACL entries, then publish; published ACL cannot be extended,
-- edited or deleted in place.

create or replace function allrice_reject_published_knowledge_acl_mutation()
returns trigger language plpgsql as $$
declare
  revision_id uuid;
  revision_status text;
begin
  revision_id := case
    when tg_op = 'DELETE' then old.knowledge_revision_id
    else new.knowledge_revision_id
  end;
  select status into revision_status
  from allrice_knowledge_revisions
  where id = revision_id;
  if revision_status = 'published' then
    raise exception 'published knowledge revision ACL is immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists allrice_knowledge_acl_immutable
  on allrice_knowledge_acl_entries;

create trigger allrice_knowledge_acl_immutable
before insert or update or delete on allrice_knowledge_acl_entries
for each row execute function allrice_reject_published_knowledge_acl_mutation();

insert into allrice_runtime_metadata (key, value)
values (
  'knowledge-acl-schema',
  '{"version":"0021","issue":"MET-68","revisionAcl":"immutable-after-publish"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
