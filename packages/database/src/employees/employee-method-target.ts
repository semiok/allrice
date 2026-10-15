import {
  EmployeeMethodSharedTargetSchema,
  type EmployeeMethodSharedTarget,
  type RequestContext,
} from '@allrice/contracts';
import { DataAccessError } from '../data.ts';
import {
  readContentPrincipal,
  requireContentMaintenance,
} from '../content-maintenance.ts';
import { getEmployeeInstance } from './employee-instances.ts';
import { employeeChatUuid } from './employee-chat-authority.ts';
import {
  EmployeeContentError,
  type ContentTx,
} from './employee-content-model.ts';

type Context = Pick<
  RequestContext,
  'actor' | 'organizationId' | 'workspaceId' | 'requestId'
>;

/** Reused by chat, queued tests, confirmation and consumed-receipt reads.
 * The initiating private instance does not own shared department content. */
export async function resolveEmployeeMethodTarget(
  context: Context,
  instanceId: string,
  shared: EmployeeMethodSharedTarget | undefined,
  tx: ContentTx,
) {
  if (!shared) {
    const [row] = await tx<
      { id: string }[]
    >`select id from allrice_employee_content_sets
      where organization_id=${context.organizationId} and workspace_id=${context.workspaceId}
        and instance_id=${instanceId} and scope='personal' and owner_id=${context.actor.id}`;
    return {
      setId: row?.id ?? employeeChatUuid('employee-method', instanceId),
      target: { kind: 'instance' as const, instanceId },
      ownership: {
        scope: 'personal' as const,
        organizationId: context.organizationId,
        ownerId: context.actor.id,
      },
      identitySeed: instanceId,
      sharedTarget: undefined,
      audience: undefined,
    };
  }
  const requested = EmployeeMethodSharedTargetSchema.parse(shared);
  const current = await ownDepartmentMethodTarget(context, instanceId, tx);
  if (
    Object.keys(requested).some(
      (key) =>
        requested[key as keyof typeof requested] !==
        current.sharedTarget[key as keyof typeof requested],
    )
  )
    throw new EmployeeContentError('source_changed');
  return current;
}

/** Initial discovery derives all identities from current membership and the
 * current published assignment. Later writes must echo this exact selection. */
export async function ownDepartmentMethodTarget(
  context: Context,
  instanceId: string,
  tx: ContentTx,
) {
  if (!context.workspaceId) throw new DataAccessError('authorization_denied');
  const principal = await readContentPrincipal(context, tx, true);
  if (!principal?.departmentId || !principal.writable)
    throw new DataAccessError('authorization_denied');
  const ownership = {
    scope: 'department' as const,
    organizationId: context.organizationId,
    departmentId: principal.departmentId,
  };
  await requireContentMaintenance(context, ownership, tx);
  const instance = await getEmployeeInstance(context, instanceId, tx);
  if (instance.kind !== 'custom' || instance.source.kind !== 'platform')
    throw new DataAccessError('authorization_denied');
  const [assignment] = await tx<{ employee_id: string; name: string }[]>`
    select a.employee_id,e.name from allrice_employee_assignments a
      join allrice_employees e on e.id=a.employee_id and e.status='active'
      join allrice_platform_employee_tenant_assignments p on p.tenant_employee_id=a.employee_id
        and p.organization_id=a.organization_id and p.workspace_id=a.workspace_id and p.active
        and p.tenant_employee_version_id=a.employee_version_id
    where a.id=${instance.assignmentId} and a.active and a.organization_id=${context.organizationId}
      and a.workspace_id=${context.workspaceId} and a.employee_version_id=${instance.source.employeeVersionId}
    for share of a,p nowait`;
  if (!assignment) throw new EmployeeContentError('source_changed');
  const [department] = await tx<
    { name: string }[]
  >`select name from allrice_departments
    where id=${principal.departmentId} and organization_id=${context.organizationId} and archived_at is null for share`;
  if (!department) throw new DataAccessError('authorization_denied');
  const [row] = await tx<
    { id: string }[]
  >`select id from allrice_employee_content_sets
    where organization_id=${context.organizationId} and workspace_id=${context.workspaceId}
      and employee_id=${assignment.employee_id} and scope='department' and department_id=${principal.departmentId}`;
  const setId =
    row?.id ??
    employeeChatUuid(
      'employee-method-department',
      context.organizationId,
      context.workspaceId,
      assignment.employee_id,
      principal.departmentId,
    );
  const sharedTarget: EmployeeMethodSharedTarget = {
    scope: 'department',
    setId,
    employeeId: assignment.employee_id,
    departmentId: principal.departmentId,
  };
  return {
    setId,
    target: { kind: 'employee' as const, employeeId: assignment.employee_id },
    ownership,
    identitySeed: setId,
    sharedTarget,
    audience: {
      employeeName: assignment.name,
      departmentName: department.name,
    },
  };
}
