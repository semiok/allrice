import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const migration = readFileSync(
  resolve(
    repositoryRoot,
    'packages/database/migrations/0052_foundational_dsh_skills.sql',
  ),
  'utf8',
);
const localizationMigration = readFileSync(
  resolve(
    repositoryRoot,
    'packages/database/migrations/0054_foundational_skill_chinese_descriptions.sql',
  ),
  'utf8',
);

function skillSource(name: string) {
  const source = readFileSync(
    resolve(repositoryRoot, 'skills', name, 'SKILL.md'),
    'utf8',
  );
  const match = source.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]+)$/);
  if (!match) throw new Error(`${name} has invalid SKILL.md frontmatter`);
  return { frontmatter: match[1] ?? '', body: match[2] ?? '' };
}

describe('foundational DSH-native Skills', () => {
  it.each([
    {
      name: 'web-research',
      requiredTools: ['web.search'],
    },
    {
      name: 'workspace-briefing',
      requiredTools: [
        'local.fs.list',
        'local.fs.search',
        'local.fs.read',
        'local.git.status',
        'local.git.diff',
      ],
    },
  ])(
    'keeps $name source and database seed aligned',
    ({ name, requiredTools }) => {
      const source = skillSource(name);
      const checksum = `sha256:${createHash('sha256').update(source.body).digest('hex')}`;

      expect(source.frontmatter).toContain(`name: ${name}`);
      expect(source.frontmatter).toMatch(/description: .+/);
      expect(source.body).not.toContain('TODO');
      expect(migration).toContain(`'${name}'`);
      expect(migration).toContain(source.body);
      expect(migration).toContain(`'${checksum}'`);
      for (const tool of requiredTools)
        expect(migration).toContain(`"${tool}"`);
    },
  );

  it.each([
    {
      name: 'web-research',
      summary:
        '使用获准的网页搜索研究最新公开信息，核验重要事实，并提供附有来源的综合结论。',
    },
    {
      name: 'workspace-briefing',
      summary:
        '检查当前已授权的本地工作区，根据其中的文件和 Git 状态生成有依据的工作简报。',
    },
  ])('publishes a Chinese summary for $name', ({ name, summary }) => {
    const source = skillSource(name);

    expect(source.frontmatter).toContain('description: ');
    expect(source.frontmatter).toMatch(/description: .*[一-鿿]/);
    expect(localizationMigration).toContain(`'${name}'`);
    expect(localizationMigration).toContain(`'${summary}'`);
  });
});
