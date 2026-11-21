-- MET-271: host native-create provenance on the existing 4.0 business Session.
-- No Run/Job, legacy native origin, VM authority or Agent state is synthesized.
-- A claim is only an immutable at-most-once dispatch fact, NOT creation success.
-- Commit ACK must precede native create. Unknown commit/result is never retried;
-- no running/failed/retry state, TTL or automatic recovery is added.
set local lock_timeout = '15s';
alter table allrice_chat_sessions add column d_entry_native_root_claim jsonb;
alter table allrice_chat_sessions add column d_entry_native_root jsonb;

create function allrice_d_entry_native_root_guard() returns trigger language plpgsql as $$
declare claim jsonb;
begin
  if tg_op='INSERT' then
    if new.d_entry_native_root is not null or new.d_entry_native_root_claim is not null then
      raise exception 'D entry root requires host creation after business Session' using errcode='23514';
    end if;
    return new;
  end if;
  if old.d_entry_native_root is not null then
    if new.d_entry_native_root is distinct from old.d_entry_native_root
      or new.organization_id is distinct from old.organization_id
      or new.workspace_id is distinct from old.workspace_id
      or new.owner_id is distinct from old.owner_id
      or coalesce(new.employee_instance_id,new.employee_assignment_id) is distinct from coalesce(old.employee_instance_id,old.employee_assignment_id)
      or new.id is distinct from old.id then
      raise exception 'D entry native root is immutable' using errcode='23514';
    end if;
  end if;
  if old.d_entry_native_root_claim is not null then
    if new.d_entry_native_root_claim is distinct from old.d_entry_native_root_claim
      or new.organization_id is distinct from old.organization_id
      or new.workspace_id is distinct from old.workspace_id
      or new.owner_id is distinct from old.owner_id
      or coalesce(new.employee_instance_id,new.employee_assignment_id) is distinct from coalesce(old.employee_instance_id,old.employee_assignment_id)
      or new.id is distinct from old.id then
      raise exception 'D entry native creation claim is immutable' using errcode='23514';
    end if;
  end if;
  if new.d_entry_native_root is distinct from old.d_entry_native_root then
    if old.d_entry_native_root_claim is null
      or (new.d_entry_native_root - 'nativeSessionId') is distinct from old.d_entry_native_root_claim
      or nullif(new.d_entry_native_root->>'nativeSessionId','') is null then
      raise exception 'D entry native root requires its original creation claim' using errcode='23514';
    end if;
  end if;
  if new.d_entry_native_root_claim is not distinct from old.d_entry_native_root_claim then return new; end if;
  claim := new.d_entry_native_root_claim;
  if new.execution_generation<>'4.0' or new.native_root_origin is not null
    or jsonb_typeof(claim) is distinct from 'object'
    or claim->>'schemaVersion' is distinct from '1'
    or claim ? 'nativeSessionId'
    or claim#>>'{identity,organizationId}' is distinct from new.organization_id::text
    or claim#>>'{identity,workspaceId}' is distinct from new.workspace_id::text
    or claim#>>'{identity,personId}' is distinct from new.owner_id::text
    or claim#>>'{identity,threadId}' is distinct from new.id::text
    or claim#>>'{identity,employeeInstanceId}' is distinct from coalesce(new.employee_instance_id,new.employee_assignment_id)::text
    or claim#>>'{host,binding,organizationId}' is distinct from new.organization_id::text
    or claim#>>'{host,binding,personId}' is distinct from new.owner_id::text
    or nullif(claim#>>'{host,binding,vmId}','') is null
    or nullif(claim#>>'{host,binding,instanceId}','') is null
    or nullif(claim#>>'{host,binding,leaseEpoch}','') is null
    or nullif(claim#>>'{host,bindingRef}','') is null
    or nullif(claim#>>'{host,rosterDigest}','') is null
    or nullif(claim->>'releaseRevision','') is null
    or nullif(claim->>'operationId','') is null
    or not exists(select 1 from allrice_employee_instances i
      join allrice_employee_assignments a on a.id=i.assignment_id
      where i.id=coalesce(new.employee_instance_id,new.employee_assignment_id)
        and i.organization_id=new.organization_id and i.workspace_id=new.workspace_id and i.owner_id=new.owner_id
        and i.revision::text=claim#>>'{identity,employeeRevision}'
        and a.employee_version_id::text=claim#>>'{identity,employeeVersionId}') then
    raise exception 'D entry native creation claim scope mismatch' using errcode='23514';
  end if;
  return new;
end $$;
create trigger allrice_d_entry_native_root_guard before insert or update on allrice_chat_sessions
  for each row execute function allrice_d_entry_native_root_guard();

-- Native session ids are local to the persistent person-VM/employee profile.
-- Temporary instance/lease/bindingRef is birth provenance, NOT this uniqueness
-- key: a normal host restart must not repin or permit root aliasing.
create unique index allrice_d_entry_native_root_scope on allrice_chat_sessions
  (organization_id,workspace_id,owner_id,
   (coalesce(employee_instance_id,employee_assignment_id)),
   ((d_entry_native_root#>>'{host,binding,vmId}')),
   ((d_entry_native_root->>'nativeSessionId')))
  where d_entry_native_root is not null;

-- Invalidation hints only. PostgreSQL delivers at the SAME transaction's
-- commit and discards on rollback. Subscribers re-read actual authority; the
-- payload grants no rights and carries no token, email, profile or policy.
create function allrice_d_entry_authority_changed() returns trigger language plpgsql as $$
declare fact jsonb;
begin
  if tg_op='UPDATE' and new is not distinct from old then return null; end if;
  for fact in select distinct value from jsonb_array_elements(
    case when tg_op='INSERT' then jsonb_build_array(to_jsonb(new))
      when tg_op='DELETE' then jsonb_build_array(to_jsonb(old))
      else jsonb_build_array(to_jsonb(old),to_jsonb(new)) end)
  loop
    if tg_table_name='allrice_settings' and not (
      fact->>'scope_type'='system' and fact->>'scope_id' is null
      and fact->>'key'='d_entry_rollout_policy') then continue; end if;
    perform pg_notify('allrice_d_entry_authority', jsonb_build_object(
      'schema',tg_table_schema,'table',tg_table_name,'id',fact->>'id',
      'organizationId',fact->>'organization_id','workspaceId',fact->>'workspace_id',
      'personId',coalesce(fact->>'user_id',fact->>'owner_id'))::text);
  end loop;
  return null;
end $$;
create trigger allrice_d_entry_session_changed after delete or update of user_id,revoked_at,expires_at
  on allrice_sessions for each row execute function allrice_d_entry_authority_changed();
create trigger allrice_d_entry_user_changed after delete or update of status,email
  on allrice_users for each row execute function allrice_d_entry_authority_changed();
create trigger allrice_d_entry_membership_changed after insert or delete or update of active,role,user_id,organization_id,workspace_id
  on allrice_memberships for each row execute function allrice_d_entry_authority_changed();
create trigger allrice_d_entry_organization_changed after delete or update of archived_at
  on allrice_organizations for each row execute function allrice_d_entry_authority_changed();
create trigger allrice_d_entry_workspace_changed after delete or update of archived_at,organization_id
  on allrice_workspaces for each row execute function allrice_d_entry_authority_changed();
create trigger allrice_d_entry_instance_changed after delete or update of revision,profile,archived_at,assignment_id,owner_id,organization_id,workspace_id
  on allrice_employee_instances for each row execute function allrice_d_entry_authority_changed();
create trigger allrice_d_entry_assignment_changed after delete or update of active,employee_version_id,employee_id,user_id,organization_id,workspace_id
  on allrice_employee_assignments for each row execute function allrice_d_entry_authority_changed();
create trigger allrice_d_entry_employee_changed after delete or update of status
  on allrice_employees for each row execute function allrice_d_entry_authority_changed();
create trigger allrice_d_entry_deployment_changed after insert or delete or update
  on allrice_platform_employee_tenant_assignments for each row execute function allrice_d_entry_authority_changed();
create trigger allrice_d_entry_version_source_changed after insert or delete or update
  on allrice_employee_version_sources for each row execute function allrice_d_entry_authority_changed();
create trigger allrice_d_entry_publication_changed after delete or update of status
  on allrice_platform_employee_revisions for each row execute function allrice_d_entry_authority_changed();
create trigger allrice_d_entry_chat_changed after delete or update of archived_at,owner_id,organization_id,workspace_id,employee_instance_id,employee_assignment_id,employee_version_id
  on allrice_chat_sessions for each row execute function allrice_d_entry_authority_changed();
create trigger allrice_d_entry_policy_changed after insert or delete or update of scope_type,scope_id,key,value
  on allrice_settings for each row execute function allrice_d_entry_authority_changed();
