import type {
  Employee,
  EmployeeProfile,
  Session,
  Workspace,
} from './chatflow-types';

export const employeeChoiceId = (employee: Employee) =>
  employee.instanceId ?? employee.id;
export const sessionEmployeeKey = (
  session: Pick<Session, 'employeeAssignmentId' | 'employeeInstanceId'>,
) => session.employeeInstanceId ?? session.employeeAssignmentId;

/** Keep assignment IDs as authorization IDs. A navigation choice is an
 * instance; older responses still expose one choice per assignment. */
export function employeeChoices(workspace: Workspace): Employee[] {
  return workspace.employees.flatMap((employee) =>
    employee.instances !== undefined
      ? employee.instances.map((instance) => ({
          ...employee,
          instanceId: instance.id,
          isDefault: employee.isDefault && instance.kind === 'general',
          currentVersion: {
            ...employee.currentVersion,
            manifest: {
              ...employee.currentVersion.manifest,
              ...(instance.profile.name ? { name: instance.profile.name } : {}),
              ...(instance.profile.description
                ? { description: instance.profile.description }
                : {}),
              ...(instance.profile.appearance
                ? { appearance: instance.profile.appearance }
                : {}),
            },
          },
        }))
      : [employee],
  );
}

export function employeeChoice(workspace: Workspace, id: string) {
  return employeeChoices(workspace).find(
    (employee) => employeeChoiceId(employee) === id,
  );
}

export function employeeChoiceProfile(
  workspace: Workspace,
  id?: string,
): EmployeeProfile | undefined {
  if (!id) return undefined;
  const employee = employeeChoice(workspace, id),
    base = workspace.employeeProfiles.find(
      (p) => p.assignmentId === (employee?.id ?? id),
    );
  if (!base) return undefined;
  const personal = employee?.instances?.find(
    (i) => i.id === employee.instanceId,
  )?.profile;
  if (!personal) return base;
  return {
    ...base,
    name: personal.name ?? base.name,
    description: personal.description ?? base.description,
    appearance: personal.appearance ?? base.appearance,
    identity: {
      ...base.identity,
      role: personal.role ?? base.identity.role,
      mission: personal.mission ?? base.identity.mission,
      workStyle: personal.workStyle ?? base.identity.workStyle,
    },
  };
}
