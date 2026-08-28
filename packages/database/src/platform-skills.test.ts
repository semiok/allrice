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
});
