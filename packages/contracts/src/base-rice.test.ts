import { describe, expect, it } from 'vitest';
import { isBaseRiceInstanceDefinition } from './base-rice.ts';
import type { EmployeeInstanceSnapshot } from './employees.ts';

const instance: Pick<EmployeeInstanceSnapshot, 'kind' | 'source'> = {
  kind: 'general',
  source: {
    kind: 'platform',
    employeeVersionId: 'version',
    templateId: 'rice',
    templateRevisionId: 'revision',
    templateRevision: 1,
    templateChecksum: 'sha256:' + 'a'.repeat(64),
  },
};
const employee = {
  key: 'default-assistant',
  versionId: 'version',
  definition: {
    schemaVersion: 2,
    key: 'default-assistant',
    isDefaultRice: true,
  },
};

describe('basic Rice identity projection', () => {
  it('requires matching instance kind, immutable source version and materialized definition identity', () => {
    expect(isBaseRiceInstanceDefinition(instance, employee)).toBe(true);
    expect(
      isBaseRiceInstanceDefinition({ ...instance, kind: 'custom' }, employee),
    ).toBe(false);
    expect(
      isBaseRiceInstanceDefinition(
        {
          ...instance,
          source: { kind: 'tenant_version', employeeVersionId: 'version' },
        },
        employee,
      ),
    ).toBe(false);
    for (const changed of [
      { ...employee, key: 'professional' },
      { ...employee, versionId: 'other-version' },
      {
        ...employee,
        definition: { ...employee.definition, key: 'professional' },
      },
      {
        ...employee,
        definition: { ...employee.definition, isDefaultRice: false },
      },
      { ...employee, definition: { ...employee.definition, schemaVersion: 1 } },
    ])
      expect(isBaseRiceInstanceDefinition(instance, changed)).toBe(false);
  });
});
