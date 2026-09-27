alter table allrice_organizations
  add column business_context text not null default '',
  add column revision integer not null default 1 check (revision > 0),
  add column default_workspace_id uuid;
alter table allrice_organizations add constraint allrice_organization_default_workspace
  foreign key (id, default_workspace_id) references allrice_workspaces (organization_id, id);
update allrice_organizations o set default_workspace_id=(
  select w.id from allrice_workspaces w where w.organization_id=o.id and w.archived_at is null
  order by (w.slug='default') desc,w.created_at,w.id limit 1
);

-- A person's role and working context belong to the company, not a global AI template.
create table allrice_organization_people (
  organization_id uuid not null references allrice_organizations(id),
  user_id uuid not null references allrice_users(id),
  display_name text not null,
  job_title text not null default '',
  responsibilities text not null default '',
  updated_at timestamptz not null default now(),
  primary key (organization_id,user_id)
);
insert into allrice_organization_people (organization_id,user_id,display_name)
  select distinct m.organization_id,m.user_id,u.display_name
  from allrice_memberships m join allrice_users u on u.id=m.user_id;
