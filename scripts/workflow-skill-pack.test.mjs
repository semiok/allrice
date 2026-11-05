import { execFileSync, spawnSync } from 'node:child_process';
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EmployeeContentTextSchema } from '../packages/contracts/src/employee-content.ts';
import { PersonalSceneFileSchema } from '../packages/contracts/src/personal-scene-files.ts';
import {
  skillBytesChecksum,
  validateSkillBundle,
} from '../packages/database/src/skill-bundles.ts';
import { validateSceneSkillPackage } from '../packages/database/src/employees/employee-scene-skill-package.ts';
import { packWorkflowSkill } from './workflow-skill-pack.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const example = join(repository, 'examples/workflow-skills/weekly-brief');
const sceneId = '10000000-0000-4000-8000-000000000001';
const ref = {
  sourceKind: 'knowledge',
  contentId: '20000000-0000-4000-8000-000000000001',
  revisionId: '20000000-0000-4000-8000-000000000002',
  digest: `sha256:${'a'.repeat(64)}`,
};
let root;
let directory;
const pack = () =>
  packWorkflowSkill({
    directory,
    sceneId,
    title: '本人方法',
  });
async function editBundle(edit) {
  const path = join(directory, 'bundle.json');
  const data = JSON.parse(await readFile(path, 'utf8'));
  edit(data);
  await writeFile(path, JSON.stringify(data));
}

beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'workflow-pack-test-'));
  directory = join(root, 'my-skill');
  await cp(example, directory, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('developer packs a native skill into C1 content without publishing', () => {
  it('keeps the complete brand-content example packable under the same author framework', async () => {
    const result = await packWorkflowSkill({
      directory: join(repository, 'examples/workflow-skills/brand-content'),
      sceneId,
      title: '品牌内容方法',
    });
    expect(result.procedure.skillPackage.frontmatter.metadata).toEqual({
      displayName: '品牌内容草稿',
      version: '1.0.0',
    });
    expect(result.procedure.skillPackage.bundle.resources).toHaveLength(5);
    expect(result.report.scriptsExecuted).toBe(false);
  });
  it('runs the documented CLI twice, returns identical C1 content and exact resource bytes', async () => {
    const args = [
      '--import',
      'tsx',
      'scripts/workflow-skill-pack.mjs',
      directory,
      '--scene-id',
      sceneId,
      '--title',
      '本人方法',
    ];
    const first = execFileSync(process.execPath, args, {
      cwd: repository,
      encoding: 'utf8',
    });
    expect(
      execFileSync(process.execPath, args, {
        cwd: repository,
        encoding: 'utf8',
      }),
    ).toBe(first);
    const result = JSON.parse(first);
    expect(PersonalSceneFileSchema.parse(result).scene.id).toBe(sceneId);
    const procedure = EmployeeContentTextSchema.parse(result.procedure);
    expect(procedure.kind).toBe('procedure');
    expect(procedure.title).toBe('本人方法');
    expect(result.scene.nativeName).toBe(`allrice-scene-${sceneId}`);
    expect(result.report.authorName).toBe('weekly-brief');
    expect(result.scene.name).toBe('我的周报草稿');
    expect(result.procedure.skillPackage.frontmatter).toMatchObject({
      name: 'weekly-brief',
      whenToUse: expect.any(String),
      metadata: { displayName: '我的周报草稿', version: '1.0.0' },
      invocation: { modelInvocable: true, userInvocable: true },
    });
    expect(result.report.nativeCommand).toBe(`/allrice-scene-${sceneId}`);
    expect(result.report.published).toBe(false);
    expect(result.report.scriptsExecuted).toBe(false);
    expect(first).not.toContain(root);
    validateSkillBundle(procedure.skillPackage.bundle, procedure.body);
    validateSceneSkillPackage(
      procedure.skillPackage,
      procedure.body,
      result.references,
    );
    for (const resource of procedure.skillPackage.bundle.resources) {
      expect(Buffer.from(resource.contentBase64, 'base64')).toEqual(
        await readFile(join(directory, resource.path)),
      );
    }
    expect(result.report.dependencies[0]).toMatchObject({
      name: 'workspace.skill.read',
      canonicalName: 'workspace.skill.read',
      risk: 'read_only',
    });
  });

  it('uses native multiline YAML and trimmed body, while preserving internal CRLF and resource bytes', async () => {
    await writeFile(
      join(directory, 'SKILL.md'),
      '---\r\nname: "my-review"\r\ndescription: >-\r\n  review the\r\n  supplied facts\r\nwhenToUse: weekly\r\nmetadata: { displayName: Review, version: v1 }\r\n---\r\n\r\n## 工作步骤\r\n\r\nbody\r\n\r\n## 交付内容\r\n\r\nresult\r\n\r\n## 执行细节\r\n\r\nprivate\r\n\r\n',
    );
    const bytes = Buffer.from([0, 255, 254, 13, 10]);
    await writeFile(join(directory, 'assets/example-input.json'), bytes);
    const result = await pack();
    expect(result.scene.appliesWhen).toBe('review the supplied facts');
    expect(result.procedure.body).toBe(
      '## 工作步骤\r\n\r\nbody\r\n\r\n## 交付内容\r\n\r\nresult\r\n\r\n## 执行细节\r\n\r\nprivate',
    );
    expect(result.report.contentChecksum).toBe(
      skillBytesChecksum(
        '## 工作步骤\r\n\r\nbody\r\n\r\n## 交付内容\r\n\r\nresult\r\n\r\n## 执行细节\r\n\r\nprivate',
      ),
    );
    expect(result.report.contentChecksum).not.toBe(
      result.report.skillFileChecksum,
    );
    expect(
      Buffer.from(
        result.procedure.skillPackage.bundle.resources[1].contentBase64,
        'base64',
      ),
    ).toEqual(bytes);
  });

  it('preserves native invocation and additional JSON metadata without inventing author versions', async () => {
    const input = await readFile(join(directory, 'SKILL.md'), 'utf8');
    await writeFile(
      join(directory, 'SKILL.md'),
      input
        .replace(
          'metadata:',
          'disable-model-invocation: true\nuser-invocable: false\nmetadata:',
        )
        .replace(
          '  version: 1.0.0',
          '  version: preview-2\n  additional: { nested: [1, true] }',
        ),
    );
    const result = await pack();
    expect(result.procedure.skillPackage.frontmatter).toMatchObject({
      invocation: { modelInvocable: false, userInvocable: false },
      metadata: { version: 'preview-2', additional: { nested: [1, true] } },
    });
    expect(result.procedure.skillPackage.bundle.version).toBe('1.0.0');
  });

  it.each(['whenToUse: ', 'metadata: { displayName: Example }'])(
    'rejects incomplete author fields: %s',
    async (fields) => {
      await writeFile(
        join(directory, 'SKILL.md'),
        `---\nname: review\ndescription: test\n${fields}\n---\n## 工作步骤\n## 交付内容\n## 执行细节`,
      );
      await expect(pack()).rejects.toThrow('该技能不符合 workflow 规范。');
    },
  );

  it('does not execute scripts or read undeclared files', async () => {
    const sentinel = join(root, 'executed');
    await writeFile(
      join(directory, 'scripts/check-example.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'executed'); throw Error('do not execute');`,
    );
    await writeFile(join(directory, '.env'), 'DO_NOT_PACKAGE=synthetic');
    const result = await pack();
    expect(JSON.stringify(result)).not.toContain('DO_NOT_PACKAGE');
    expect(result.report.scripts).toEqual(['scripts/check-example.mjs']);
    await expect(lstat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves declared controlled sources and rejects an undeclared resource source', async () => {
    const sources = {
      references: [ref],
      resourceSources: [
        { path: 'references/output-contract.md', references: [ref] },
      ],
    };
    await writeFile(join(directory, 'sources.json'), JSON.stringify(sources));
    const result = await pack();
    expect(result.references).toEqual([ref]);
    expect(result.procedure.skillPackage.resourceSources).toEqual(
      sources.resourceSources,
    );
    sources.references = [];
    await writeFile(join(directory, 'sources.json'), JSON.stringify(sources));
    await expect(pack()).rejects.toThrow(
      'each resource reference must be declared',
    );
  });

  it('rejects source bindings to resources absent from the package', async () => {
    await writeFile(
      join(directory, 'sources.json'),
      JSON.stringify({
        references: [ref],
        resourceSources: [{ path: 'assets/absent.txt', references: [ref] }],
      }),
    );
    await expect(pack()).rejects.toThrow('distinct package resources');
  });

  it.each(['unknown: value'])(
    'rejects unrepresentable frontmatter instead of dropping %s',
    async (field) => {
      await writeFile(
        join(directory, 'SKILL.md'),
        `---\nname: review\ndescription: test\n${field}\n---\nbody`,
      );
      await expect(pack()).rejects.toThrow('unsupported fields');
    },
  );

  it.each([
    [
      'missing delimiter',
      'name: review\ndescription: test\nbody',
      'frontmatter',
    ],
    [
      'invalid name',
      '---\nname: "not a name"\ndescription: test\n---\nbody',
      'native Provider rejected',
    ],
    [
      'duplicate YAML',
      '---\nname: review\nname: other\ndescription: test\n---\nbody',
      'invalid YAML',
    ],
    [
      'empty body',
      '---\nname: review\ndescription: test\n---\n  ',
      '该技能不符合 workflow 规范。',
    ],
  ])('reports %s', async (_label, input, message) => {
    await writeFile(join(directory, 'SKILL.md'), input);
    await expect(pack()).rejects.toThrow(message);
  });

  it('rejects invalid UTF-8 before native decoding can replace bytes', async () => {
    await writeFile(join(directory, 'SKILL.md'), Buffer.from([255]));
    await expect(pack()).rejects.toThrow('valid UTF-8');
  });

  it.each([
    '../secret',
    '/etc/passwd',
    'assets/../secret',
    'scripts/a\\b',
    'hooks/start.js',
  ])('rejects resource path %s before reading', async (path) => {
    await editBundle((bundle) => {
      bundle.resources[0].path = path;
    });
    await expect(pack()).rejects.toThrow('bundle.json resources.0');
  });

  it.each([
    'SKILL.md',
    'bundle.json',
    'references',
    'assets/example-input.json',
    'sources.json',
  ])('rejects symlink %s', async (path) => {
    const target = join(directory, path);
    await rm(target, { force: true, recursive: true });
    await symlink(
      path === 'references' ? example : join(example, 'SKILL.md'),
      target,
    );
    await expect(pack()).rejects.toThrow('symbolic links');
  });

  it('verifies optional declared hashes, including native body and packed bundle', async () => {
    const expected = (await pack()).procedure.skillPackage.bundle;
    await editBundle((bundle) => {
      bundle.checksum = expected.checksum;
      bundle.contentChecksum = expected.contentChecksum;
      bundle.resources.forEach((resource, index) => {
        resource.checksum = expected.resources[index].checksum;
        resource.byteLength = expected.resources[index].byteLength;
      });
    });
    expect((await pack()).procedure.skillPackage.bundle).toEqual(expected);
    await writeFile(join(directory, 'assets/example-input.json'), 'changed');
    await expect(pack()).rejects.toThrow('assets/example-input.json: checksum');
  });

  it.each(['checksum', 'contentChecksum'])(
    'rejects wrong %s',
    async (field) => {
      await editBundle((bundle) => {
        bundle[field] = `sha256:${'0'.repeat(64)}`;
      });
      await expect(pack()).rejects.toThrow(`bundle.json ${field}`);
    },
  );

  it('rejects unknown tool dependencies with no dependency installation', async () => {
    await editBundle((bundle) => {
      bundle.dependencies = [{ kind: 'tool', name: 'not.real' }];
    });
    await expect(pack()).rejects.toThrow('skill_bundle_unknown_tool');
  });

  it('enforces existing C1 body and resource limits', async () => {
    await writeFile(
      join(directory, 'SKILL.md'),
      `---\nname: review\ndescription: test\nwhenToUse: weekly\nmetadata: { displayName: Review, version: v1 }\n---\n## 工作步骤\n${'x'.repeat(8001)}\n## 交付内容\nresult\n## 执行细节\ndetails`,
    );
    await expect(pack()).rejects.toThrow('C1 procedure');
    await cp(join(example, 'SKILL.md'), join(directory, 'SKILL.md'));
    await writeFile(
      join(directory, 'assets/example-input.json'),
      Buffer.alloc(131073),
    );
    await expect(pack()).rejects.toThrow('C1 resource limit');
  });

  it('rejects duplicate resource paths using existing C1 validation', async () => {
    await editBundle((bundle) => {
      bundle.resources.push(bundle.resources[0]);
    });
    await expect(pack()).rejects.toThrow('skill_bundle_duplicate_path');
  });

  it('validates the explicit scene mapping and procedure title', async () => {
    await expect(
      packWorkflowSkill({
        directory,
        sceneId: 'wrong',
        title: 'test',
      }),
    ).rejects.toThrow('scene mapping');
    await expect(
      packWorkflowSkill({ directory, sceneId, title: '' }),
    ).rejects.toThrow('C1 procedure');
  });

  it('CLI reports a located error with nonzero exit and no JSON on stdout', async () => {
    await editBundle((bundle) => {
      bundle.resources[0].checksum = `sha256:${'0'.repeat(64)}`;
    });
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/workflow-skill-pack.mjs',
        directory,
        '--scene-id',
        sceneId,
        '--title',
        'test',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('references/output-contract.md: checksum');
  });
});
