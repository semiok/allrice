import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inspectWorkflowSkillPackage } from './workflow-skill-package.ts';
import type { SkillPackageSource } from '@allrice/contracts';
const body =
  '## 工作步骤\nRead assets/result.txt.\n## 交付内容\nA report.\n## 执行细节\nUse only the supplied data.';
const raw = (content = body, name = 'weekly-review') =>
  `---\nname: ${name}\ndescription: ${'d'.repeat(501)}\nwhenToUse: Weekly review\nmetadata: {displayName: Review, version: release-A}\n---\n${content}`;
const source: SkillPackageSource = {
  kind: 'zip',
  fileName: 'review.zip',
  originalChecksum: 'sha256:' + 'a'.repeat(64),
  byteLength: 100,
};
const files = (text = raw()) => [
  { path: 'SKILL.md', bytes: Buffer.from(text) },
  { path: 'assets/result.txt', bytes: Buffer.from('Exact\nresource') },
  {
    path: 'scripts/never-run.js',
    bytes: Buffer.from('throw new Error("must not execute");'),
  },
];
describe('native Workflow package framework', () => {
  it('retains native long names, arbitrary author versions, content and exact resources without execution', async () => {
    const value = await inspectWorkflowSkillPackage(
      files(raw(body, 'a'.repeat(100))),
      source,
      randomUUID(),
    );
    expect(value.file.scene.nativeName).toBe('a'.repeat(100));
    expect(value.frontmatter.metadata.version).toBe('release-A');
    expect(value.frontmatter.description).toHaveLength(501);
    expect(value.content).toBe(body);
    expect(value.stepsMarkdown).toBe('Read assets/result.txt.');
    expect(value.deliverablesMarkdown).toBe('A report.');
    expect('skillPackage' in value.file.procedure).toBe(true);
    if (!('skillPackage' in value.file.procedure)) throw new Error('fixture');
    expect(value.file.procedure.skillPackage.source).toEqual(source);
    expect(value.file.procedure.skillPackage.bundle.dependencies).toEqual([]);
    const resource = value.file.procedure.skillPackage.bundle.resources[0]!;
    expect(Buffer.from(resource.contentBase64, 'base64').toString()).toBe(
      'Exact\nresource',
    );
    expect(resource.checksum).toBe(
      'sha256:' + createHash('sha256').update('Exact\nresource').digest('hex'),
    );
  });
  it.each([
    raw().replace('whenToUse: Weekly review\n', ''),
    raw().replace('version: release-A', 'other: release-A'),
    raw(body.replace('## 工作步骤', '## Something else')),
    raw(body.replace('assets/result.txt', 'assets/missing.txt')),
    raw('```md\n' + body + '\n```'),
  ])(
    'rejects invalid author framework without treating it as ordinary Skill',
    async (text) => {
      await expect(
        inspectWorkflowSkillPackage(files(text), source, randomUUID()),
      ).rejects.toMatchObject({ code: 'workflow_invalid' });
    },
  );
  it('uses the same exact UTF-8 body boundary as ordinary Skills', async () => {
    const content =
      body + '\n' + 'x'.repeat(262144 - Buffer.byteLength(body + '\n'));
    expect(
      Buffer.byteLength(
        (
          await inspectWorkflowSkillPackage(
            files(raw(content)),
            source,
            randomUUID(),
          )
        ).content,
      ),
    ).toBe(262144);
    await expect(
      inspectWorkflowSkillPackage(
        files(raw(content + 'x')),
        source,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'workflow_invalid' });
  });
});
