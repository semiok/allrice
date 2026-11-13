-- MET-223 B: remove retired method executors and platform Skill sources.
-- The migration runner owns one transaction and the deployment write fence.
-- Shared versions, Runs, instance creation pointers and memories are untouched.

create temporary table met223_retired_skills (id uuid primary key, name text not null) on commit drop;
insert into met223_retired_skills values
  ('7486aa1e-2495-4dd1-9eea-2ba4d65c761e', 'document-analysis'),
  ('4f94e92d-e065-4217-af0b-9c25d0802290', 'structured-deliverable'),
  ('d78b3556-821a-5550-bf13-d9dd84b9bbe0', 'development-cooperation');

-- Tenant IDs differ from platform IDs. A name alone is never provenance.
-- Include older immutable package bodies, not just the latest catalog body.
create temporary table met223_retired_skill_bodies on commit drop as
select s.name, s.checksum, s.content
from allrice_platform_dsh_skills s join met223_retired_skills r on r.id=s.id and r.name=s.name
where s.source='allrice'
union
select s->>'name', s->>'checksum', s->>'content'
from allrice_employee_versions v
cross join lateral jsonb_array_elements(coalesce(v.manifest#>'{runtimePackage,skills}', '[]'::jsonb)) s
join met223_retired_skills r on r.id::text=s->>'id' and r.name=s->>'name'
union
select s->>'name', s->>'checksum', s->>'content'
from allrice_platform_employee_revisions v
cross join lateral jsonb_array_elements(coalesce(v.runtime_profile#>'{runtimePackage,skills}', '[]'::jsonb)) s
join met223_retired_skills r on r.id::text=s->>'id' and r.name=s->>'name';

create temporary table met223_retired_tenant_skills on commit drop as
select s.id from allrice_dsh_skills s
where exists (select 1 from met223_retired_skill_bodies b
  where b.name=s.name and b.checksum=s.checksum and b.content=s.content);

delete from allrice_employee_dsh_skill_bindings
where skill_id in (select id from met223_retired_tenant_skills);
delete from allrice_dsh_skills where id in (select id from met223_retired_tenant_skills);

-- Keep mixed live instance/memory references to old versions as passive storage.
-- Existing publication/rollback readers already require status='published'.
update allrice_platform_employee_revisions v set status='disabled'
where exists (
  select 1 from jsonb_array_elements(coalesce(v.runtime_profile#>'{runtimePackage,skills}', '[]'::jsonb)) s
  join met223_retired_skills r on r.id::text=s->>'id'
) or exists (
  select 1 from met223_retired_skills r
  where coalesce(v.definition#>'{capabilities,nativeSkillIds}', '[]'::jsonb) ? r.id::text
);

-- This one immutable-history trigger is restored before the transaction ends.
-- All FKs and all other triggers remain enabled throughout.
alter table allrice_platform_skill_bundle_versions disable trigger allrice_skill_bundle_immutable;
delete from allrice_platform_skill_bundle_versions
where skill_id in (select id from met223_retired_skills);
alter table allrice_platform_skill_bundle_versions enable trigger allrice_skill_bundle_immutable;
delete from allrice_platform_dsh_skills where id in (select id from met223_retired_skills);

drop table allrice_employee_method_file_steps;
drop table allrice_employee_method_activations;
drop table allrice_employee_method_tests;
-- Unexpected shared deliverable/experience references fail the transaction via
-- their existing FKs. Never follow them into current content with CASCADE.
delete from allrice_platform_employee_test_runs where purpose='method_candidate';
alter table allrice_platform_employee_test_runs
  drop constraint allrice_platform_employee_test_runs_purpose_check,
  add constraint allrice_platform_employee_test_runs_purpose_check
    check (purpose in ('platform_preview', 'experience_validation'));
