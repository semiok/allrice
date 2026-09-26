import { describe, expect, it } from 'vitest';

import {
  loadPlatformContentCatalog,
  parsePlatformContentCatalog,
  parseSkillMarkdown,
} from './catalog.js';

describe('platform content catalog', () => {
  it('loads every current production Skill from its canonical source file', async () => {
    const catalog = await loadPlatformContentCatalog();

    expect(catalog.skills).toHaveLength(13);
    expect(catalog.skills.map((skill) => skill.name)).toEqual([
      'business-reconciliation',
      'web-research',
      'workspace-briefing',
      'wechat-research',
      'document-analysis',
      'market-data',
      'research-synthesis',
      'structured-deliverable',
      'governed-memory',
      'workflow-automation',
      'browser-research',
      'office',
      'development-cooperation',
    ]);
    expect(catalog.skills.every((skill) => skill.content.endsWith('\n'))).toBe(
      true,
    );
  });

  it('keeps legacy content available while replacing both choices with one enabled Office bundle', async () => {
    const catalog = await loadPlatformContentCatalog();
    const office = catalog.skills.find((skill) => skill.name === 'office')!;
    const legacy = catalog.skills.filter((skill) =>
      office.replaces?.includes(skill.id),
    );
    expect(office.enabled).toBe(true);
    expect(legacy.map((skill) => skill.name)).toEqual([
      'document-analysis',
      'structured-deliverable',
    ]);
    expect(legacy.every((skill) => !skill.enabled)).toBe(true);
    expect(catalog.skills.filter((skill) => skill.enabled)).toHaveLength(11);
    expect(office.requiredToolRefs).toEqual(
      expect.arrayContaining(legacy.flatMap((skill) => skill.requiredToolRefs)),
    );
    expect(office.bundle?.resources.map((resource) => resource.path)).toEqual(
      expect.arrayContaining([
        'references/docx.md',
        'references/xlsx.md',
        'references/pptx.md',
        'references/provenance.md',
        'references/LICENSE.dsh',
      ]),
    );
  });

  it.each([
    'missing',
    'self',
    'active-source',
    'inactive-target',
    'ambiguous',
  ] as const)(
    'rejects %s replacement declarations before accepting a catalog',
    async (kind) => {
      const catalog = await loadPlatformContentCatalog();
      const office = catalog.skills.find((skill) => skill.name === 'office')!;
      const previous = catalog.skills.find((skill) =>
        office.replaces?.includes(skill.id),
      )!;
      if (kind === 'missing')
        office.replaces = ['00000000-0000-4000-8000-000000000000'];
      if (kind === 'self') office.replaces = [office.id];
      if (kind === 'active-source') previous.enabled = true;
      if (kind === 'inactive-target') office.enabled = false;
      if (kind === 'ambiguous') catalog.skills[0]!.replaces = [previous.id];
      await expect(
        parsePlatformContentCatalog(catalog, async () => {
          throw Error('unexpected_asset_read');
        }),
      ).rejects.toThrow('platform_skill_catalog_invalid_replacement:');
    },
  );

  it('canonicalizes harmless outer whitespace before checksumming content', () => {
    const parsed = parseSkillMarkdown(
      '---\nname: sample\ndescription: Sample Skill\n---\n\n# Sample\n\n',
      'sample',
    );

    expect(parsed.content).toBe('# Sample\n');
    expect(parsed.checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('rejects catalog metadata when the reviewed content checksum drifts', async () => {
    const declaredChecksum = `sha256:${'0'.repeat(64)}`;
    await expect(
      parsePlatformContentCatalog(
        {
          schemaVersion: 1,
          skills: [
            {
              id: '10000000-0000-4000-8000-000000000001',
              name: 'sample',
              contentFile: 'skills/sample/SKILL.md',
              version: '1.0.0',
              checksum: declaredChecksum,
              source: 'allrice',
              sourceRef: `https://github.com/semiok/allrice/tree/main/skills/sample?content-sha256=${declaredChecksum.slice(7)}`,
              license: 'Apache-2.0',
              reviewStatus: 'reviewed',
              reviewedByLabel: 'test',
              createdByLabel: 'test',
              modelInvocable: true,
              userInvocable: true,
              requiredToolRefs: [],
              enabled: true,
            },
          ],
        },
        async () =>
          '---\nname: sample\ndescription: Sample Skill\n---\n\n# Sample\n',
      ),
    ).rejects.toThrow('platform_skill_catalog_checksum_mismatch:sample');
  });

  it('requires an immutable content digest in every source reference', async () => {
    const markdown =
      '---\nname: sample\ndescription: Sample Skill\n---\n\n# Sample\n';
    const checksum = parseSkillMarkdown(markdown, 'sample').checksum;

    await expect(
      parsePlatformContentCatalog(
        {
          schemaVersion: 1,
          skills: [
            {
              id: '10000000-0000-4000-8000-000000000001',
              name: 'sample',
              contentFile: 'skills/sample/SKILL.md',
              version: '1.0.0',
              checksum,
              source: 'allrice',
              sourceRef:
                'https://github.com/semiok/allrice/tree/main/skills/sample',
              license: 'Apache-2.0',
              reviewStatus: 'reviewed',
              reviewedByLabel: 'test',
              createdByLabel: 'test',
              modelInvocable: true,
              userInvocable: true,
              requiredToolRefs: [],
              enabled: true,
            },
          ],
        },
        async () => markdown,
      ),
    ).rejects.toThrow(
      'platform_skill_catalog_source_ref_not_content_addressed:sample',
    );
  });

  it('rejects tool dependencies outside the canonical Tool Manifest', async () => {
    const content = '# Sample\n';
    const checksum = parseSkillMarkdown(
      '---\nname: sample\ndescription: Sample Skill\n---\n\n# Sample\n',
      'sample',
    ).checksum;

    await expect(
      parsePlatformContentCatalog(
        {
          schemaVersion: 1,
          skills: [
            {
              id: '10000000-0000-4000-8000-000000000001',
              name: 'sample',
              contentFile: 'skills/sample/SKILL.md',
              version: '1.0.0',
              checksum,
              source: 'allrice',
              sourceRef: `https://github.com/semiok/allrice/tree/main/skills/sample?content-sha256=${checksum.slice(7)}`,
              license: 'Apache-2.0',
              reviewStatus: 'reviewed',
              reviewedByLabel: 'test',
              createdByLabel: 'test',
              modelInvocable: true,
              userInvocable: true,
              requiredToolRefs: ['not.a.real.tool'],
              enabled: true,
            },
          ],
        },
        async () =>
          `---\nname: sample\ndescription: Sample Skill\n---\n\n${content}`,
      ),
    ).rejects.toThrow('platform_skill_catalog_unknown_tool:sample');
  });
});
