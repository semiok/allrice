alter table allrice_employee_instances add column archived_at timestamptz;
alter table allrice_employee_instance_revisions
  add column operation text not null default 'update' check (operation in ('create','update','archive','restore')),
  add column archived_at timestamptz,
  add column restored_from_revision integer,
  add foreign key (instance_id,restored_from_revision)
    references allrice_employee_instance_revisions(instance_id,revision),
  add check ((operation='restore')=(restored_from_revision is not null));
update allrice_employee_instance_revisions set operation='create' where revision=1;

-- Preserve original profile and receipt bytes. Only the initial response may
-- be completed after the new revision is inserted in the same transaction.
create function allrice_employee_instance_revision_immutable() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then raise exception 'employee_instance_revision_immutable'; end if;
  if (to_jsonb(new)-'response') is distinct from (to_jsonb(old)-'response')
     or (old.response is not null and new.response is distinct from old.response) then
    raise exception 'employee_instance_revision_immutable';
  end if;
  return new;
end $$;
create trigger employee_instance_revision_immutable before update or delete
  on allrice_employee_instance_revisions for each row execute function allrice_employee_instance_revision_immutable();

alter table allrice_employee_content_revisions
  add column restored_from_revision_id uuid,
  add foreign key (set_id,restored_from_revision_id)
    references allrice_employee_content_revisions(set_id,id);
alter table allrice_employee_content_requests drop constraint allrice_employee_content_requests_operation_check;
alter table allrice_employee_content_requests add check (operation in ('save_draft','restore_draft','validate','activate'));
