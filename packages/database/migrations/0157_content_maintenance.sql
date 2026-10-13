-- Content maintenance is independent of account administration and tool grants.
-- Existing people receive only their own personal content authority.
alter table allrice_organization_people
  add column content_maintenance_level text not null default 'personal'
    check (content_maintenance_level in ('personal', 'department', 'company'));
