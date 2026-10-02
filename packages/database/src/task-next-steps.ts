import {
  EmployeeManifestSchema,
  TaskNextStepsInputSchema,
  type RequestContext,
  type TaskNextStepsInput,
  type Visibility,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { listWorkbenchArtifacts } from './artifact-review.ts';
import { projectTaskNextSteps } from './task-next-steps-projector.ts';

/** Uses existing Session/artifact ownership and the effective next-turn employee
 * version. No frozen Run, Session version, grants or publication is rewritten. */
export async function readTaskNextSteps(
  context: RequestContext,
  raw: TaskNextStepsInput,
  db = getDatabase(),
) {
  const input = TaskNextStepsInputSchema.parse(raw);
  if (
    context.actor.type !== 'user' ||
    context.workspaceId !== input.workspaceId
  )
    throw new DataAccessError('authorization_denied');
  async function basis() {
    return db.begin('isolation level repeatable read read only', async (tx) => {
      const [employee] = await tx<
        { manifest: unknown; employee_id: string }[]
      >`select v.manifest,a.employee_id
        from allrice_chat_sessions s
        join allrice_employee_assignments a on a.id=s.employee_assignment_id and a.organization_id=s.organization_id and a.workspace_id=s.workspace_id and a.user_id=s.owner_id and a.active
        join allrice_employee_versions v on v.id=a.employee_version_id and v.employee_id=a.employee_id and v.organization_id=a.organization_id and v.workspace_id=a.workspace_id
        join allrice_employees e on e.id=a.employee_id and e.status='active'
        join allrice_users u on u.id=s.owner_id and u.status='active'
        join allrice_organizations org on org.id=s.organization_id and org.archived_at is null
        join allrice_workspaces w on w.id=s.workspace_id and w.organization_id=org.id and w.archived_at is null
        where s.id=${input.sessionId} and s.organization_id=${context.organizationId} and s.workspace_id=${input.workspaceId} and s.owner_id=${context.actor.id}
          and a.id=${input.employeeAssignmentId} and a.employee_version_id=${input.employeeVersionId}
          and exists(select 1 from allrice_memberships m where m.organization_id=s.organization_id and m.user_id=s.owner_id and m.active and (m.workspace_id is null or m.workspace_id=s.workspace_id))
          and not exists(select 1 from allrice_platform_employee_tenant_assignments d where d.tenant_employee_id=a.employee_id and d.organization_id=a.organization_id and d.workspace_id=a.workspace_id and not d.active)`;
      if (!employee) throw new DataAccessError('not_found');
      const [row] = await tx<
        { id: string; state: string; error_code: string | null }[]
      >`select r.id,r.state,r.error_code from allrice_employee_runs er join allrice_runs r on r.id=er.run_id and r.organization_id=er.organization_id and r.workspace_id=er.workspace_id and r.owner_id=er.owner_id where er.session_id=${input.sessionId} and er.organization_id=${context.organizationId} and er.workspace_id=${input.workspaceId} and er.owner_id=${context.actor.id} order by r.created_at desc,r.id desc limit 1`;
      const run = row
        ? { id: row.id, state: row.state, errorCode: row.error_code }
        : null;
      const [publication] = await tx<
        { bridge_access: string | null }[]
      >`select r.definition#>>'{securityPolicy,bridgeAccess}' as bridge_access from allrice_platform_employee_tenant_assignments p join allrice_platform_employee_revisions r on r.id=p.revision_id and r.employee_id=p.employee_id where p.organization_id=${context.organizationId} and p.workspace_id=${input.workspaceId} and p.tenant_employee_id=${employee.employee_id} and p.tenant_employee_version_id=${input.employeeVersionId} and p.active and r.status='published' limit 1`;
      const unknown = run
        ? await tx`select id from allrice_runtime_operations where (run_id=${run.id} or root_run_id=${run.id}) and organization_id=${context.organizationId} and workspace_id=${input.workspaceId} and snapshot->>'status'='unknown' limit 1`
        : [];
      const errors = run
        ? await tx<
            { reason: string }[]
          >`select distinct reason from allrice_audit_events where organization_id=${context.organizationId} and workspace_id=${input.workspaceId} and actor_id=${context.actor.id} and action='tool.execute' and decision='denied' and metadata->>'runId'=${run.id} order by reason limit 20`
        : [];
      const readable = run
        ? await tx<
            { id: string; visibility: Visibility }[]
          >`select o.id,o.visibility from allrice_storage_objects o join allrice_deliverable_versions v on v.object_id=o.id and v.owner_id=o.owner_id and v.organization_id=o.organization_id and v.workspace_id=o.workspace_id join allrice_workbench_artifacts a on a.version_id=v.id and a.organization_id=v.organization_id and a.workspace_id=v.workspace_id and a.owner_id=v.owner_id and a.run_id=${run.id} where v.session_id=${input.sessionId} and o.owner_id=${context.actor.id} and o.organization_id=${context.organizationId} and o.workspace_id=${input.workspaceId} and not exists(select 1 from allrice_deliverable_versions newer where newer.series_id=v.series_id and newer.owner_id=v.owner_id and newer.organization_id=v.organization_id and newer.workspace_id=v.workspace_id and newer.version>v.version) and o.state='ready' and o.deleted_at is null and (o.retention_until is null or o.retention_until>clock_timestamp()) and exists(select 1 from allrice_file_references f where f.object_id=o.id and f.session_id=v.session_id and f.owner_id=o.owner_id and f.organization_id=o.organization_id and f.workspace_id=o.workspace_id) order by v.created_at desc,v.id desc limit 50`
        : [];
      return {
        scope: {
          ...input,
          organizationId: context.organizationId,
          viewerId: context.actor.id,
        },
        manifest: EmployeeManifestSchema.parse(employee.manifest),
        run,
        unknown: !!unknown.length,
        errorCodes: errors.map((e) => e.reason),
        artifacts: [],
        visibility: Object.fromEntries(
          readable.map((o) => [o.id, o.visibility]),
        ),
        bridgePreparationAllowed:
          publication?.bridge_access === 'read_only' ||
          publication?.bridge_access === 'read_write',
      };
    });
  }
  const first = await basis();
  const { artifacts } = first.run
    ? await listWorkbenchArtifacts(context, input.sessionId, undefined, db)
    : { artifacts: [] };
  // Recheck authority/current turn after the separate mature artifact read.
  const current = await basis();
  return projectTaskNextSteps({
    ...current,
    artifacts: current.run?.id === first.run?.id ? artifacts : [],
  });
}
