import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AddEmployeeModuleInputSchema,
  EmployeeModuleReleaseSchema,
} from './employee-modules.ts';
import { brandMediaModule, brandMediaRelease } from './brand-media-module.ts';

describe('published brand module 0.1.0 contract', () => {
  it('pins the complete declaration without promising unimplemented handlers', () => {
    const canonical = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([k, v]) => [k, canonical(v)]),
            )
          : value;
    const { digest, ...declaration } = brandMediaModule;
    expect(digest).toBe(
      'sha256:' +
        createHash('sha256')
          .update(JSON.stringify(canonical(declaration)))
          .digest('hex'),
    );
    expect(brandMediaRelease).toEqual({
      moduleId: 'allrice.brand-media',
      contractVersion: 1,
      contentVersion: '0.1.0',
      digest:
        'sha256:1f366168ecf5fa83834694ca2b72808ea6a43008c11cbdc2b592cfd7603be8c9',
    });
    for (const key of ['views', 'tools', 'skills', 'resources'] as const)
      expect(brandMediaModule[key]).toEqual([]);
    expect(EmployeeModuleReleaseSchema.parse(brandMediaRelease)).toEqual(
      brandMediaRelease,
    );
    expect(brandMediaModule.enablement.preinstalled).toBe(false);
  });
  it('accepts only a target, exact release and request identity, never client authorization', () => {
    const input = {
      workspaceId: '00000000-0000-4000-8000-000000000001',
      instanceId: '00000000-0000-4000-8000-000000000002',
      requestId: '00000000-0000-4000-8000-000000000003',
      release: brandMediaRelease,
    };
    expect(AddEmployeeModuleInputSchema.parse(input)).toEqual(input);
    for (const value of [
      { enabled: true },
      { actor: 'user' },
      { organizationId: input.workspaceId },
      { authority: 'workflow' },
    ])
      expect(
        AddEmployeeModuleInputSchema.safeParse({ ...input, ...value }).success,
      ).toBe(false);
    expect(
      EmployeeModuleReleaseSchema.safeParse({
        ...brandMediaRelease,
        contentVersion: 'latest',
      }).success,
    ).toBe(false);
  });
});
