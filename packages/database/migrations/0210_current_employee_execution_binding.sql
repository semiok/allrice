-- First INSERT only. Historical NULL/v1 sessions and queued Runs are not
-- upgraded, backfilled, rebound, deleted or assigned synthetic packages.
alter table allrice_employee_runs add column native_execution_binding jsonb;

create function allrice_employee_execution_binding_guard() returns trigger language plpgsql as $$
declare origin jsonb;
begin
  if tg_op = 'UPDATE' then
    if new.native_execution_binding is distinct from old.native_execution_binding then
      raise exception 'employee execution binding is immutable';
    end if;
    return new;
  end if;
  select native_root_origin into origin from allrice_chat_sessions
    where id=new.session_id and organization_id=new.organization_id
      and workspace_id=new.workspace_id and owner_id=new.owner_id;
  if origin->>'schemaVersion' = '2' then
    if new.native_execution_binding is null
      or new.native_execution_binding->>'schemaVersion' is distinct from '1'
      or new.native_execution_binding->>'kind' is distinct from 'current_employee_execution'
      or new.native_execution_binding#>>'{scope,organizationId}' is distinct from new.organization_id::text
      or new.native_execution_binding#>>'{scope,workspaceId}' is distinct from new.workspace_id::text
      or new.native_execution_binding#>>'{scope,ownerId}' is distinct from new.owner_id::text
      or new.native_execution_binding#>>'{scope,sessionId}' is distinct from new.session_id::text
      or new.native_execution_binding#>>'{scope,runId}' is distinct from new.run_id::text
      or new.native_execution_binding#>>'{source,employeeVersionId}' is distinct from new.employee_version_id::text
      or new.native_execution_binding#>>'{execution,artifactId}' is distinct from origin->>'artifactId'
      or new.native_execution_binding#>>'{execution,generation}' is distinct from origin->>'distributionGeneration'
      or new.native_execution_binding#>>'{execution,profileId}' is distinct from 'restricted'
      or new.native_execution_binding#>>'{sourcePolicy,family}' is distinct from origin#>>'{sourcePolicy,family}' then
      raise exception 'current employee execution binding required';
    end if;
  elsif new.native_execution_binding is not null then
    raise exception 'historical employee execution cannot be rebound';
  end if;
  return new;
end;
$$;
create trigger employee_execution_binding_guard before insert or update on allrice_employee_runs
  for each row execute function allrice_employee_execution_binding_guard();

-- v2 fixes an executor separately from declarative employee versions. Updates
-- within the explicitly reviewed source family are allowed; old rules retain
-- their exact meaning. Complete source checksums/grants are verified in TS.
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
      (manifest#>>'{runtimePackage,schemaVersion}' in ('1','2') and
       manifest#>>'{runtimePackage,runtimeManifest,distributionGeneration}' in ('dsh-0.1.5-rc.3-a4c74a9','dsh-0.2.1-rc.2-687f282'))),false)
  else coalesce(origin->>'distributionGeneration' = manifest#>>'{runtimePackage,runtimeManifest,distributionGeneration}',false)
  end;
$$;
