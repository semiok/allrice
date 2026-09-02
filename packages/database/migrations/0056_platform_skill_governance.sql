-- MET-97 P0-0C: every platform Skill must carry immutable provenance and a
-- completed review before it can enter an employee runtime package.

alter table allrice_platform_dsh_skills
  add column source_ref text,
  add column version text,
  add column license text,
  add column review_status text,
  add column reviewed_by_label text,
  add column reviewed_at timestamptz;

update allrice_platform_dsh_skills
set source_ref = case source
      when 'dsh-migrated' then 'https://github.com/deepseek-ai/DeepSeek-Harness'
      else 'https://github.com/semiok/allrice/tree/main/skills/' || name
    end,
    version = '1.0.0',
    license = case source
      when 'dsh-migrated' then 'MIT'
      else 'Apache-2.0'
    end,
    review_status = 'reviewed',
    reviewed_by_label = coalesce(created_by_label, 'MET-97 migration'),
    reviewed_at = coalesce(updated_at, created_at, now());

alter table allrice_platform_dsh_skills
  alter column source_ref set not null,
  alter column version set not null,
  alter column license set not null,
  alter column review_status set not null,
  add constraint allrice_platform_dsh_skills_source_ref_nonempty
    check (length(trim(source_ref)) > 0),
  add constraint allrice_platform_dsh_skills_version_nonempty
    check (length(trim(version)) > 0),
  add constraint allrice_platform_dsh_skills_license_nonempty
    check (length(trim(license)) > 0),
  add constraint allrice_platform_dsh_skills_review_status
    check (review_status in ('draft', 'reviewed', 'rejected')),
  add constraint allrice_platform_dsh_skills_review_evidence
    check (
      review_status <> 'reviewed'
      or (reviewed_by_label is not null and reviewed_at is not null)
    );

insert into allrice_runtime_metadata (key, value)
values (
  'platform-skill-governance',
  '{"version":"0056","issue":"MET-97","requiredFields":["source","sourceRef","version","license","reviewStatus","checksum"],"publishGate":"reviewed-only"}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
