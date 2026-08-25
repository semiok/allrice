import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  capabilityChecksum,
  resolveEffectiveKnowledgeAcl,
} from './capability-registry.js';

describe('Capability Registry foundations', () => {
  it('uses a canonical checksum independent of object key order', () => {
    expect(capabilityChecksum({ b: 2, a: { d: 4, c: 3 } })).toBe(
      capabilityChecksum({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  it('intersects Knowledge ACL with tenant, employee and actor identity', () => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const employeeId = randomUUID();
    const actorId = randomUUID();
    const otherUserId = randomUUID();
    const effective = resolveEffectiveKnowledgeAcl(
      [
        {
          principalType: 'workspace',
          principalId: workspaceId,
          permission: 'read',
        },
        {
          principalType: 'employee',
          principalId: employeeId,
          permission: 'read',
        },
        {
          principalType: 'user',
          principalId: actorId,
          permission: 'admin',
        },
        {
          principalType: 'user',
          principalId: otherUserId,
          permission: 'read',
        },
      ],
      { organizationId, workspaceId, employeeId, actorId },
    );
    expect(effective).toHaveLength(3);
    expect(effective.some((entry) => entry.principalId === otherUserId)).toBe(
      false,
    );
  });

  it('never treats a similarly named ID from another tenant as authorized', () => {
    const context = {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      employeeId: randomUUID(),
      actorId: randomUUID(),
    };
    expect(
      resolveEffectiveKnowledgeAcl(
        [
          {
            principalType: 'organization',
            principalId: randomUUID(),
            permission: 'read',
          },
        ],
        context,
      ),
    ).toEqual([]);
  });
});
