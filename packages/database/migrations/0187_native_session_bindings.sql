-- Identity facts, not an execution grant. Short-lived Run/Job/test IDs are
-- snapshots without FKs: their finalizers lock Run before Job, and cleanup
-- must not erase the native reader pin.
create table allrice_native_session_bindings (
  native_session_id text primary key check (length(native_session_id) between 5 and 255
    and native_session_id ~ '^dsh-[a-zA-Z0-9._:-]+$'),
  organization_id uuid not null references allrice_organizations(id) on delete cascade,
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id) on delete cascade,
  context_kind text not null check (context_kind in
    ('chat','platform_technical','experience_consolidation','platform_employee_test')),
  context_id uuid not null,
  storage_context_key text not null,
  storage_namespace text not null check (length(storage_namespace) between 1 and 4096),
  artifact_id text not null check (artifact_id ~ '^sha256:[a-f0-9]{64}$'),
  artifact_manifest_digest text not null check (artifact_manifest_digest = artifact_id),
  distribution_generation text not null,
  profile_id text not null check (profile_id in ('restricted','technical')),
  first_run_id uuid not null,
  first_job_id uuid not null,
  first_attempt integer not null check (first_attempt > 0),
  binding_basis text not null check (binding_basis = 'approved_compatibility_reader'),
  bound_at timestamptz not null default clock_timestamp(),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id) on delete cascade
);
create index allrice_native_session_binding_context on allrice_native_session_bindings
  (organization_id,workspace_id,owner_id,context_kind,context_id);
create function allrice_native_session_binding_immutable() returns trigger language plpgsql as $$
begin
  if new is distinct from old then
    raise exception 'native session binding is immutable';
  end if;
  return new;
end;
$$;
create trigger allrice_native_session_binding_immutable before update
  on allrice_native_session_bindings for each row
  execute function allrice_native_session_binding_immutable();
