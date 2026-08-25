import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  FrameworkRolloutPolicySchema,
  resolveFrameworkRollout,
} from './framework.ts';

describe('framework rollout', () => {
  it('supports an emergency rollback independently of configured scopes', () => {
    const policy = FrameworkRolloutPolicySchema.parse({
      schemaVersion: 1,
      emergencyOff: true,
      defaultEnabled: true,
    });
    expect(resolveFrameworkRollout(policy, { surface: 'workspace' })).toBe(
      false,
    );
  });

  it('canaries by tenant, employee revision and product surface', () => {
    const organizationId = randomUUID();
    const employeeVersionId = randomUUID();
    const policy = FrameworkRolloutPolicySchema.parse({
      schemaVersion: 1,
      organizationIds: [organizationId],
      employeeVersionIds: [employeeVersionId],
      surfaces: ['workspace'],
    });
    expect(
      resolveFrameworkRollout(policy, {
        organizationId,
        employeeVersionId,
        surface: 'workspace',
      }),
    ).toBe(true);
    expect(
      resolveFrameworkRollout(policy, {
        organizationId,
        employeeVersionId,
        surface: 'employees',
      }),
    ).toBe(false);
  });
});
