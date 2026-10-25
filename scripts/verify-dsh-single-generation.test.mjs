import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  readImporterManifests,
  verifyDshSingleGeneration,
} from './verify-dsh-single-generation.mjs';

const version = '0.2.1-rc.2';
const folders = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'allrice-dsh-generation-'));
  folders.push(root);
  await mkdir(join(root, 'patches'));
  await writeFile(join(root, 'patches/next@16.2.1.patch'), 'diff next\n');
  return {
    root,
    version,
    lockText: `'@deepseek-ai/dsh-session@${version}':\n`,
    manifests: {
      'apps/worker': {
        dependencies: {
          '@deepseek-ai/dsh-session': version,
          '@deepseek-ai/cordis': '4.0.5',
        },
      },
    },
    workspace: {
      packageExtensions: {
        [`@deepseek-ai/dsh-client-ui-chat@${version}`]: {
          dependencies: {
            '@deepseek-ai/dsh-client-store': version,
            react: '19.2.0',
          },
        },
      },
      overrides: {
        [`@deepseek-ai/dsh-office-to-pdf@${version}>@deepseek-ai/libreoffice-kit`]:
          '0.1.5',
      },
      patchedDependencies: { 'next@16.2.1': 'patches/next@16.2.1.patch' },
    },
    lock: {
      importers: {
        'apps/worker': {
          dependencies: {
            '@deepseek-ai/dsh-session': {
              specifier: version,
              version: `${version}(@deepseek-ai/cordis@4.0.5)`,
            },
            '@deepseek-ai/cordis': { specifier: '4.0.5', version: '4.0.5' },
          },
        },
      },
      packages: {
        [`@deepseek-ai/dsh@${version}`]: {},
        [`@deepseek-ai/dsh-session@${version}`]: {},
        '@deepseek-ai/cordis@4.0.2': {},
        '@deepseek-ai/libreoffice-kit@0.1.5': {},
      },
      snapshots: {
        [`@deepseek-ai/dsh-session@${version}(@deepseek-ai/cordis@4.0.5)`]: {
          dependencies: {
            '@deepseek-ai/dsh-brand': `${version}(@deepseek-ai/cordis@4.0.5)`,
            zod: '4.4.3',
          },
        },
      },
      patchedDependencies: {
        'next@16.2.1': { path: 'patches/next@16.2.1.patch', hash: 'x' },
      },
    },
  };
}

