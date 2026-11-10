-- Schema 3 uses the same declarative source family and generation relation.
-- Complete source, policy, checksum and grant validation stays at admission.
create or replace function allrice_native_session_version_compatible(origin jsonb, manifest jsonb)
returns boolean language sql immutable as $$
  select case when origin is null then
    coalesce(manifest#>>'{runtimePackage,runtimeManifest,distributionGeneration}','dsh-0.1.5-rc.3-a4c74a9') in ('dsh-0.1.5-rc.3-a4c74a9','dsh-0.1.1-rc.2-b150a55')
  when origin->>'schemaVersion' = '2' then coalesce(
    origin->>'contextKind'='chat'
    and origin#>>'{sourcePolicy,family}'='allrice_declarative_employee_v1'
    and origin->>'distributionGeneration'='dsh-0.2.1-rc.2-687f282'
    and manifest->>'schemaVersion'='2'
    and manifest#>>'{runtimePolicy,harness}'='dsh'
    and (manifest->'runtimePackage'='null'::jsonb or
      (manifest#>>'{runtimePackage,schemaVersion}' in ('1','2','3') and
       manifest#>>'{runtimePackage,runtimeManifest,distributionGeneration}' in ('dsh-0.1.5-rc.3-a4c74a9','dsh-0.2.1-rc.2-687f282'))),false)
  else coalesce(origin->>'distributionGeneration' = manifest#>>'{runtimePackage,runtimeManifest,distributionGeneration}',false)
  end;
$$;
