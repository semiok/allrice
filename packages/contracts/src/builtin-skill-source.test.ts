import { describe, expect, it } from 'vitest';
import {
  BuiltinSkillSourceResourceQuerySchema,
  BuiltinSkillSourceSelectorSchema,
} from './index.ts';

const selector = {
  id: '10000000-0000-4000-8000-000000000001',
  version: '1.2.3',
  contentChecksum: `sha256:${'a'.repeat(64)}`,
  bundleChecksum: `sha256:${'b'.repeat(64)}`,
};
describe('builtin Skill source selectors', () => {
  it('requires an explicit bundle pin or explicit absence, without defaults', () => {
    expect(BuiltinSkillSourceSelectorSchema.parse(selector)).toEqual(selector);
    expect(
      BuiltinSkillSourceSelectorSchema.parse({
        ...selector,
        bundleChecksum: null,
      }),
    ).toEqual({ ...selector, bundleChecksum: null });
    for (const field of Object.keys(selector)) {
      const incomplete = Object.fromEntries(
        Object.entries(selector).filter(([key]) => key !== field),
      );
      expect(
        BuiltinSkillSourceSelectorSchema.safeParse(incomplete).success,
      ).toBe(false);
    }
    expect(
      BuiltinSkillSourceSelectorSchema.safeParse({
        ...selector,
        bundleChecksum: undefined,
      }).success,
    ).toBe(false);
  });

  it.each(['personId', 'tenantId', 'employeeId', 'approved', 'absolutePath'])(
    'rejects %s instead of treating it as source authority',
    (field) => {
      expect(
        BuiltinSkillSourceSelectorSchema.safeParse({
          ...selector,
          [field]: '/private/not-a-source',
        }).success,
      ).toBe(false);
    },
  );

  it('keeps the existing UUID, version, checksum and resource path formats', () => {
    for (const invalid of [
      { id: 'office' },
      { version: 'latest' },
      { contentChecksum: 'sha256:abc' },
      { bundleChecksum: `sha256:${'A'.repeat(64)}` },
    ])
      expect(
        BuiltinSkillSourceSelectorSchema.safeParse({ ...selector, ...invalid })
          .success,
      ).toBe(false);
    const query = {
      ...selector,
      path: 'references/charts.md',
      checksum: `sha256:${'c'.repeat(64)}`,
    };
    expect(BuiltinSkillSourceResourceQuerySchema.parse(query)).toEqual(query);
    for (const path of [
      '/tmp/charts.md',
      '../charts.md',
      'references/../x',
      'x',
    ])
      expect(
        BuiltinSkillSourceResourceQuerySchema.safeParse({ ...query, path })
          .success,
      ).toBe(false);
    expect(
      BuiltinSkillSourceResourceQuerySchema.safeParse({
        ...query,
        checksum: undefined,
      }).success,
    ).toBe(false);
  });
});