describe('DSH single generation', () => {
  it('accepts the checked-in workspace', async () => {
    const root = resolve(import.meta.dirname, '..');
    const upstream = JSON.parse(
      await readFile(join(root, 'apps/worker/dsh/upstream.json'), 'utf8'),
    );
    const lockText = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8');
    const lock = parse(lockText);
    const result = await verifyDshSingleGeneration({
      root,
      version: upstream.version,
      workspace: parse(
        await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8'),
      ),
      lock,
      lockText,
      manifests: await readImporterManifests(root, lock),
    });
    expect(result.dshVersion).toBe(upstream.version);
    expect(result.dshPackages).toBeGreaterThan(50);
  });

  it('ignores non-DSH packages, overrides and patches', async () => {
    await expect(verifyDshSingleGeneration(await fixture())).resolves.toEqual({
      dshPackages: 2,
      dshVersion: version,
    });
  });

  it.each([
    [
      'a second generation in the lockfile',
      (f) => (f.lock.packages['@deepseek-ai/dsh-session@0.1.5-rc.3'] = {}),
      'lockfile resolves @deepseek-ai/dsh-session@0.1.5-rc.3',
    ],
    [
      'the root package at another version',
      (f) => (f.lock.packages['@deepseek-ai/dsh@0.1.5-rc.3'] = {}),
      'lockfile resolves @deepseek-ai/dsh@0.1.5-rc.3',
    ],
    [
      'a tarball source whose URL contains @',
      (f) =>
        (f.lock.packages[
          '@deepseek-ai/dsh@https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.5-rc.3.tgz'
        ] = {}),
      'lockfile resolves @deepseek-ai/dsh@https://',
    ],
    [
      'a package entry whose own version differs from its key',
      (f) =>
        (f.lock.packages[`@deepseek-ai/dsh-session@${version}`] = {
          version: '0.1.5-rc.3',
        }),
      `lockfile resolves @deepseek-ai/dsh-session@${version}`,
    ],
    [
      'a package entry fetched from an older tarball',
      (f) =>
        (f.lock.packages[`@deepseek-ai/dsh-session@${version}`] = {
          resolution: {
            tarball:
              'https://registry.npmjs.org/@deepseek-ai/dsh-session/-/dsh-session-0.1.5-rc.3.tgz',
          },
        }),
      `lockfile resolves @deepseek-ai/dsh-session@${version}`,
    ],
    [
      'a workspace package published under a DSH name',
      (f) =>
        (f.manifests['packages/legacy-session'] = {
          name: '@deepseek-ai/dsh-session',
          version: '0.1.5-rc.3',
        }),
      'packages/legacy-session is a workspace package named @deepseek-ai/dsh-session',
    ],
    [
      'an older generation only in a snapshot key',
      (f) =>
        (f.lock.snapshots[
          '@deepseek-ai/dsh-session@0.1.5-rc.3(@deepseek-ai/cordis@4.0.2)'
        ] = {}),
      'lockfile snapshot @deepseek-ai/dsh-session@0.1.5-rc.3',
    ],
    [
      'an older generation only as a snapshot dependency',
      (f) =>
        (f.lock.snapshots[
          `@deepseek-ai/dsh-session@${version}(@deepseek-ai/cordis@4.0.5)`
        ].dependencies['@deepseek-ai/dsh-brand'] =
          '0.1.5-rc.3(@deepseek-ai/cordis@4.0.2)'),
      'resolves @deepseek-ai/dsh-brand to 0.1.5-rc.3',
    ],
    [
      'a workspace range instead of the exact version',
      (f) =>
        (f.lock.importers['apps/worker'].dependencies[
          '@deepseek-ai/dsh-session'
        ].specifier = `^${version}`),
      'apps/worker declares @deepseek-ai/dsh-session@^0.2.1-rc.2',
    ],
    [
      'an importer resolved to a local link',
      (f) =>
        (f.lock.importers['apps/worker'].dependencies[
          '@deepseek-ai/dsh-session'
        ].version = 'link:../../vendor/dsh-session'),
      'resolves @deepseek-ai/dsh-session to link:',
    ],
    [
      'a DSH package hidden behind an npm alias',
      (f) =>
        (f.lock.importers['apps/worker'].dependencies['session-alias'] = {
          specifier: `npm:@deepseek-ai/dsh-session@${version}`,
          version: `@deepseek-ai/dsh-session@${version}`,
        }),
      'apps/worker declares session-alias@npm:',
    ],
    [
      'a manifest range the lockfile has not caught up with',
      (f) =>
        (f.manifests['apps/worker'].dependencies['@deepseek-ai/dsh-session'] =
          `^${version}`),
      'apps/worker/package.json dependencies @deepseek-ai/dsh-session@^0.2.1-rc.2',
    ],
    [
      'a manifest alias to a DSH package',
      (f) =>
        (f.manifests['apps/worker'].dependencies['session-alias'] =
          `npm:@deepseek-ai/dsh-session@${version}`),
      'apps/worker/package.json dependencies session-alias',
    ],
    [
      'an older version written anywhere in the lockfile text',
      (f) => (f.lockText += "  '@deepseek-ai/dsh-util-crypto@0.1.5-rc.3':\n"),
      'lockfile mentions @deepseek-ai/dsh-util-crypto@0.1.5-rc.3',
    ],
    [
      'an extension for an older generation',
      (f) =>
        (f.workspace.packageExtensions['@deepseek-ai/dsh@0.1.5-rc.3'] = {
          dependencies: {},
        }),
      'packageExtensions targets @deepseek-ai/dsh@0.1.5-rc.3',
    ],
    [
      'an extension that adds an older DSH dependency',
      (f) =>
        (f.workspace.packageExtensions[
          `@deepseek-ai/dsh-client-ui-chat@${version}`
        ].dependencies['@deepseek-ai/dsh-brand'] = '0.1.7-rc.1'),
      'pins @deepseek-ai/dsh-brand@0.1.7-rc.1',
    ],
    [
      'an override selecting an older range',
      (f) =>
        (f.workspace.overrides['@deepseek-ai/dsh-fs@^0.1.5-rc.3'] =
          '0.1.5-rc.3'),
      'override selector @deepseek-ai/dsh-fs@^0.1.5-rc.3',
    ],
    [
      'an override forcing another version',
      (f) => (f.workspace.overrides['@deepseek-ai/dsh-fs'] = '0.1.5-rc.3'),
      'override @deepseek-ai/dsh-fs -> 0.1.5-rc.3',
    ],
    [
      'a lockfile override linking a local copy',
      (f) =>
        (f.lock.overrides = {
          '@deepseek-ai/dsh-session': 'link:../vendor/dsh-session',
        }),
      'lockfile override @deepseek-ai/dsh-session -> link:',
    ],
    [
      'a patched DSH package in the workspace',
      (f) =>
        (f.workspace.patchedDependencies[
          `@deepseek-ai/dsh-session@${version}`
        ] = 'patches/x.patch'),
      'workspace patches @deepseek-ai/dsh-session',
    ],
    [
      'a patched DSH package in the lockfile',
      (f) =>
        (f.lock.patchedDependencies[`@deepseek-ai/dsh-session@${version}`] = {
          path: 'patches/x.patch',
          hash: 'y',
        }),
      'lockfile patches @deepseek-ai/dsh-session',
    ],
  ])('rejects %s', async (_, mutate, message) => {
    const f = await fixture();
    mutate(f);
    await expect(verifyDshSingleGeneration(f)).rejects.toThrow(message);
  });

  it('accepts a non-DSH alias in the same scope and lockfile comments', async () => {
    const f = await fixture();
    f.manifests['apps/worker'].dependencies.shader =
      'npm:@deepseek-ai/dshader-helper@1.0.0';
    f.lockText = `# was @deepseek-ai/dsh-session@0.1.5-rc.3\n${f.lockText}`;
    await expect(verifyDshSingleGeneration(f)).resolves.toMatchObject({
      dshVersion: version,
    });
  });

  it('rejects a local link to a DSH package under another name', async () => {
    const f = await fixture();
    await mkdir(join(f.root, 'vendor/old-session'), { recursive: true });
    await writeFile(
      join(f.root, 'vendor/old-session/package.json'),
      JSON.stringify({
        name: '@deepseek-ai/dsh-session',
        version: '0.1.5-rc.3',
      }),
    );
    f.lock.importers['apps/worker'].dependencies['old-session'] = {
      specifier: 'link:../../vendor/old-session',
      version: 'link:../../vendor/old-session',
    };
    await expect(verifyDshSingleGeneration(f)).rejects.toThrow(
      'apps/worker links old-session to @deepseek-ai/dsh-session',
    );
  });

  it('reports every violation with the expected version', async () => {
    const f = await fixture();
    f.lock.packages['@deepseek-ai/dsh-session@0.1.5-rc.3'] = {};
    f.workspace.overrides['@deepseek-ai/dsh-fs'] = '0.1.5-rc.3';
    await expect(verifyDshSingleGeneration(f)).rejects.toThrow(
      /exactly 0\.2\.1-rc\.2[\s\S]*dsh-session@0\.1\.5-rc\.3[\s\S]*dsh-fs -> 0\.1\.5-rc\.3/,
    );
  });

  it('accepts a workspace without a patches directory', async () => {
    const f = await fixture();
    await rm(join(f.root, 'patches'), { recursive: true });
    await expect(verifyDshSingleGeneration(f)).resolves.toMatchObject({
      dshVersion: version,
    });
  });

  it('rejects a leftover DSH patch file', async () => {
    const f = await fixture();
    await writeFile(
      join(f.root, 'patches/@deepseek-ai__dsh-session@0.2.1-rc.2.patch'),
      'diff\n',
    );
    await expect(verifyDshSingleGeneration(f)).rejects.toThrow(
      'patch files remain',
    );
  });
});
