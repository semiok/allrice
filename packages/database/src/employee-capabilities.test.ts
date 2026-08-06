import { describe, expect, it } from 'vitest';

import {
  resolveEmployeeCapabilities,
  type FrozenSkillBinding,
} from './employeehub.js';

describe('Rice capability intersection', () => {
  const binding: FrozenSkillBinding = {
    installationId: '00000000-0000-4000-8000-000000000001',
    skillVersionId: '00000000-0000-4000-8000-000000000002',
    declaredCapabilities: ['model:invoke', 'network:outbound'],
    grantedCapabilities: ['model:invoke', 'network:outbound'],
  };

  it('keeps core employee capabilities but gates network behind a bound skill', () => {
    expect(
      resolveEmployeeCapabilities(
        ['model:invoke', 'storage:read', 'network:outbound'],
        [],
      ),
    ).toEqual(['model:invoke', 'storage:read']);
    expect(
      resolveEmployeeCapabilities(
        ['model:invoke', 'storage:read', 'network:outbound'],
        [binding],
      ),
    ).toEqual(['model:invoke', 'storage:read', 'network:outbound']);
  });

  it('never lets a skill expand capabilities outside the employee manifest', () => {
    expect(resolveEmployeeCapabilities(['model:invoke'], [binding])).toEqual([
      'model:invoke',
    ]);
    expect(
      resolveEmployeeCapabilities(
        ['model:invoke', 'network:outbound'],
        [{ ...binding, declaredCapabilities: ['model:invoke'] }],
      ),
    ).toEqual(['model:invoke']);
  });
});
