-- Private package bytes use the existing quota/storage lifecycle. Import
-- candidates are bounded, expiring authority, never an enabled skill.
alter table allrice_personal_skill_versions add column resource_manifest jsonb;
alter table allrice_personal_skill_versions add column package_checksum text
  check(package_checksum is null or package_checksum ~ '^sha256:[a-f0-9]{64}$');
do $$
declare previous_name text;
begin
  select conname into strict previous_name from pg_constraint
    where conrelid='allrice_personal_skill_versions'::regclass and contype='u'
      and pg_get_constraintdef(oid)='UNIQUE (installation_id, definition_checksum)';
  execute format('alter table allrice_personal_skill_versions drop constraint %I',previous_name);
end $$;
create unique index allrice_personal_skill_version_content
  on allrice_personal_skill_versions(installation_id,coalesce(package_checksum,definition_checksum));
alter table allrice_personal_skill_versions add constraint personal_skill_package_pair
  check ((resource_manifest is null) = (package_checksum is null));

create table allrice_personal_skill_imports (
  id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null,
  instance_id uuid not null,
  session_id uuid not null references allrice_chat_sessions(id),
  user_message_id uuid not null references allrice_messages(id),
  source jsonb not null,
  archive_object_id uuid not null references allrice_storage_objects(id),
  candidates jsonb not null check(jsonb_typeof(candidates)='array' and jsonb_array_length(candidates) between 1 and 8),
  state text not null default 'staging' check(state in ('staging','ready','consumed','canceled')),
  selected_path text,
  installation_id uuid references allrice_personal_skill_installations(id),
  expires_at timestamptz not null default clock_timestamp()+interval '24 hours',
  created_at timestamptz not null default clock_timestamp(),
  foreign key(organization_id,workspace_id,owner_id,instance_id)
    references allrice_employee_instances(organization_id,workspace_id,owner_id,id),
  check((state='consumed') = (installation_id is not null and selected_path is not null))
);
create index allrice_personal_skill_imports_owner on allrice_personal_skill_imports(organization_id,owner_id,instance_id,expires_at);
