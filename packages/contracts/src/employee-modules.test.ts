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
  brandMediaModuleV020,
  brandMediaUsageV020,
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
    const brandMediaModule = brandMediaModuleV020,
      brandMediaUsage = brandMediaUsageV020;
    const brandMediaRelease = {
      moduleId: brandMediaModule.id,
      contractVersion: brandMediaModule.contractVersion,
      contentVersion: brandMediaModule.contentVersion,
      digest: brandMediaModule.digest,
    };
    // Restore only the newly explicit upload-image union to its original exact
    // versioned branch. The pinned 0.2 digest below witnesses all old schemas.
    const oldImages = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(oldImages);
      if (!value || typeof value !== 'object') return value;
      const node = value as Record<string, unknown>;
      if (
        Array.isArray(node.anyOf) &&
        node.anyOf.length === 2 &&
        node.anyOf[1]?.properties?.origin?.const === 'upload' &&
        node.anyOf[0]?.properties?.source
      )
        return oldImages(node.anyOf[0]);
      return Object.fromEntries(
        Object.entries(node).map(([key, child]) => [key, oldImages(child)]),
      );
    };
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
        output: oldImages(z.toJSONSchema(output, { io: 'input' })),
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
  it('publishes 0.3.0 with exact current schemas and one versioned guide, without adding image aliases or changing 0.2 bytes', () => {
    expect(brandMediaRelease).toEqual({
      moduleId: 'allrice.brand-media',
      contractVersion: 1,
      contentVersion: '0.3.0',
      digest:
        'sha256:908f4b65d995fa7424468a1c64df32e78d7141ade5177e0d68fe6ed5b5d481c7',
    });
    expect(brandMediaModule.tools).toEqual(brandMediaModuleV020.tools);
    expect(
      brandMediaUsage.content.startsWith(brandMediaUsageV020.content),
    ).toBe(true);
    expect(brandMediaUsageV020.checksum).toBe(
      'sha256:cc6caaf412f3eb3e2148b86516ed4b2441b7dc707a504177a20ede5ae2d2e6ea',
    );
    expect(brandMediaUsage.checksum).toBe(
      'sha256:' +
        createHash('sha256').update(brandMediaUsage.content).digest('hex'),
    );
    expect(brandMediaModule.resources).toEqual([
      { path: brandMediaUsage.path, checksum: brandMediaUsage.checksum },
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
    expect(brandMediaModule.skills).toEqual(['brand-media']);
    expect(brandMediaModule.digest).not.toBe(brandMediaModuleV020.digest);
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
