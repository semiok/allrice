import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPlatformContentCatalog } from './catalog.ts';
import { skillBundleChecksum, skillBytesChecksum } from '../skill-bundles.ts';

const temporary: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'allrice-skillbundle-'));
  temporary.push(directory);
  const skillDirectory = join(directory, 'skills/fixture-bundle');
  const content = '# Synthetic frozen resource fixture\n';
  const checksum = skillBytesChecksum(content);
  const sourceRef = `https://example.test/fixture?content-sha256=${checksum.slice(7)}`;
  const resources = [
    ['assets/sample.csv', 'id,value\n1,42\n', 'text/csv'],
    ['references/rules.txt', 'Synthetic instructions only.\n', 'text/plain'],
    [
      'scripts/sample.mjs',
      'throw Error("must never execute during assembly");\n',
      'text/javascript',
    ],
    ['assets/empty.txt', '', 'text/plain'],
  ].map(([path, text, mediaType]) => {
    const bytes = Buffer.from(text!);
    return {
      path: path!,
      mediaType: mediaType!,
      byteLength: bytes.length,
      checksum: skillBytesChecksum(bytes),
      contentBase64: bytes.toString('base64'),
    };
  });
  for (const folder of ['references', 'assets', 'scripts']) {
    await mkdir(join(skillDirectory, folder), { recursive: true });
  }
  for (const resource of resources) {
    await writeFile(
      join(skillDirectory, resource.path),
      Buffer.from(resource.contentBase64, 'base64'),
    );
  }
  const payload = {
    schemaVersion: 1 as const,
    version: '1.0.0',
    contentChecksum: checksum,
    sourceRef,
    license: 'Apache-2.0',
    reviewedBy: 'synthetic-reviewer',
    resources,
    dependencies: [{ kind: 'tool' as const, name: 'workspace.skill.read' }],
  };
  await writeFile(
    join(skillDirectory, 'SKILL.md'),
    `---\nname: fixture-bundle\ndescription: Synthetic only\n---\n${content}`,
  );
  await writeFile(
    join(skillDirectory, 'bundle.json'),
    JSON.stringify({
      ...payload,
      checksum: skillBundleChecksum(payload),
      resources: resources.map(({ contentBase64, ...resource }) => {
        expect(contentBase64).toBeTypeOf('string');
        return resource;
      }),
    }),
  );
  await writeFile(
    join(directory, 'skills/catalog.json'),
    JSON.stringify({
      schemaVersion: 2,
      skills: [
        {
          id: randomUUID(),
          name: 'fixture-bundle',
          contentFile: 'skills/fixture-bundle/SKILL.md',
          bundleFile: 'skills/fixture-bundle/bundle.json',
          version: '1.0.0',
          checksum,
          source: 'allrice',
          sourceRef,
          license: 'Apache-2.0',
          reviewStatus: 'reviewed',
          reviewedByLabel: 'synthetic-reviewer',
          createdByLabel: 'synthetic-test',
          modelInvocable: true,
          userInvocable: true,
          requiredToolRefs: ['workspace.skill.read'],
          enabled: true,
        },
      ],
    }),
  );
  return {
    directory,
    asset: join(directory, 'skills/fixture-bundle/assets/sample.csv'),
  };
}
afterEach(async () => {
  for (const path of temporary.splice(0)) {
    if (!path.startsWith(join(tmpdir(), 'allrice-skillbundle-')))
      throw Error('unsafe test cleanup');
    await rm(path, { recursive: true, force: true });
  }
});
describe('P18 real file assembly stays in reviewed resource tree', () => {
  it('loads exact resource bytes and checksums without executing the script', async () => {
    const f = await fixture(),
      catalog = await loadPlatformContentCatalog(f.directory);
    const skill = catalog.skills.find((s) => s.name === 'fixture-bundle')!;
    expect(skill.bundle?.resources).toHaveLength(4);
    expect(
      Buffer.from(
        skill.bundle!.resources.find((r) => r.path === 'assets/sample.csv')!
          .contentBase64,
        'base64',
      ),
    ).toEqual(await readFile(f.asset));
  });
  it('fails closed on resource content changes even if SKILL.md is unchanged', async () => {
    const f = await fixture();
    await writeFile(f.asset, 'tampered');
    await expect(loadPlatformContentCatalog(f.directory)).rejects.toThrow(
      'skill_bundle_checksum_mismatch',
    );
  });
  it('rejects symlinks and hardlinks rather than following paths outside the bundle', async () => {
    const f = await fixture();
    const outside = join(f.directory, 'private.csv');
    await writeFile(outside, await readFile(f.asset));
    await rm(f.asset);
    await symlink(outside, f.asset);
    await expect(loadPlatformContentCatalog(f.directory)).rejects.toThrow(
      'platform_skill_resource_symlink',
    );
    await rm(f.asset);
    await link(outside, f.asset);
    await expect(loadPlatformContentCatalog(f.directory)).rejects.toThrow(
      'platform_skill_resource_unsafe',
    );
  });
  it.skipIf(process.platform === 'win32')(
    'rejects a private FIFO without blocking while opening it',
    async () => {
      const f = await fixture();
      await rm(f.asset);
      await promisify(execFile)('mkfifo', [f.asset]);
      await expect(loadPlatformContentCatalog(f.directory)).rejects.toThrow(
        'platform_skill_resource_unsafe',
      );
    },
    2000,
  );
  it('rejects unknown hooks, embedded resource bodies and traversal before read', async () => {
    const f = await fixture(),
      path = join(f.directory, 'skills/fixture-bundle/bundle.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(
      path,
      JSON.stringify({
        ...manifest,
        hooks: { start: 'scripts/sample.mjs' },
      }),
    );
    await expect(loadPlatformContentCatalog(f.directory)).rejects.toThrow();
    await writeFile(
      path,
      JSON.stringify({
        ...manifest,
        resources: [{ ...manifest.resources[0], contentBase64: 'eA==' }],
      }),
    );
    await expect(loadPlatformContentCatalog(f.directory)).rejects.toThrow(
      'platform_skill_bundle_embedded_content',
    );
    await writeFile(
      path,
      JSON.stringify({
        ...manifest,
        resources: [{ ...manifest.resources[0], path: '../private.csv' }],
      }),
    );
    await expect(loadPlatformContentCatalog(f.directory)).rejects.toThrow();
  });
});
