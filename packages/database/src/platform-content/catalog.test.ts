import { describe, expect, it } from 'vitest';

import {
  loadPlatformContentCatalog,
  parsePlatformContentCatalog,
  parseSkillMarkdown,
} from './catalog.js';

describe('platform content catalog', () => {
  it('loads every current production Skill from its canonical source file', async () => {
    const catalog = await loadPlatformContentCatalog();

    expect(catalog.skills).toHaveLength(11);
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
    ]);
    expect(catalog.skills.every((skill) => skill.content.endsWith('\n'))).toBe(
      true,
    );
  });

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
