import { describe, expect, it } from 'vitest';

import {
  canAdministerEmployees,
  nativeSkillCapabilityGrants,
  resolveEmployeeCapabilities,
} from './employeehub.js';
import type { RequestContext } from '@allrice/contracts';
import { randomUUID } from 'node:crypto';

describe('Rice capability intersection', () => {
  const webResearch = {
    requiredToolRefs: ['web.search'],
  };

  it('honors explicitly selected tools without requiring an unrelated Skill, and keeps explicit denials', () => {
    expect(
      resolveEmployeeCapabilities(
        ['model:invoke', 'storage:write', 'network:outbound'],
        [],
        [],
        ['local.process.execute', 'web.search'],
      ),
    ).toEqual(['model:invoke', 'storage:write', 'network:outbound']);
    expect(
      resolveEmployeeCapabilities(
        ['model:invoke', 'storage:write'],
        [],
        ['storage:write'],
        ['local.process.execute'],
      ),
    ).toEqual(['model:invoke']);
    expect(
      resolveEmployeeCapabilities(
        ['model:invoke', 'storage:write'],
        [],
        [],
        ['unknown.tool'],
      ),
    ).toEqual(['model:invoke']);
  });

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
        [webResearch],
      ),
    ).toEqual(['model:invoke', 'storage:read', 'network:outbound']);
  });

  it('lets a bound DSH-native Skill grant only the capability implied by its reviewed tools', () => {
    expect(nativeSkillCapabilityGrants(['web.search'])).toEqual([
      'network:outbound',
    ]);
    expect(
      nativeSkillCapabilityGrants([
        'local.fs.list',
        'local.fs.read',
        'unknown.tool',
      ]),
    ).toEqual(['storage:read']);
    expect(
      nativeSkillCapabilityGrants([
        'workspace.memory.search',
        'workspace.memory.remember',
      ]),
    ).toEqual(['storage:write']);
    expect(
      nativeSkillCapabilityGrants(['local.fs.write', 'local.fs.mkdir']),
    ).toEqual(['storage:write']);
    expect(
      resolveEmployeeCapabilities(
        ['model:invoke', 'storage:read', 'network:outbound'],
        [webResearch],
      ),
    ).toEqual(['model:invoke', 'storage:read', 'network:outbound']);
  });

  it('never lets a skill expand capabilities outside the employee manifest', () => {
    expect(
      resolveEmployeeCapabilities(['model:invoke'], [webResearch]),
    ).toEqual(['model:invoke']);
    expect(
      resolveEmployeeCapabilities(
        ['model:invoke', 'network:outbound'],
        [{ requiredToolRefs: ['local.fs.read'] }],
      ),
    ).toEqual(['model:invoke']);
  });

  it('applies the employee deny list after Skill grants', () => {
    expect(
      resolveEmployeeCapabilities(
        ['model:invoke', 'network:outbound'],
        [webResearch],
        ['network:outbound'],
      ),
    ).toEqual(['model:invoke']);
    expect(
      resolveEmployeeCapabilities(
        ['model:invoke', 'storage:write'],
        [{ requiredToolRefs: ['workspace.memory.remember'] }],
        ['storage:write'],
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
