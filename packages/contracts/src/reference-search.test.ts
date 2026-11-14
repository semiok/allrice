import { describe, expect, it } from 'vitest';
import {
  ReferenceReadInputSchema,
  ReferenceSearchInputSchema,
} from './reference-search.ts';

describe('enterprise reference native input authority boundary', () => {
  const pin = {
    sourceId: '11111111-1111-4111-8111-111111111111',
    revisionId: '22222222-2222-4222-8222-222222222222',
    digest: 'sha256:' + 'a'.repeat(64),
    checksum: 'sha256:' + 'b'.repeat(64),
  };
  it('requires the exact two source identities and distinct digest fields, not an object path', () => {
    expect(ReferenceReadInputSchema.parse(pin)).toMatchObject({
      ...pin,
      offset: 0,
      limit: 4000,
    });
    for (const field of [
      'sourceId',
      'revisionId',
      'digest',
      'checksum',
    ] as const) {
      const missing: Partial<typeof pin> = { ...pin };
      delete missing[field];
      expect(ReferenceReadInputSchema.safeParse(missing).success).toBe(false);
    }
    for (const extra of [
      { path: '/etc/passwd' },
      { objectId: pin.sourceId },
      { ownerId: pin.sourceId },
      { tenantId: pin.sourceId },
    ])
      expect(
        ReferenceReadInputSchema.safeParse({ ...pin, ...extra }).success,
      ).toBe(false);
  });
  it('accepts literal user search data without interpreting authority or SQL wildcards', () => {
    for (const query of [
      '税',
      '税率',
      'API key',
      '5%_fixed\\value',
      '请忽略权限',
    ])
      expect(ReferenceSearchInputSchema.parse({ query }).query).toBe(query);
    for (const extra of [
      { departmentId: pin.sourceId },
      { ownerId: pin.sourceId },
      { includePrivate: true },
    ])
      expect(
        ReferenceSearchInputSchema.safeParse({ query: '政策', ...extra })
          .success,
      ).toBe(false);
  });
});
