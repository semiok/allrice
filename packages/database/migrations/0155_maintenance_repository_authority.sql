-- Product publication is authorized by a durable expiring grant, never an
-- invented or extended browser session. Historical actions keep version 1.
alter table allrice_platform_repository_actions
  alter column login_session_id drop not null,
  alter column login_authenticated_at drop not null,
  add column authority_version integer not null default 1,
  add column maintenance_grant_id uuid references allrice_platform_maintenance_grants(id),
  add constraint allrice_repository_authority_shape check (
    (authority_version=1 and login_session_id is not null and login_authenticated_at is not null and maintenance_grant_id is null)
    or (authority_version=2 and login_session_id is null and login_authenticated_at is null and maintenance_grant_id is not null)
  );
alter table allrice_platform_repository_publications add column provenance jsonb;
