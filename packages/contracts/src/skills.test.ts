import { describe, expect, it } from 'vitest';

import { SkillArtifactBundleSchema } from './skills.js';

describe('Skill artifact contract', () => {
  it('accepts a unique SKILL.md and regular relative files', () => {
    expect(
      SkillArtifactBundleSchema.parse({
        schemaVersion: 1,
        entrypoint: 'SKILL.md',
        files: [
          { path: 'SKILL.md', content: '# Safe skill' },
          { path: 'references/source.md', content: 'source' },
        ],
      }).files,
    ).toHaveLength(2);
  });

  it.each(['../secret', '/etc/passwd', 'dir\\file'])(
    'rejects unsafe artifact path %s',
    (path) => {
      expect(() =>
        SkillArtifactBundleSchema.parse({
          schemaVersion: 1,
          entrypoint: 'SKILL.md',
          files: [
            { path: 'SKILL.md', content: '# Safe skill' },
            { path, content: 'unsafe' },
          ],
        }),
      ).toThrow();
    },
  );

  it('rejects duplicate files and a missing entrypoint', () => {
    expect(() =>
      SkillArtifactBundleSchema.parse({
        schemaVersion: 1,
        entrypoint: 'SKILL.md',
        files: [
          { path: 'SKILL.md', content: 'one' },
          { path: 'SKILL.md', content: 'two' },
        ],
      }),
    ).toThrow();
    expect(() =>
      SkillArtifactBundleSchema.parse({
        schemaVersion: 1,
        entrypoint: 'SKILL.md',
        files: [{ path: 'README.md', content: 'missing' }],
      }),
    ).toThrow();
  });
});
