-- Departments are company-scoped identities, independent of execution workspaces.
create table allrice_departments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references allrice_organizations(id),
  name text not null check (length(btrim(name)) between 1 and 120),
  revision integer not null default 1 check (revision > 0),
  archived_at timestamptz,
  create_request_id uuid not null,
  create_name text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (organization_id, id),
  unique (organization_id, create_request_id)
);
create unique index allrice_departments_active_name
  on allrice_departments (organization_id, lower(btrim(name)))
  where archived_at is null;

-- One person has one primary department per company, even when they have
-- several workspace memberships. Existing people remain unassigned.
alter table allrice_organization_people add column department_id uuid;
alter table allrice_organization_people add constraint allrice_person_department
  foreign key (organization_id, department_id)
  references allrice_departments (organization_id, id);
create index allrice_people_department
  on allrice_organization_people (organization_id, department_id)
  where department_id is not null;
