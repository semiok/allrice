import { describe, expect, it } from 'vitest';
import { ProjectWorkspaceToolInputSchema } from '@allrice/contracts';

import {
  loadPlatformContentCatalog,
  parsePlatformContentCatalog,
  parseSkillMarkdown,
} from './catalog.js';

describe('platform content catalog', () => {
  it('keeps the stable Workflow guidance loadable after retiring textual method dependencies', async () => {
    const { skills } = await loadPlatformContentCatalog();
    const skill = skills.find((s) => s.name === 'employee-customization')!;
    expect(skill).toMatchObject({
      id: 'bf08fedb-c962-466f-a42f-36a397174cec',
      version: '3.0.0',
      enabled: true,
      modelInvocable: true,
      userInvocable: true,
      requiredToolRefs: [],
    });
    expect(skill.sourceRef).toContain(skill.checksum.slice(7));
    for (const text of [
      '一个场景对应一个完整包',
      '确认修改并生效',
      '没有第二次发布',
      '262,144 UTF-8 bytes',
      '准确的 `/<name>`',
      '/allrice-scene-<UUID>',
      '准确 `contentRef`',
      '不因保存新版而改写',
      '不授予权限',
      '不执行包内脚本',
      '以该环境实际发布为准',
      '确认不得重新抓取并替换该输入',
      '原请求和参数回读同一次回执',
      '来源已撤销的版本不能恢复',
      '不再接受新增、改写、恢复或重新启用',
      '待本人确认的记忆候选',
    ])
      expect(skill.content).toContain(text);
    for (const text of [
      '8,000 字符',
      '## 后台既有工作方法',
      'workspace_employee_method_inspect',
      'workspace_employee_method_save_candidate',
      'workspace_employee_method_restore_candidate',
    ])
      expect(skill.content).not.toContain(text);
  });

  it('validates the shipped project delivery example with the production project contract', async () => {
    const catalog = await loadPlatformContentCatalog();
    const skill = catalog.skills.find((s) => s.name === 'project-development')!;
    const resource = skill.bundle!.resources.find(
      (r) => r.path === 'references/delivery.md',
    )!;
    const markdown = Buffer.from(resource.contentBase64, 'base64').toString(
      'utf8',
    );
    const example = markdown.match(/```json\n([\s\S]*?)\n```/)![1]!;
    const resolved = example
      .replaceAll('$PROJECT_ID', '00000000-0000-4000-8000-000000000001')
      .replaceAll('$SNAPSHOT_ID', '00000000-0000-4000-8000-000000000002')
      .replaceAll(
        '$BASELINE_SNAPSHOT_ID',
        '00000000-0000-4000-8000-000000000003',
      )
      .replaceAll('$SNAPSHOT_CHECKSUM', `sha256:${'a'.repeat(64)}`)
      .replaceAll('$BASELINE_SNAPSHOT_CHECKSUM', `sha256:${'b'.repeat(64)}`);
    const command = ProjectWorkspaceToolInputSchema.parse(JSON.parse(resolved));
    expect(command.action).toBe('deliver');
    expect(skill.requiredToolRefs).toEqual([
      'workspace.project',
      'workspace.skill.read',
    ]);
  });
  it('loads every current production Skill from its canonical source file', async () => {
    const catalog = await loadPlatformContentCatalog();

    expect(catalog.skills).toHaveLength(15);
    expect(catalog.skills.map((skill) => skill.name)).toEqual([
      'business-reconciliation',
      'web-research',
      'workspace-briefing',
      'wechat-research',
      'market-data',
      'research-synthesis',
      'governed-memory',
      'workflow-automation',
      'browser-research',
      'office',
      'project-development',
      'scientific-analysis',
      'operations-review',
      'employee-customization',
      'experience-consolidation',
    ]);
    expect(catalog.skills.every((skill) => skill.content.endsWith('\n'))).toBe(
      true,
    );
  });

  it('loads the enabled Office bundle with native document and export dependencies', async () => {
    const catalog = await loadPlatformContentCatalog();
    const office = catalog.skills.find((skill) => skill.name === 'office')!;
    expect(office.enabled).toBe(true);
    expect(catalog.skills.filter((skill) => skill.enabled)).toHaveLength(15);
    expect(office.requiredToolRefs).toEqual(
      expect.arrayContaining([
        'workspace.document.read',
        'workspace.export.create',
        'workspace.skill.read',
      ]),
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
