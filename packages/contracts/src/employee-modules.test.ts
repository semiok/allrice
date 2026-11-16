import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AddEmployeeModuleInputSchema,
  EmployeeModuleReleaseSchema,
} from './employee-modules.ts';
import {
  brandMediaModule,
  brandMediaModuleV010,
  brandMediaRelease,
  brandMediaUsage,
} from './brand-media-module.ts';
import { brandMediaTools } from './brand-media-tools.ts';

const legacyRelease = {
  moduleId: brandMediaModuleV010.id,
  contractVersion: brandMediaModuleV010.contractVersion,
  contentVersion: brandMediaModuleV010.contentVersion,
  digest: brandMediaModuleV010.digest,
};

describe('published brand module contracts', () => {
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
    const { digest, ...declaration } = brandMediaModuleV010;
    expect(digest).toBe(
      'sha256:' +
        createHash('sha256')
          .update(JSON.stringify(canonical(declaration)))
          .digest('hex'),
    );
    expect(legacyRelease).toEqual({
      moduleId: 'allrice.brand-media',
      contractVersion: 1,
      contentVersion: '0.1.0',
      digest:
        'sha256:1f366168ecf5fa83834694ca2b72808ea6a43008c11cbdc2b592cfd7603be8c9',
    });
    for (const key of ['views', 'tools', 'skills', 'resources'] as const)
      expect(brandMediaModuleV010[key]).toEqual([]);
    expect(EmployeeModuleReleaseSchema.parse(legacyRelease)).toEqual(
      legacyRelease,
    );
    expect(brandMediaModuleV010.enablement.preinstalled).toBe(false);
  });
  it('pins the new 0.2.0 declaration, exact guide bytes and complete tool schemas in its new digest', () => {
    expect(brandMediaRelease).toEqual({
      moduleId: 'allrice.brand-media',
      contractVersion: 1,
      contentVersion: '0.2.0',
      digest:
        'sha256:d046c03df459b988784776d31e7ebc750e57a67585b83f809bfba38e7c292afb',
    });
    expect(brandMediaModule.views).toEqual(['calendar', 'topics', 'articles']);
    expect(brandMediaModule.tools).toEqual([
      'workspace.brand_media.read',
      'workspace.brand_media.candidates',
      'workspace.brand_media.article.submit',
    ]);
    expect(brandMediaModule.skills).toEqual(['brand-media']);
    const guideDigest =
      'sha256:' +
      createHash('sha256').update(brandMediaUsage.content).digest('hex');
    expect(brandMediaUsage.checksum).toBe(guideDigest);
    expect(brandMediaModule.resources).toEqual([
      { path: 'references/usage.md', checksum: guideDigest },
    ]);
    const material = {
      descriptor: { ...brandMediaModule, digest: undefined },
      tools: brandMediaTools.map(({ input, output, ...tool }) => ({
        ...tool,
        input: z.toJSONSchema(input, { io: 'input' }),
        output: z.toJSONSchema(output, { io: 'input' }),
      })),
    };
    expect(brandMediaModule.digest).toBe(
      'sha256:' +
        createHash('sha256').update(JSON.stringify(material)).digest('hex'),
    );
    expect(brandMediaModule.digest).not.toBe(legacyRelease.digest);
    expect(EmployeeModuleReleaseSchema.parse(brandMediaRelease)).toEqual(
      brandMediaRelease,
    );
    expect(brandMediaModule.enablement.preinstalled).toBe(false);
  });
  it.each([legacyRelease, brandMediaRelease])(
    'accepts only a target, exact $contentVersion release and request identity, never client authorization',
    (release) => {
      const input = {
        workspaceId: '00000000-0000-4000-8000-000000000001',
        instanceId: '00000000-0000-4000-8000-000000000002',
        requestId: '00000000-0000-4000-8000-000000000003',
        release,
      };
      expect(AddEmployeeModuleInputSchema.parse(input)).toEqual(input);
      for (const value of [
        { enabled: true },
        { actor: 'user' },
        { organizationId: input.workspaceId },
        { authority: 'workflow' },
      ])
        expect(
          AddEmployeeModuleInputSchema.safeParse({ ...input, ...value })
            .success,
        ).toBe(false);
      expect(
        EmployeeModuleReleaseSchema.safeParse({
          ...release,
          contentVersion: 'latest',
        }).success,
      ).toBe(false);
    },
  );
});
