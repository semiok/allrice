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
 * The initiating private instance does not own shared content. */
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
  const current = await sharedEmployeeMethodTarget(
    context,
    instanceId,
    requested.scope,
    tx,
    requested.scope === 'department' ? requested.departmentId : undefined,
  );
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
  return sharedEmployeeMethodTarget(context, instanceId, 'department', tx);
}

export async function sharedEmployeeMethodTarget(
  context: Context,
  instanceId: string,
  scope: 'company' | 'department',
  tx: ContentTx,
  selectedDepartmentId?: string,
) {
  if (!context.workspaceId) throw new DataAccessError('authorization_denied');
  const principal = await readContentPrincipal(context, tx, true);
  const departmentId = selectedDepartmentId ?? principal?.departmentId ?? null;
  if (!principal?.writable || (scope === 'department' && !departmentId))
    throw new DataAccessError('authorization_denied');
  const ownership =
    scope === 'company'
      ? {
          scope: 'company' as const,
          organizationId: context.organizationId,
        }
      : {
          scope: 'department' as const,
          organizationId: context.organizationId,
          departmentId: departmentId!,
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
  const [organization] = await tx<
    { name: string }[]
  >`select name from allrice_organizations
    where id=${context.organizationId} and archived_at is null for share`;
  if (!organization) throw new DataAccessError('authorization_denied');
  const department =
    scope === 'department'
      ? (
          await tx<{ name: string }[]>`select name from allrice_departments
    where id=${departmentId} and organization_id=${context.organizationId} and archived_at is null for share`
        )[0]
      : undefined;
  if (scope === 'department' && !department)
    throw new DataAccessError('authorization_denied');
  const [row] = await tx<
    { id: string }[]
  >`select id from allrice_employee_content_sets
    where organization_id=${context.organizationId} and workspace_id=${context.workspaceId}
      and employee_id=${assignment.employee_id} and scope=${scope}
      and department_id is not distinct from ${scope === 'department' ? departmentId : null}::uuid`;
  const setId =
    row?.id ??
    employeeChatUuid(
      `employee-method-${scope}`,
      context.organizationId,
      context.workspaceId,
      assignment.employee_id,
      ...(scope === 'department' ? [departmentId!] : []),
    );
  const sharedTarget = EmployeeMethodSharedTargetSchema.parse({
    scope,
    setId,
    employeeId: assignment.employee_id,
    ...(scope === 'department' ? { departmentId: departmentId! } : {}),
  });
  return {
    setId,
    target: { kind: 'employee' as const, employeeId: assignment.employee_id },
    ownership,
    identitySeed: setId,
    sharedTarget,
    // Keep the established department snapshot shape stable. The immutable
    // binding digest only accepts JSON values, never optional undefined fields.
    audience:
      scope === 'company'
        ? {
            employeeName: assignment.name,
            organizationName: organization.name,
            organizationId: context.organizationId,
          }
        : {
            employeeName: assignment.name,
            departmentName: department!.name,
          },
  };
}

/** Choices are live authority, not a new grant. Company maintainers may select
 * any active department of this company; department maintainers only their own. */
export async function employeeMethodDepartmentChoices(
  context: Context,
  tx: ContentTx,
) {
  const principal = await readContentPrincipal(context, tx, true);
  if (!principal?.writable) throw new DataAccessError('authorization_denied');
  const departments =
    principal.maintenanceLevel === 'company'
      ? await tx<
          { id: string; name: string }[]
        >`select id,name from allrice_departments
        where organization_id=${context.organizationId} and archived_at is null order by name,id for share`
      : principal.maintenanceLevel === 'department' && principal.departmentId
        ? await tx<
            { id: string; name: string }[]
          >`select id,name from allrice_departments
          where id=${principal.departmentId} and organization_id=${context.organizationId} and archived_at is null for share`
        : [];
  return {
    departments: [...departments],
    ownDepartmentId: principal.departmentId,
  };
}
