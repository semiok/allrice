import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { verifyDshSingleGeneration } from './verify-dsh-single-generation.mjs';

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
    const result = await verifyDshSingleGeneration({
      root,
      version: upstream.version,
      workspace: parse(
        await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8'),
      ),
      lock: parse(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')),
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
      'a workspace range instead of the exact version',
      (f) =>
        (f.lock.importers['apps/worker'].dependencies[
          '@deepseek-ai/dsh-session'
        ].specifier = `^${version}`),
      'apps/worker declares @deepseek-ai/dsh-session@^0.2.1-rc.2',
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
