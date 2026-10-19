-- MET194 P1: immutable package provenance on the existing Workflow revision.
-- A private package belongs to one real custom instance and exact scene.
-- Legacy employee-wide bindings retain all NULL scope columns and semantics.
create table allrice_workflow_packages (
  workflow_revision_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null,
  assignment_id uuid not null,
  employee_id uuid not null,
  instance_id uuid not null,
  scene_id uuid,
  manifest jsonb not null check(jsonb_typeof(manifest)='object'),
  checksum text not null check(checksum ~ '^sha256:[a-f0-9]{64}$'),
  source_object_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  foreign key(organization_id,workspace_id,workflow_revision_id)
    references allrice_workflow_revisions(organization_id,workspace_id,id),
  foreign key(organization_id,workspace_id,employee_id)
    references allrice_employees(organization_id,workspace_id,id),
  foreign key(organization_id,workspace_id,owner_id,assignment_id,instance_id)
    references allrice_employee_instances(organization_id,workspace_id,owner_id,assignment_id,id),
  foreign key(organization_id,workspace_id,source_object_id)
    references allrice_storage_objects(organization_id,workspace_id,id),
  unique(organization_id,workspace_id,workflow_revision_id)
);
create trigger allrice_workflow_package_immutable
  before update or delete on allrice_workflow_packages
  for each row execute function allrice_company_revision_immutable();
create index allrice_workflow_packages_instance
  on allrice_workflow_packages(organization_id,workspace_id,owner_id,instance_id,scene_id);

-- Keep revision content immutable even after its publication is revoked.
create function allrice_packaged_workflow_revision_fixed() returns trigger language plpgsql as $$
begin
  if exists(select 1 from allrice_workflow_packages p where p.workflow_revision_id=old.id) then
    if tg_op='DELETE' then
      raise exception 'packaged Workflow revision cannot be deleted';
    elsif (to_jsonb(new)-'status') is distinct from (to_jsonb(old)-'status') then
      raise exception 'packaged Workflow revision content is immutable';
    end if;
  end if;
  return new;
end $$;
create trigger allrice_packaged_workflow_revision_fixed
  before update or delete on allrice_workflow_revisions
  for each row execute function allrice_packaged_workflow_revision_fixed();

alter table allrice_employee_workflow_bindings
  add column owner_id uuid,
  add column assignment_id uuid,
  add column instance_id uuid,
  add column scene_id uuid,
  add column workflow_id uuid,
  add column package_checksum text check(package_checksum is null or package_checksum ~ '^sha256:[a-f0-9]{64}$'),
  add column binding_revision integer not null default 1 check(binding_revision>0),
  add foreign key(organization_id,workspace_id,owner_id,assignment_id,instance_id)
    references allrice_employee_instances(organization_id,workspace_id,owner_id,assignment_id,id),
  add foreign key(organization_id,workspace_id,workflow_id)
    references allrice_workflows(organization_id,workspace_id,id),
  add constraint allrice_workflow_binding_scope check(
    (instance_id is null and owner_id is null and assignment_id is null and scene_id is null and workflow_id is null and package_checksum is null)
    or (instance_id is not null and owner_id is not null and assignment_id is not null and workflow_id is not null and package_checksum is not null)
  );
create unique index allrice_workflow_binding_instance_slot
  on allrice_employee_workflow_bindings(organization_id,workspace_id,owner_id,instance_id,
    coalesce(scene_id,'00000000-0000-0000-0000-000000000000'::uuid),workflow_id)
  where instance_id is not null;

create function allrice_workflow_package_binding_fixed() returns trigger language plpgsql as $$
begin
  if tg_op='UPDATE' and
    (new.organization_id,new.workspace_id,new.employee_id,new.owner_id,new.assignment_id,new.instance_id,new.scene_id,new.workflow_id)
    is distinct from
    (old.organization_id,old.workspace_id,old.employee_id,old.owner_id,old.assignment_id,old.instance_id,old.scene_id,old.workflow_id) then
    raise exception 'Workflow binding ownership and scope are immutable';
  end if;
  if new.instance_id is null and exists(
    select 1 from allrice_workflow_packages p where p.workflow_revision_id=new.workflow_revision_id
  ) then
    raise exception 'private Workflow package cannot become an employee-wide binding';
  end if;
  if new.instance_id is not null then
    if not exists(
      select 1 from allrice_workflow_packages p
      join allrice_workflow_revisions r on r.id=p.workflow_revision_id
      join allrice_employee_instances i on i.id=p.instance_id
      join allrice_employee_assignments a on a.id=p.assignment_id
      where p.workflow_revision_id=new.workflow_revision_id and r.workflow_id=new.workflow_id
        and p.organization_id=new.organization_id and p.workspace_id=new.workspace_id
        and p.owner_id=new.owner_id and p.assignment_id=new.assignment_id
        and p.employee_id=new.employee_id and p.instance_id=new.instance_id
        and p.scene_id is not distinct from new.scene_id and p.checksum=new.package_checksum
        and i.kind='custom' and a.employee_id=new.employee_id
    ) then
      raise exception 'Workflow package binding scope mismatch';
    end if;
    if tg_op='UPDATE' and new.binding_revision<>old.binding_revision+1 then
      raise exception 'Workflow binding requires the next revision';
    end if;
  end if;
  return new;
end $$;
create trigger allrice_workflow_package_binding_fixed
  before insert or update on allrice_employee_workflow_bindings
  for each row execute function allrice_workflow_package_binding_fixed();

create table allrice_workflow_package_requests (
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null,
  instance_id uuid not null,
  request_id uuid not null,
  operation text not null check(operation in ('register','binding')),
  input_digest text not null check(input_digest ~ '^sha256:[a-f0-9]{64}$'),
  response jsonb not null check(jsonb_typeof(response)='object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(organization_id,workspace_id,owner_id,request_id),
  foreign key(organization_id,workspace_id,owner_id,instance_id)
    references allrice_employee_instances(organization_id,workspace_id,owner_id,id)
);
create trigger allrice_workflow_package_request_immutable
  before update or delete on allrice_workflow_package_requests
  for each row execute function allrice_company_revision_immutable();
