create temporary table allrice_legacy_employees on commit drop as
select organization_id, workspace_id, id
from allrice_employees
where employee_key <> 'default-assistant';

delete from allrice_employee_dsh_skill_bindings binding
using allrice_legacy_employees legacy
where binding.organization_id = legacy.organization_id
  and binding.workspace_id = legacy.workspace_id
  and binding.employee_id = legacy.id;

delete from allrice_employee_agent_skill_bindings binding
using allrice_legacy_employees legacy
where binding.organization_id = legacy.organization_id
  and binding.workspace_id = legacy.workspace_id
  and binding.employee_id = legacy.id;

delete from allrice_employee_workflow_bindings binding
using allrice_legacy_employees legacy
where binding.organization_id = legacy.organization_id
  and binding.workspace_id = legacy.workspace_id
  and binding.employee_id = legacy.id;

delete from allrice_employee_knowledge_bindings binding
using allrice_legacy_employees legacy
where binding.organization_id = legacy.organization_id
  and binding.workspace_id = legacy.workspace_id
  and binding.employee_id = legacy.id;

delete from allrice_employee_model_policies policy
using allrice_legacy_employees legacy
where policy.organization_id = legacy.organization_id
  and policy.workspace_id = legacy.workspace_id
  and policy.employee_id = legacy.id;

delete from allrice_employee_user_profiles profile
using allrice_legacy_employees legacy
where profile.organization_id = legacy.organization_id
  and profile.workspace_id = legacy.workspace_id
  and profile.employee_id = legacy.id;

delete from allrice_employee_eval_runs eval_run
using allrice_legacy_employees legacy
where eval_run.organization_id = legacy.organization_id
  and eval_run.workspace_id = legacy.workspace_id
  and eval_run.employee_id = legacy.id;

delete from allrice_employee_eval_suites suite
using allrice_legacy_employees legacy
where suite.organization_id = legacy.organization_id
  and suite.workspace_id = legacy.workspace_id
  and suite.employee_id = legacy.id;

delete from allrice_employee_releases release
using allrice_legacy_employees legacy
where release.organization_id = legacy.organization_id
  and release.workspace_id = legacy.workspace_id
  and release.employee_id = legacy.id;

delete from allrice_route_decisions decision
using allrice_legacy_employees legacy
where decision.organization_id = legacy.organization_id
  and decision.workspace_id = legacy.workspace_id
  and decision.employee_id = legacy.id;

delete from allrice_session_model_snapshots snapshot
using allrice_legacy_employees legacy
where snapshot.organization_id = legacy.organization_id
  and snapshot.workspace_id = legacy.workspace_id
  and snapshot.employee_id = legacy.id;

delete from allrice_workflow_runs workflow_run
using allrice_legacy_employees legacy
where workflow_run.organization_id = legacy.organization_id
  and workflow_run.workspace_id = legacy.workspace_id
  and workflow_run.employee_id = legacy.id;

delete from allrice_memories memory
using allrice_legacy_employees legacy
where memory.organization_id = legacy.organization_id
  and memory.workspace_id = legacy.workspace_id
  and memory.employee_id = legacy.id;

-- The removed built-in employees were never assigned or executed. Refuse to
-- silently destroy evidence if an environment does contain such history.
do $$
begin
  if exists (
    select 1
    from allrice_employee_assignments assignment
    join allrice_legacy_employees legacy
      on legacy.organization_id = assignment.organization_id
     and legacy.workspace_id = assignment.workspace_id
     and legacy.id = assignment.employee_id
  ) then
    raise exception 'cannot reset a legacy employee that has assignments';
  end if;
end;
$$;

drop trigger allrice_employee_versions_no_delete on allrice_employee_versions;

delete from allrice_employee_versions version
using allrice_legacy_employees legacy
where version.organization_id = legacy.organization_id
  and version.workspace_id = legacy.workspace_id
  and version.employee_id = legacy.id;

create trigger allrice_employee_versions_no_delete
before delete on allrice_employee_versions
for each row execute function allrice_reject_employee_version_delete();

delete from allrice_employees employee
using allrice_legacy_employees legacy
where employee.organization_id = legacy.organization_id
  and employee.workspace_id = legacy.workspace_id
  and employee.id = legacy.id;

insert into allrice_runtime_metadata (key, value)
values (
  'employee-catalog-baseline',
  '{"version":"0047","employees":["Rice"],"migrationMode":"fresh-only"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
