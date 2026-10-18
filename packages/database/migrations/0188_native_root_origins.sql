-- NULL is deliberately the historical reader choice. No default or backfill:
-- only the first business INSERT may record candidate creation authority.
alter table allrice_chat_sessions add column native_root_origin jsonb;
alter table allrice_platform_technical_tasks add column native_root_origin jsonb;
alter table allrice_automation_runs add column native_root_origin jsonb;
alter table allrice_platform_employee_test_runs add column native_root_origin jsonb;
-- NULL remains the historical reader family. Content updates within a family
-- continue; an engine-family change requires a new business Session, never a
-- mutable assignment update or retroactive origin issuance.
create function allrice_native_session_version_compatible(origin jsonb, manifest jsonb)
returns boolean language sql immutable as $$
  select case when origin is null then
    coalesce(manifest#>>'{runtimePackage,runtimeManifest,distributionGeneration}','dsh-0.1.5-rc.3-a4c74a9') in ('dsh-0.1.5-rc.3-a4c74a9','dsh-0.1.1-rc.2-b150a55')
  else coalesce(origin->>'distributionGeneration' = manifest#>>'{runtimePackage,runtimeManifest,distributionGeneration}',false)
  end;
$$;
create function allrice_native_root_origin_immutable() returns trigger language plpgsql as $$
begin
  if new.native_root_origin is distinct from old.native_root_origin then
    raise exception 'native root origin is immutable';
  end if;
  return new;
end;
$$;
create trigger native_root_origin_immutable before update on allrice_chat_sessions for each row execute function allrice_native_root_origin_immutable();
create trigger native_root_origin_immutable before update on allrice_platform_technical_tasks for each row execute function allrice_native_root_origin_immutable();
create trigger native_root_origin_immutable before update on allrice_automation_runs for each row execute function allrice_native_root_origin_immutable();
create trigger native_root_origin_immutable before update on allrice_platform_employee_test_runs for each row execute function allrice_native_root_origin_immutable();
alter table allrice_native_session_bindings drop constraint allrice_native_session_bindings_binding_basis_check;
alter table allrice_native_session_bindings add column root_origin_digest text;
alter table allrice_native_session_bindings add constraint allrice_native_session_binding_basis_check check (
  (binding_basis='approved_compatibility_reader' and root_origin_digest is null) or
  (binding_basis='business_root_origin' and root_origin_digest is not null and root_origin_digest ~ '^sha256:[a-f0-9]{64}$'));
