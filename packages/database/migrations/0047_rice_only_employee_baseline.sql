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

delete from allrice_workflow_artifacts artifact
using allrice_workflow_runs workflow_run, allrice_legacy_employees legacy
where artifact.organization_id = workflow_run.organization_id
  and artifact.workspace_id = workflow_run.workspace_id
  and artifact.workflow_run_id = workflow_run.id
  and workflow_run.organization_id = legacy.organization_id
  and workflow_run.workspace_id = legacy.workspace_id
  and workflow_run.employee_id = legacy.id;

delete from allrice_workflow_evaluations evaluation
using allrice_workflow_runs workflow_run, allrice_legacy_employees legacy
where evaluation.organization_id = workflow_run.organization_id
  and evaluation.workspace_id = workflow_run.workspace_id
  and evaluation.workflow_run_id = workflow_run.id
  and workflow_run.organization_id = legacy.organization_id
  and workflow_run.workspace_id = legacy.workspace_id
  and workflow_run.employee_id = legacy.id;

delete from allrice_workflow_step_runs step_run
using allrice_workflow_runs workflow_run, allrice_legacy_employees legacy
where step_run.organization_id = workflow_run.organization_id
  and step_run.workspace_id = workflow_run.workspace_id
  and step_run.workflow_run_id = workflow_run.id
  and workflow_run.organization_id = legacy.organization_id
  and workflow_run.workspace_id = legacy.workspace_id
  and workflow_run.employee_id = legacy.id;

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

create temporary table allrice_legacy_assignments on commit drop as
select assignment.organization_id, assignment.workspace_id, assignment.id
from allrice_employee_assignments assignment
join allrice_legacy_employees legacy
  on legacy.organization_id = assignment.organization_id
 and legacy.workspace_id = assignment.workspace_id
 and legacy.id = assignment.employee_id;

create temporary table allrice_legacy_sessions on commit drop as
select session.organization_id, session.workspace_id, session.id
from allrice_chat_sessions session
join allrice_legacy_assignments assignment
  on assignment.organization_id = session.organization_id
 and assignment.workspace_id = session.workspace_id
 and assignment.id = session.employee_assignment_id;

create temporary table allrice_legacy_runs on commit drop as
select employee_run.organization_id, employee_run.workspace_id,
  employee_run.run_id as id
from allrice_employee_runs employee_run
join allrice_legacy_assignments assignment
  on assignment.organization_id = employee_run.organization_id
 and assignment.workspace_id = employee_run.workspace_id
 and assignment.id = employee_run.employee_assignment_id;

create temporary table allrice_legacy_messages on commit drop as
select message.organization_id, message.workspace_id, message.id
from allrice_messages message
join allrice_legacy_sessions session
  on session.organization_id = message.organization_id
 and session.workspace_id = message.workspace_id
 and session.id = message.session_id;

delete from allrice_run_feedback feedback
using allrice_legacy_runs legacy
where feedback.organization_id = legacy.organization_id
  and feedback.workspace_id = legacy.workspace_id
  and feedback.run_id = legacy.id;

drop trigger allrice_employee_run_steps_no_delete
  on allrice_employee_run_steps;
drop trigger allrice_employee_runs_no_delete on allrice_employee_runs;

delete from allrice_employee_run_steps step
using allrice_legacy_runs legacy
where step.organization_id = legacy.organization_id
  and step.workspace_id = legacy.workspace_id
  and step.run_id = legacy.id;

delete from allrice_employee_runs employee_run
using allrice_legacy_runs legacy
where employee_run.organization_id = legacy.organization_id
  and employee_run.workspace_id = legacy.workspace_id
  and employee_run.run_id = legacy.id;

create trigger allrice_employee_runs_no_delete
before delete on allrice_employee_runs
for each row execute function allrice_reject_employee_run_evidence_mutation();

create trigger allrice_employee_run_steps_no_delete
before delete on allrice_employee_run_steps
for each row execute function allrice_reject_employee_run_evidence_mutation();

