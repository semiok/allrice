-- Configuration binds existing employee identities and immutable source versions.
-- Scenes are content indexes, not a new permission or execution boundary.
create table allrice_employee_content_sets (
  id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  employee_id uuid not null,
  instance_id uuid,
  scope text not null check(scope in ('personal','department','company')),
  owner_id uuid references allrice_users(id),
  department_id uuid,
  revision integer not null default 0 check(revision>=0),
  candidate_revision_id uuid,
  active_revision_id uuid,
  validation jsonb,
  created_by uuid not null references allrice_users(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key(organization_id,workspace_id,employee_id)
    references allrice_employees(organization_id,workspace_id,id),
  foreign key(organization_id,workspace_id,owner_id,instance_id)
    references allrice_employee_instances(organization_id,workspace_id,owner_id,id),
  foreign key(organization_id,department_id) references allrice_departments(organization_id,id),
  check((scope='personal')=(owner_id is not null)),
  check((scope='personal')=(instance_id is not null)),
  check((scope='department')=(department_id is not null)),
  check((revision=0)=(candidate_revision_id is null)),
  unique(organization_id,workspace_id,id)
);
create unique index allrice_employee_content_personal
  on allrice_employee_content_sets(instance_id) where scope='personal';
create unique index allrice_employee_content_company
  on allrice_employee_content_sets(organization_id,workspace_id,employee_id) where scope='company';
create unique index allrice_employee_content_department
  on allrice_employee_content_sets(organization_id,workspace_id,employee_id,department_id) where scope='department';

create table allrice_employee_content_revisions (
  id uuid primary key,
  set_id uuid not null references allrice_employee_content_sets(id),
  number integer not null check(number>0),
  manifest jsonb not null,
  digest text not null check(digest ~ '^sha256:[a-f0-9]{64}$'),
  change_summary text not null,
  created_by uuid not null references allrice_users(id),
  created_at timestamptz not null default clock_timestamp(),
  unique(set_id,number),unique(set_id,id)
);
alter table allrice_employee_content_sets
  add foreign key(id,candidate_revision_id) references allrice_employee_content_revisions(set_id,id),
  add foreign key(id,active_revision_id) references allrice_employee_content_revisions(set_id,id);
create trigger allrice_employee_content_revision_immutable
  before update or delete on allrice_employee_content_revisions
  for each row execute function allrice_company_revision_immutable();

create table allrice_employee_content_requests (
  id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  actor_id uuid not null references allrice_users(id),
  request_id uuid not null,
  set_id uuid not null references allrice_employee_content_sets(id),
  operation text not null check(operation in ('save_draft','validate','activate')),
  input_digest text not null check(input_digest ~ '^sha256:[a-f0-9]{64}$'),
  response jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key(organization_id,workspace_id,set_id)
    references allrice_employee_content_sets(organization_id,workspace_id,id),
  unique(organization_id,workspace_id,actor_id,request_id)
);
create trigger allrice_employee_content_request_immutable
  before update or delete on allrice_employee_content_requests
  for each row execute function allrice_company_revision_immutable();

-- Reuse the existing immutable text revision store. Old rule/template readers
-- must explicitly exclude these kinds; publishing a private text grants no
-- company-wide visibility and does not make it an automatic company rule.
alter table allrice_company_assets
  drop constraint allrice_company_assets_kind_check,
  add constraint allrice_company_assets_kind_check
    check(kind in ('rule','template','execution_requirement','procedure')),
  add column content_scope text not null default 'company'
    check(content_scope in ('personal','department','company')),
  add column content_workspace_id uuid,
  add column department_id uuid,
  add foreign key(organization_id,department_id) references allrice_departments(organization_id,id),
  add foreign key(organization_id,content_workspace_id)
    references allrice_workspaces(organization_id,id),
  add constraint allrice_company_assets_layered_ownership check(
    (kind in ('rule','template') and content_scope='company' and content_workspace_id is null and department_id is null)
    or (kind in ('execution_requirement','procedure') and content_workspace_id is not null
      and ((content_scope='department')=(department_id is not null)))
  );

create function allrice_layered_content_ownership_immutable() returns trigger language plpgsql as $$
begin
  if tg_table_name='allrice_employee_content_sets' then
    if (new.organization_id,new.workspace_id,new.employee_id,new.instance_id,new.scope,new.owner_id,new.department_id)
      is distinct from (old.organization_id,old.workspace_id,old.employee_id,old.instance_id,old.scope,old.owner_id,old.department_id) then
      raise exception 'content ownership and target are immutable';
    end if;
  elsif (new.organization_id,new.owner_id,new.kind,new.content_scope,new.content_workspace_id,new.department_id)
    is distinct from (old.organization_id,old.owner_id,old.kind,old.content_scope,old.content_workspace_id,old.department_id) then
    raise exception 'content source ownership is immutable';
  end if;
  return new;
end $$;
create trigger allrice_employee_content_ownership_immutable
  before update on allrice_employee_content_sets
  for each row execute function allrice_layered_content_ownership_immutable();
create trigger allrice_company_asset_ownership_immutable
  before update on allrice_company_assets
  for each row execute function allrice_layered_content_ownership_immutable();
