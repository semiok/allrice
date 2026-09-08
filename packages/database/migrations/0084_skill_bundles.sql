-- Immutable small reviewed resources. User artifacts remain in StoragePort.
alter table allrice_platform_dsh_skills add column if not exists bundle jsonb;
alter table allrice_dsh_skills add column if not exists bundle jsonb;
create table if not exists allrice_platform_skill_bundle_versions (
  skill_id uuid not null references allrice_platform_dsh_skills(id),
  version text not null,
  checksum text not null check (checksum ~ '^sha256:[a-f0-9]{64}$'),
  bundle jsonb not null check (jsonb_typeof(bundle) = 'object' and octet_length(bundle::text) <= 900000),
  created_at timestamptz not null default clock_timestamp(),
  primary key (skill_id, version),
  unique (skill_id, checksum)
);
create or replace function allrice_reject_skill_bundle_mutation() returns trigger language plpgsql as $$
begin raise exception 'skill_bundle_version_is_immutable'; end;
$$;
create trigger allrice_skill_bundle_immutable before update or delete
  on allrice_platform_skill_bundle_versions for each row execute function allrice_reject_skill_bundle_mutation();