delete from allrice_context_checkpoints checkpoint
using allrice_legacy_sessions legacy
where checkpoint.organization_id = legacy.organization_id
  and checkpoint.workspace_id = legacy.workspace_id
  and checkpoint.session_id = legacy.id;

delete from allrice_conversation_commands command
using allrice_legacy_sessions legacy
where command.organization_id = legacy.organization_id
  and command.workspace_id = legacy.workspace_id
  and command.session_id = legacy.id;

delete from allrice_conversation_followups followup
using allrice_legacy_sessions legacy
where followup.organization_id = legacy.organization_id
  and followup.workspace_id = legacy.workspace_id
  and followup.session_id = legacy.id;

delete from allrice_conversation_runtimes runtime
using allrice_legacy_sessions legacy
where runtime.organization_id = legacy.organization_id
  and runtime.workspace_id = legacy.workspace_id
  and runtime.session_id = legacy.id;

delete from allrice_dsh_runtime_instances runtime
using allrice_legacy_sessions legacy
where runtime.organization_id = legacy.organization_id
  and runtime.workspace_id = legacy.workspace_id
  and runtime.session_id = legacy.id;

delete from allrice_file_references reference
using allrice_legacy_sessions legacy
where reference.organization_id = legacy.organization_id
  and reference.workspace_id = legacy.workspace_id
  and reference.session_id = legacy.id;

delete from allrice_session_model_snapshots snapshot
using allrice_legacy_sessions legacy
where snapshot.organization_id = legacy.organization_id
  and snapshot.workspace_id = legacy.workspace_id
  and snapshot.session_id = legacy.id;

delete from allrice_message_attachments attachment
using allrice_legacy_messages legacy
where attachment.organization_id = legacy.organization_id
  and attachment.workspace_id = legacy.workspace_id
  and attachment.message_id = legacy.id;

delete from allrice_automation_runs automation_run
using allrice_legacy_sessions legacy
where automation_run.organization_id = legacy.organization_id
  and automation_run.workspace_id = legacy.workspace_id
  and automation_run.session_id = legacy.id;

delete from allrice_automations automation
using allrice_legacy_assignments legacy
where automation.organization_id = legacy.organization_id
  and automation.workspace_id = legacy.workspace_id
  and automation.employee_assignment_id = legacy.id;

delete from allrice_approval_requests approval
using allrice_legacy_runs legacy
where approval.organization_id = legacy.organization_id
  and approval.workspace_id = legacy.workspace_id
  and approval.run_id = legacy.id;

delete from allrice_connector_calls connector_call
using allrice_legacy_runs legacy
where connector_call.organization_id = legacy.organization_id
  and connector_call.workspace_id = legacy.workspace_id
  and connector_call.run_id = legacy.id;

delete from allrice_jobs job
using allrice_legacy_runs legacy
where job.organization_id = legacy.organization_id
  and job.workspace_id = legacy.workspace_id
  and job.run_id = legacy.id;

delete from allrice_route_decisions decision
using allrice_legacy_runs legacy
where decision.organization_id = legacy.organization_id
  and decision.workspace_id = legacy.workspace_id
  and decision.run_id = legacy.id;

delete from allrice_run_events event
using allrice_legacy_runs legacy
where event.organization_id = legacy.organization_id
  and event.workspace_id = legacy.workspace_id
  and event.run_id = legacy.id;

delete from allrice_messages message
using allrice_legacy_sessions legacy
where message.organization_id = legacy.organization_id
  and message.workspace_id = legacy.workspace_id
  and message.session_id = legacy.id;

delete from allrice_chat_sessions session
using allrice_legacy_sessions legacy
where session.organization_id = legacy.organization_id
  and session.workspace_id = legacy.workspace_id
  and session.id = legacy.id;

delete from allrice_runs run
using allrice_legacy_runs legacy
where run.organization_id = legacy.organization_id
  and run.workspace_id = legacy.workspace_id
  and run.id = legacy.id;

delete from allrice_employee_assignments assignment
using allrice_legacy_assignments legacy
where assignment.organization_id = legacy.organization_id
  and assignment.workspace_id = legacy.workspace_id
  and assignment.id = legacy.id;

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
