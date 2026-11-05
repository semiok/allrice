import type { EmployeeInstanceSnapshot } from './employees.ts';

/** A display/Run projection of server-owned identity. Never pass a user name,
 * isDefault assignment choice, or model-supplied label as this identity.
 * Database writes additionally verify the immutable platform publication. */
export function isBaseRiceInstanceDefinition(
  instance: Pick<EmployeeInstanceSnapshot, 'kind' | 'source'>,
  employee: {
    key: string | undefined;
    versionId: string;
    definition: {
      schemaVersion?: number;
      key?: string;
      isDefaultRice?: boolean;
    };
  },
) {
  return (
    instance.kind === 'general' &&
    instance.source?.kind === 'platform' &&
    instance.source.employeeVersionId === employee.versionId &&
    employee.key === 'default-assistant' &&
    employee.definition.schemaVersion === 2 &&
    employee.definition.key === 'default-assistant' &&
    employee.definition.isDefaultRice === true
  );
}
