-- Keep Agent Skill bindings correct while Web and Worker roll independently.
-- Legacy Web processes still publish Skill selections only inside the employee
-- manifest. Until the new service has explicitly managed an employee's Skill
-- bindings, these triggers mirror the latest manifest into the binding table.

alter table allrice_employees
  add column skill_bindings_managed_at timestamptz;

create function allrice_sync_legacy_employee_agent_skills(
  target_organization_id uuid,
  target_workspace_id uuid,
  target_employee_id uuid,
  fallback_actor_id uuid
)
returns void language plpgsql as $$
declare
  managed_at timestamptz;
begin
  select e.skill_bindings_managed_at into managed_at
  from allrice_employees e
  where e.organization_id = target_organization_id
    and e.workspace_id = target_workspace_id
    and e.id = target_employee_id;

  if managed_at is not null or fallback_actor_id is null then
    return;
  end if;

  update allrice_employee_agent_skill_bindings
  set enabled = false, updated_at = now()
  where organization_id = target_organization_id
    and workspace_id = target_workspace_id
    and employee_id = target_employee_id;

  insert into allrice_employee_agent_skill_bindings (
    organization_id, workspace_id, employee_id, installation_id,
    skill_version_id, granted_capabilities, enabled, bound_by, bound_at
  )
  select
    target_organization_id, target_workspace_id, target_employee_id,
    installation.id, version.id, installation.granted_capabilities,
    true, fallback_actor_id, now()
  from (
    select employee_version.manifest
    from allrice_employee_versions employee_version
    where employee_version.organization_id = target_organization_id
      and employee_version.workspace_id = target_workspace_id
      and employee_version.employee_id = target_employee_id
    order by employee_version.version desc
    limit 1
  ) current_version
  join lateral jsonb_array_elements_text(
    coalesce(current_version.manifest -> 'skillVersionIds', '[]'::jsonb)
  ) selected(skill_version_id) on true
  join allrice_skill_versions version
    on selected.skill_version_id ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   and version.id = selected.skill_version_id::uuid
   and version.organization_id = target_organization_id
   and version.workspace_id = target_workspace_id
  join allrice_skill_installations installation
    on installation.pinned_version_id = version.id
   and installation.organization_id = version.organization_id
   and installation.workspace_id = version.workspace_id
   and installation.owner_id is null
   and installation.enabled
  on conflict (organization_id, workspace_id, employee_id, skill_version_id)
  do update set installation_id = excluded.installation_id,
    granted_capabilities = excluded.granted_capabilities,
    enabled = true, bound_by = excluded.bound_by,
    bound_at = excluded.bound_at, updated_at = now();
end;
$$;

create function allrice_sync_legacy_skills_after_employee_version()
returns trigger language plpgsql as $$
declare
  actor_id uuid;
begin
  select coalesce(assignment.assigned_by, assignment.user_id)
    into actor_id
  from allrice_employee_assignments assignment
  where assignment.organization_id = new.organization_id
    and assignment.workspace_id = new.workspace_id
    and assignment.employee_id = new.employee_id
  order by assignment.active desc, assignment.assigned_at, assignment.id
  limit 1;

  perform allrice_sync_legacy_employee_agent_skills(
    new.organization_id, new.workspace_id, new.employee_id, actor_id
  );
  return new;
end;
$$;

create trigger allrice_employee_version_legacy_skill_rollout
after insert on allrice_employee_versions
for each row execute function allrice_sync_legacy_skills_after_employee_version();

create function allrice_sync_legacy_skills_after_assignment()
returns trigger language plpgsql as $$
begin
  perform allrice_sync_legacy_employee_agent_skills(
    new.organization_id,
    new.workspace_id,
    new.employee_id,
    coalesce(new.assigned_by, new.user_id)
  );
  return new;
end;
$$;

create trigger allrice_employee_assignment_legacy_skill_rollout
after insert or update of employee_version_id on allrice_employee_assignments
for each row execute function allrice_sync_legacy_skills_after_assignment();

insert into allrice_runtime_metadata (key, value)
values (
  'agent-skill-binding-rollout',
  '{"version":"0022","issue":"MET-68","legacyManifestMirror":true,"newBindingAuthority":"explicit"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
