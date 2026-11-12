import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ReferencePublishInputSchema,
  ReferencePublicationActionSchema,
} from './reference-library.ts';

describe('independent reference publication commands', () => {
  const base = {
    workspaceId: randomUUID(),
    requestId: randomUUID(),
    origin: 'file',
    objectId: randomUUID(),
    audience: { scope: 'company', departmentIds: [] },
  };
  it('normalizes exact IDs and the complete multi-department set, without accepting role or owner assertions', () => {
    const departments = [randomUUID(), randomUUID()];
    const parsed = ReferencePublishInputSchema.parse({
      ...base,
      objectId: base.objectId.toUpperCase(),
      audience: {
        scope: 'departments',
        departmentIds: departments.map((id) => id.toUpperCase()).reverse(),
      },
    });
    expect(parsed).toMatchObject({
      objectId: base.objectId,
      audience: {
        scope: 'departments',
        departmentIds: [...departments].sort(),
      },
    });
    for (const extra of [
      { ownerId: randomUUID() },
      { sourceId: randomUUID() },
      { approved: true },
      { role: 'admin' },
    ])
      expect(
        ReferencePublishInputSchema.safeParse({ ...base, ...extra }).success,
      ).toBe(false);
    for (const audience of [
      { scope: 'departments', departmentIds: [] },
      {
        scope: 'departments',
        departmentIds: [departments[0], departments[0]!.toUpperCase()],
      },
      { scope: 'company', departmentIds: departments },
      { scope: 'platform', departmentIds: [] },
    ])
      expect(
        ReferencePublishInputSchema.safeParse({ ...base, audience }).success,
      ).toBe(false);
  });
  it('separates scope changes from irreversible withdrawal and accepts no version/restore command', () => {
    const action = {
      workspaceId: base.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 1,
    };
    expect(
      ReferencePublicationActionSchema.parse({
        ...action,
        action: 'audience',
        audience: base.audience,
      }),
    ).toMatchObject({ action: 'audience' });
    for (const name of ['revoke', 'delete'])
      expect(
        ReferencePublicationActionSchema.parse({ ...action, action: name })
          .action,
      ).toBe(name);
    for (const extra of [
      { action: 'restore' },
      { action: 'archive' },
      { action: 'delete', audience: base.audience },
      { action: 'audience' },
    ])
      expect(
        ReferencePublicationActionSchema.safeParse({ ...action, ...extra })
          .success,
      ).toBe(false);
  });
});
