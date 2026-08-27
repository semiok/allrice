import { describe, expect, it } from 'vitest';

import {
  canAdministerEmployees,
  resolveEmployeeCapabilities,
  type FrozenSkillBinding,
} from './employeehub.js';
import type { RequestContext } from '@allrice/contracts';
import { randomUUID } from 'node:crypto';

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

  it('applies the employee deny list after Skill grants', () => {
    expect(
      resolveEmployeeCapabilities(
        ['model:invoke', 'network:outbound'],
        [binding],
        ['network:outbound'],
      ),
    ).toEqual(['model:invoke']);
  });

  it('keeps employee configuration behind an active workspace admin role', () => {
    const actorId = randomUUID();
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const context: RequestContext = {
      requestId: randomUUID(),
      sessionId: randomUUID(),
      actor: { type: 'user', id: actorId },
      organizationId,
      workspaceId,
      authenticatedAt: '2026-08-25T00:00:00.000Z',
      memberships: [
        {
          id: randomUUID(),
          userId: actorId,
          organizationId,
          workspaceId,
          role: 'admin',
          active: true,
        },
      ],
    };
    expect(canAdministerEmployees(context, workspaceId)).toBe(true);
    expect(
      canAdministerEmployees(
        {
          ...context,
          memberships: context.memberships.map((membership) => ({
            ...membership,
            role: 'member',
          })),
        },
        workspaceId,
      ),
    ).toBe(false);
  });
});
