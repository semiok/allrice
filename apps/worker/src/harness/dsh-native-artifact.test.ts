import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BigIntStats, Stats } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  cp,
  realpath,
  symlink,
  rename,
  access,
} from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import {
  measureDshNativeArtifact,
  verifyDshNativeArtifact,
  assertDshNativeLaunch,
  nativeArtifactPath,
  nativeProfiles,
  nativeLoaderPlatformPackage,
  checkedDshNativeLaunch,
} from './dsh-native-artifact.js';
import { copyDshNativeArtifact } from './dsh-native-artifact-copy.js';

const leafIo = vi.hoisted(() => ({
  read: undefined as
    | undefined
    | ((path: string, read: () => Promise<unknown>) => Promise<unknown>),
  stat: undefined as
    | undefined
    | ((
        path: string,
        stat: () => Promise<Stats | BigIntStats>,
      ) => Promise<Stats | BigIntStats>),
}));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) =>
      leafIo.read
        ? leafIo.read(String(args[0]), () =>
            Reflect.apply(actual.readFile, actual, args),
          )
        : Reflect.apply(actual.readFile, actual, args),
    lstat: async (...args: Parameters<typeof actual.lstat>) =>
      leafIo.stat
        ? leafIo.stat(String(args[0]), () =>
            Reflect.apply(actual.lstat, actual, args),
          )
        : Reflect.apply(actual.lstat, actual, args),
  };
});

const roots: string[] = [];
const testHarnessExecArgv = process.execArgv;
afterEach(async () => {
  leafIo.read = undefined;
  leafIo.stat = undefined;
  vi.restoreAllMocks();
  process.execArgv = testHarnessExecArgv;
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function put(root: string, path: string, value: string | object) {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(
    join(root, path),
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-native-artifact-')),
  );
  roots.push(root);
  await put(root, 'apps/worker/package.json', {
    name: '@allrice/worker',
    dependencies: { '@deepseek-ai/test-root': '1.0.0' },
  });
  await put(root, 'apps/worker/dsh/distribution.json', {
    schemaVersion: 2,
    installedGeneration: 'dsh-0.1.5-rc.3-a4c74a9',
    generations: [
      {
        generation: 'dsh-0.1.5-rc.3-a4c74a9',
        version: '0.1.5-rc.3',
        commit: 'a4c74a91e06b00fe0b0937bde982170c526cc842',
      },
    ],
  });
  await put(root, 'node_modules/@deepseek-ai/test-root/package.json', {
    name: '@deepseek-ai/test-root',
    version: '1.0.0',
    type: 'module',
    exports: {
      '.': { import: './lib/import.js', require: './lib/require.cjs' },
      './plugin': './lib/plugin.js',
    },
    peerDependencies: { 'peer-only': '1.0.0', 'optional-peer': '1.0.0' },
    peerDependenciesMeta: { 'optional-peer': { optional: true } },
  });
  for (const path of ['lib/import.js', 'lib/plugin.js', 'lib/require.cjs'])
    await put(
      root,
      'node_modules/@deepseek-ai/test-root/' + path,
      'export const fixture = 1;',
    );
  await put(root, 'node_modules/peer-only/package.json', {
    name: 'peer-only',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
  });
  await put(root, 'node_modules/peer-only/index.js', 'export const value = 1;');
  await put(
    root,
    'apps/worker/dsh/allrice-jsonrpc-runtime.mjs',
    "import '@deepseek-ai/test-root';",
  );
  for (const path of Object.values(nativeProfiles))
    await put(
      root,
      path,
      "- id: fixture\n  name: '@deepseek-ai/test-root/plugin'\n  config:\n    value: !!js process.env.SECRET_MUST_NOT_BE_EVALUATED\n",
    );
  await put(root, 'pnpm-lock.yaml', 'lockfileVersion: 9');
  await put(root, 'pnpm-workspace.yaml', 'packages: []');
  await put(root, 'patches/@deepseek-ai__fixture.patch', 'fixture patch');
  return root;
}
async function seal(root: string) {
  const measured = await measureDshNativeArtifact(root);
  await put(root, nativeArtifactPath, {
    ...measured,
    source: { sha: 'a'.repeat(40), tree: 'b'.repeat(40) },
  });
  return measured;
}
async function currentCopyFixture() {
  const root = await fixture();
  await put(root, 'apps/worker/dsh/distribution.json', {
    schemaVersion: 2,
    installedGeneration: 'dsh-0.2.1-rc.2-687f282',
    generations: [
      {
        generation: 'dsh-0.2.1-rc.2-687f282',
        version: '0.2.1-rc.2',
        commit: '687f282e8625c6b8d11ff58211a90524be2e4317',
      },
    ],
  });
  return root;
}
async function leafFixture(current = false) {
  const root = current ? await currentCopyFixture() : await fixture();
  const folder = 'node_modules/@deepseek-ai/test-root/leaves';
  const name = (index: number) => String(index).padStart(2, '0') + '.txt';
  for (let index = 0; index < 12; index++)
    await put(root, join(folder, name(index)), 'leaf-' + index);
  return { root, leaf: (index: number) => join(root, folder, name(index)) };
}
const isLeaf = (path: string) => /\/leaves\/\d+\.txt$/.test(path);
const delayLeaf = () => new Promise<void>((resolve) => setTimeout(resolve, 2));

it('copies only the measured closure with original provenance and resolves it after the source disappears', async () => {
  const root = await currentCopyFixture();
  // Unrelated Web/data/credential bytes must never enter a retained runtime.
  await put(root, '.env', 'SYNTHETIC_NOT_A_REAL_SECRET');
  await put(root, 'apps/web/.next/BUILD_ID', 'do-not-copy');
  await put(root, '.local/sessions/private.json', 'do-not-copy');
  const value = await seal(root);
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-retained-copy-')),
  );
  roots.push(parent);
  const target = join(parent, 'native');
  const result = await copyDshNativeArtifact({
    root,
    target,
    expectedId: value.artifactId,
    sourceSha: 'a'.repeat(40),
    sourceTree: 'b'.repeat(40),
  });
  expect(result.deploymentApprovalGranted).toBe(false);
  expect(result.storageCopied).toBe(false);
  for (const absent of ['.env', 'apps/web', '.local/sessions'])
    await expect(access(join(target, absent))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  const held = root + '-held';
  await rename(root, held);
  try {
    const retained = await verifyDshNativeArtifact({
      root: target,
      expectedId: value.artifactId,
      sourceSha: 'a'.repeat(40),
      sourceTree: 'b'.repeat(40),
    });
    expect(retained.content).toEqual(value.content);
    expect(retained.source).toEqual({
      sha: 'a'.repeat(40),
      tree: 'b'.repeat(40),
    });
  } finally {
    await rename(held, root);
  }
  await expect(
    copyDshNativeArtifact({
      root,
      target,
      expectedId: value.artifactId,
      sourceSha: 'a'.repeat(40),
      sourceTree: 'b'.repeat(40),
    }),
  ).rejects.toMatchObject({ code: 'EEXIST' });
});
it('rejects wrong original source before creating a retained copy and detects later copied-code tampering', async () => {
  const root = await currentCopyFixture(),
    value = await seal(root);
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-retained-copy-')),
  );
  roots.push(parent);
  const target = join(parent, 'native');
  const input = {
    root,
    target,
    expectedId: value.artifactId,
    sourceSha: 'c'.repeat(40),
    sourceTree: 'b'.repeat(40),
  };
  await expect(copyDshNativeArtifact(input)).rejects.toThrow('SOURCE_MISMATCH');
  await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
  await copyDshNativeArtifact({ ...input, sourceSha: 'a'.repeat(40) });
  await put(
    target,
    'node_modules/peer-only/index.js',
    'export const tampered = true',
  );
  await expect(
    verifyDshNativeArtifact({ root: target, expectedId: value.artifactId }),
  ).rejects.toThrow('CONTENT_MISMATCH');
});
it('retains the full legacy reader rather than presenting an incompletely measured dynamic loader copy as portable', async () => {
  const root = await fixture(),
    value = await seal(root);
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-retained-copy-')),
  );
  roots.push(parent);
  const target = join(parent, 'native');
  await expect(
    copyDshNativeArtifact({
      root,
      target,
      expectedId: value.artifactId,
      sourceSha: 'a'.repeat(40),
      sourceTree: 'b'.repeat(40),
    }),
  ).rejects.toThrow('LEGACY_ORIGINAL_ROOT_REQUIRED');
  await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('selects the exact mapped Linux libc and refuses ambiguous or absent facts', () => {
  const input = { platform: 'linux', arch: 'x64' };
  const gnu = nativeLoaderPlatformPackage({
    ...input,
    mappedLibraries: '/lib/x86_64-linux-gnu/libc.so.6',
  });
  const musl = nativeLoaderPlatformPackage({
    ...input,
    mappedLibraries: '/lib/ld-musl-x86_64.so.1',
  });
  expect(gnu).toBe('node-addon-require-builtin-linux-x64-gnu');
  expect(musl).toBe('node-addon-require-builtin-linux-x64-musl');
  // The other ABI's package cannot satisfy the exact host name.
  expect([musl]).not.toContain(gnu);
  expect([gnu]).not.toContain(musl);
  expect(() => nativeLoaderPlatformPackage(input)).toThrow(
    'NATIVE_LOADER_LIBC_UNKNOWN',
  );
  expect(() =>
    nativeLoaderPlatformPackage({
      ...input,
      mappedLibraries: '/lib/libc.so.6\n/lib/ld-musl-x86_64.so.1',
    }),
  ).toThrow('NATIVE_LOADER_LIBC_UNKNOWN');
});
it('requires a legacy helper to resolve its already-measured platform package without rewriting the v1 content identity', async () => {
  const root = await fixture();
  const host = `node-addon-require-builtin-${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : process.platform === 'win32' ? '-msvc' : ''}`;
  const boot = 'node_modules/@deepseek-ai/dsh-app-boot';
  const loader = 'node_modules/@deepseek-ai/cordis-plugin-loader';
  const entry = 'node_modules/node-addon-require-builtin';
  const helper = 'node_modules/node-addon-native-custom-loader';
  const definitions = [
    [
      boot,
      {
        name: '@deepseek-ai/dsh-app-boot',
        version: '0.1.5-rc.3',
        dependencies: { '@deepseek-ai/cordis-plugin-loader': '1.0.3' },
      },
    ],
    [
      loader,
      {
        name: '@deepseek-ai/cordis-plugin-loader',
        version: '1.0.3',
        dependencies: { 'node-addon-require-builtin': '0.1.5' },
      },
    ],
    [
      entry,
      {
        name: 'node-addon-require-builtin',
        version: '0.1.5',
        dependencies: { 'node-addon-native-custom-loader': '0.1.5' },
        optionalDependencies: { [host]: '0.1.5' },
      },
    ],
    [helper, { name: 'node-addon-native-custom-loader', version: '0.1.5' }],
    ['node_modules/' + host, { name: host, version: '0.1.5' }],
  ] as const;
  for (const [path, metadata] of definitions) {
    await put(root, path + '/package.json', {
      ...metadata,
      type: 'module',
      main: 'index.js',
    });
    await put(root, path + '/index.js', 'export const synthetic=true;');
  }
  const worker = JSON.parse(
    await readFile(join(root, 'apps/worker/package.json'), 'utf8'),
  );
  worker.dependencies['@deepseek-ai/dsh-app-boot'] = '0.1.5-rc.3';
  await put(root, 'apps/worker/package.json', worker);
  const original = await seal(root);
  expect(
    original.content.dependencyEdges.filter(
      (e) => e.importer === helper && e.name === host,
    ),
  ).toHaveLength(0);
  expect(
    (await verifyDshNativeArtifact({ root, expectedId: original.artifactId }))
      .artifactId,
  ).toBe(original.artifactId);
  const other = join(root, '.unapproved-platform');
  await put(root, '.unapproved-platform/package.json', {
    name: host,
    version: '0.1.9',
  });
  await put(
    root,
    '.unapproved-platform/index.js',
    'export const unapproved=true;',
  );
  await mkdir(join(root, helper, 'node_modules'), { recursive: true });
  await symlink(other, join(root, helper, 'node_modules', host));
  await expect(
    verifyDshNativeArtifact({ root, expectedId: original.artifactId }),
  ).rejects.toThrow('LEGACY_NATIVE_LOADER_RESOLUTION');
});
async function dynamicNativeFixture(root: string) {
  await put(root, 'apps/worker/dsh/distribution.json', {
    schemaVersion: 2,
    installedGeneration: 'dsh-0.2.1-rc.2-687f282',
    generations: [
      {
        generation: 'dsh-0.2.1-rc.2-687f282',
        version: '0.2.1-rc.2',
        commit: '687f282e8625c6b8d11ff58211a90524be2e4317',
      },
    ],
  });
  const suffixes = [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64-gnu',
    'linux-arm64-musl',
    'linux-x64-gnu',
    'linux-x64-musl',
    'win32-arm64-msvc',
    'win32-ia32-msvc',
    'win32-x64-msvc',
  ];
  const platforms = Object.fromEntries(
    suffixes.map((s) => ['node-addon-require-builtin-' + s, '0.1.9']),
  );
  // Synthetic graph, not a real ABI test. Linux's fixture uses the GNU name.
  const platform = `node-addon-require-builtin-${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : process.platform === 'win32' ? '-msvc' : ''}`;
  const helper = 'node_modules/node-addon-native-custom-loader';
  const entry = 'node_modules/node-addon-require-builtin';
  const binary = '.fixture-platform/' + platform;
  await put(root, 'pnpm-workspace.yaml', {
    packageExtensions: {
      'node-addon-native-custom-loader@0.1.9': {
        optionalDependencies: platforms,
      },
    },
  });
  await put(root, 'apps/worker/package.json', {
    name: '@allrice/worker',
    dependencies: {
      '@deepseek-ai/test-root': '1.0.0',
      '@deepseek-ai/cordis-plugin-loader': '1.0.6',
    },
  });
  for (const [path, name, version, dependencies, optionalDependencies] of [
    [
      'node_modules/@deepseek-ai/cordis-plugin-loader',
      '@deepseek-ai/cordis-plugin-loader',
      '1.0.6',
      { 'node-addon-require-builtin': '0.1.9' },
      {},
    ],
    [
      entry,
      'node-addon-require-builtin',
      '0.1.9',
      { 'node-addon-native-custom-loader': '0.1.9' },
      platforms,
    ],
    [helper, 'node-addon-native-custom-loader', '0.1.9', {}, {}],
    [
      binary,
      platform,
      '0.1.9',
      { 'node-addon-native-custom-loader': '0.1.9' },
      {},
    ],
    ['node_modules/' + platform, platform, '0.1.5', {}, {}],
  ] as const) {
    await put(root, path + '/package.json', {
      name,
      version,
      main: 'index.js',
      dependencies,
      optionalDependencies,
    });
    await put(root, path + '/index.js', 'module.exports = {};');
  }
  await mkdir(join(root, entry, 'node_modules'), { recursive: true });
  await symlink(
    relative(join(root, entry, 'node_modules'), join(root, binary)),
    join(root, entry, 'node_modules', platform),
  );
  return { helper, binary, platform };
}
it('measures the dynamic native helper edge and rejects an unmeasured old hoist or missing binary', async () => {
  const root = await fixture(),
    f = await dynamicNativeFixture(root);
  // The published helper still has no dependencies. Only the entry's own
  // optional binary is correct; the helper would borrow the old public hoist.
  await expect(measureDshNativeArtifact(root)).rejects.toThrow(
    'NATIVE_LOADER_PLATFORM_MISMATCH',
  );
  await mkdir(join(root, f.helper, 'node_modules'), { recursive: true });
  const link = join(root, f.helper, 'node_modules', f.platform);
  await symlink(
    relative(join(root, f.helper, 'node_modules'), join(root, f.binary)),
    link,
  );
  const first = await seal(root);
  expect(first.content.dependencyEdges).toContainEqual({
    importer: f.helper,
    name: f.platform,
    kind: 'optional',
    declared: '0.1.9',
    optional: true,
    target: f.binary,
  });
  expect(
    first.content.packages
      .filter((p) => p.name === f.platform)
      .map((p) => p.version),
  ).toEqual(['0.1.9']);
  await put(
    root,
    f.binary + '/binary.node',
    'synthetic measured platform bytes',
  );
  await expect(
    verifyDshNativeArtifact({ root, expectedId: first.artifactId }),
  ).rejects.toThrow('CONTENT_MISMATCH');
  await rm(link);
  await rm(join(root, 'node_modules', f.platform), { recursive: true });
  await expect(measureDshNativeArtifact(root)).rejects.toThrow(
    /DSH_NATIVE_ARTIFACT_(NATIVE_LOADER_PLATFORM_MISSING|PATH_OUTSIDE_RELEASE)/,
  );
});
it('requires the finite native-helper extension to match the published platform declarations', async () => {
  const root = await fixture();
  await dynamicNativeFixture(root);
  await put(root, 'pnpm-workspace.yaml', {
    packageExtensions: {
      'node-addon-native-custom-loader@0.1.9': { optionalDependencies: {} },
    },
  });
  await expect(measureDshNativeArtifact(root)).rejects.toThrow(
    'NATIVE_LOADER_EXTENSION',
  );
});
describe('native artifact content and launch boundary', () => {
  it('measures the target root generation independently of the consuming Worker', async () => {
    const root = await fixture();
    await put(root, 'apps/worker/dsh/distribution.json', {
      schemaVersion: 2,
      installedGeneration: 'dsh-0.1.1-rc.2-b150a55',
      generations: [
        {
          generation: 'dsh-0.1.1-rc.2-b150a55',
          version: '0.1.1-rc.2',
          commit: 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e',
        },
      ],
    });
    const value = await seal(root);
    expect(value.content.generation).toBe('dsh-0.1.1-rc.2-b150a55');
    expect(
      (await verifyDshNativeArtifact({ root, expectedId: value.artifactId }))
        .version,
    ).toBe('0.1.1-rc.2');
    // Synthetic package graph only: this does not approve an actual 0.1.1
    // reader or a frozen-profile compatibility relationship.
  });
  it('routes approved artifacts by exact content identity even within one generation', async () => {
    // This registry unit seam is not an assertion about Worker loaders. The
    // actual compiled startup/loader guard is exercised by deployment probes.
    process.execArgv = [];
    vi.stubEnv('NODE_OPTIONS', '');
    const root = await fixture(),
      retained = await fixture();
    await writeFile(
      join(retained, 'apps/worker/dsh/allrice-jsonrpc-runtime.mjs'),
      "import '@deepseek-ai/test-root';\n// independently reviewed retained content\n",
    );
    const first = await seal(root),
      second = await seal(retained);
    expect(first.content.generation).toBe(second.content.generation);
    expect(first.artifactId).not.toBe(second.artifactId);
    vi.resetModules();
    const registry = await import('./dsh-native-artifact.js');
    await expect(
      registry.installRetainedDshNativeArtifact({
        root: retained,
        expectedId: second.artifactId,
      }),
    ).rejects.toThrow('NOT_INSTALLED');
    await registry.installDshNativeArtifact({
      root,
      expectedId: first.artifactId,
    });
    await expect(
      registry.installRetainedDshNativeArtifact({
        root: retained,
        expectedId: first.artifactId,
      }),
    ).rejects.toThrow('MANIFEST_DIGEST');
    await registry.installRetainedDshNativeArtifact({
      root: retained,
      expectedId: second.artifactId,
    });
    const launch = registry.nativeArtifactLaunchForPin({
      artifactId: second.artifactId,
      profileId: 'restricted',
    });
    expect(launch.args).toEqual([
      join(retained, 'apps/worker/dsh/allrice-jsonrpc-runtime.mjs'),
    ]);
    expect(registry.checkedDshNativeLaunch(launch)).toEqual({
      artifactId: second.artifactId,
      profileId: 'restricted',
    });
    expect(
      registry.nativeArtifactLaunchForPin({
        artifactId: first.artifactId,
        profileId: 'technical',
      }).args,
    ).toEqual([join(root, 'apps/worker/dsh/allrice-jsonrpc-runtime.mjs')]);
    expect(() =>
      registry.nativeArtifactLaunchForPin({
        artifactId: 'sha256:' + '0'.repeat(64),
        profileId: 'restricted',
      }),
    ).toThrow('PIN_NOT_APPROVED');
    const control = registry.approvedDshNativeControlArtifact(
      second.artifactId,
    );
    expect(control).toEqual({
      artifactId: second.artifactId,
      generation: second.content.generation,
      root: retained,
      content: {
        schemaVersion: 1,
        files: second.content.files,
        packages: second.content.packages,
      },
    });
    control.content.files.length = 0;
    expect(
      registry.approvedDshNativeControlArtifact(second.artifactId).content
        .files,
    ).toEqual(second.content.files);
    expect(
      registry.approvedDshNativeControlArtifact(first.artifactId).root,
    ).toBe(root);
    expect(() =>
      registry.approvedDshNativeControlArtifact('sha256:' + '0'.repeat(64)),
    ).toThrow('CONTROL_NOT_APPROVED');
  });
  it('keeps seven independently measured readers and rejects an eighth without replacing any pin', async () => {
    process.execArgv = [];
    vi.stubEnv('NODE_OPTIONS', '');
    const candidates = [];
    for (let index = 0; index < 9; index++) {
      const root = await fixture();
      await writeFile(
        join(root, 'apps/worker/dsh/allrice-jsonrpc-runtime.mjs'),
        `import '@deepseek-ai/test-root';\n// exact candidate ${index}\n`,
      );
      candidates.push({ root, manifest: await seal(root) });
    }
    vi.resetModules();
    const registry = await import('./dsh-native-artifact.js');
    const first = candidates[0]!;
    await registry.installDshNativeArtifact({
      root: first.root,
      expectedId: first.manifest.artifactId,
    });
    for (const candidate of candidates.slice(1, 8)) {
      if (candidate === candidates[7]) {
        for (const provenance of [
          { sourceSha: 'c'.repeat(40), sourceTree: 'b'.repeat(40) },
          { sourceSha: 'a'.repeat(40), sourceTree: 'c'.repeat(40) },
        ])
          await expect(
            registry.installRetainedDshNativeArtifact({
              root: candidate.root,
              expectedId: candidate.manifest.artifactId,
              ...provenance,
            }),
          ).rejects.toThrow('SOURCE_MISMATCH');
      }
      await registry.installRetainedDshNativeArtifact({
        root: candidate.root,
        expectedId: candidate.manifest.artifactId,
        sourceSha: 'a'.repeat(40),
        sourceTree: 'b'.repeat(40),
      });
    }
    const excess = candidates[8]!;
    await expect(
      registry.installRetainedDshNativeArtifact({
        root: excess.root,
        expectedId: excess.manifest.artifactId,
      }),
    ).rejects.toThrow('RETAINED_DUPLICATE_OR_LIMIT');
    for (const candidate of candidates.slice(0, 8))
      expect(
        registry.nativeArtifactLaunchForPin({
          artifactId: candidate.manifest.artifactId,
          profileId: 'restricted',
        }).args,
      ).toEqual([
        join(candidate.root, 'apps/worker/dsh/allrice-jsonrpc-runtime.mjs'),
      ]);
    expect(() =>
      registry.nativeArtifactLaunchForPin({
        artifactId: excess.manifest.artifactId,
        profileId: 'restricted',
      }),
    ).toThrow('PIN_NOT_APPROVED');
  });
  it('refuses production Worker launch before a verified artifact is installed', () => {
    vi.stubEnv('ALLRICE_SERVICE_ROLE', 'worker');
    expect(() =>
      checkedDshNativeLaunch({
        command: process.execPath,
        args: [],
        profile: '',
      }),
    ).toThrow('NOT_INSTALLED');
  });
  it('measures recursive peer-only code and real ESM entry conditions', async () => {
    const root = await fixture(),
      first = await seal(root);
    expect(first.content.packages.map((p) => p.name)).toContain('peer-only');
    expect(
      first.content.imports.find(
        (i) => i.specifier === '@deepseek-ai/test-root',
      )?.target,
    ).toBe('node_modules/@deepseek-ai/test-root/lib/import.js');
    await put(
      root,
      'node_modules/peer-only/index.js',
      'export const value = 2;',
    );
    expect((await measureDshNativeArtifact(root)).artifactId).not.toBe(
      first.artifactId,
    );
    await expect(
      verifyDshNativeArtifact({ root, expectedId: first.artifactId }),
    ).rejects.toThrow('CONTENT_MISMATCH');
  });
  it('records absent optional peers and observes appearance and disappearance without installing', async () => {
    const root = await fixture(),
      before = await measureDshNativeArtifact(root);
    expect(before.content.dependencyEdges).toContainEqual(
      expect.objectContaining({
        name: 'optional-peer',
        kind: 'peer',
        optional: true,
        target: null,
      }),
    );
    await put(root, 'node_modules/optional-peer/package.json', {
      name: 'optional-peer',
      version: '1.0.0',
      main: 'index.js',
    });
    await put(
      root,
      'node_modules/optional-peer/index.js',
      'module.exports = {};',
    );
    expect((await measureDshNativeArtifact(root)).artifactId).not.toBe(
      before.artifactId,
    );
    await rm(join(root, 'node_modules/optional-peer'), { recursive: true });
    expect((await measureDshNativeArtifact(root)).artifactId).toBe(
      before.artifactId,
    );
    await rm(join(root, 'node_modules/peer-only'), { recursive: true });
    await expect(measureDshNativeArtifact(root)).rejects.toThrow(
      'REQUIRED_DEPENDENCY_MISSING',
    );
  });
  it('rejects nearer native and nested package resolver overrides', async () => {
    const root = await fixture();
    await mkdir(join(root, 'apps/worker/dsh/node_modules'));
    await expect(measureDshNativeArtifact(root)).rejects.toThrow();
    await rm(join(root, 'apps/worker/dsh/node_modules'), { recursive: true });
    await mkdir(
      join(root, 'node_modules/@deepseek-ai/test-root/lib/node_modules'),
    );
    await expect(measureDshNativeArtifact(root)).rejects.toThrow(
      'NESTED_MODULE_OVERRIDE',
    );
  });

  it('keeps same-name/version peer contexts distinct and terminates dependency cycles', async () => {
    const root = await fixture();
    const worker = JSON.parse(
      await readFile(join(root, 'apps/worker/package.json'), 'utf8'),
    );
    worker.dependencies['@deepseek-ai/test-other'] = '1.0.0';
    await put(root, 'apps/worker/package.json', worker);
    await put(root, 'node_modules/@deepseek-ai/test-other/package.json', {
      name: '@deepseek-ai/test-other',
      version: '1.0.0',
      peerDependencies: { 'peer-only': '1.0.0' },
    });
    await put(
      root,
      'node_modules/@deepseek-ai/test-other/node_modules/peer-only/package.json',
      {
        name: 'peer-only',
        version: '1.0.0',
        dependencies: { '@deepseek-ai/test-other': '1.0.0' },
      },
    );
    await put(
      root,
      'node_modules/@deepseek-ai/test-other/node_modules/peer-only/index.js',
      'module.exports=2;',
    );
    const result = await measureDshNativeArtifact(root);
    const peers = result.content.packages.filter((p) => p.name === 'peer-only');
    expect(peers).toHaveLength(2);
    expect(new Set(peers.map((p) => p.path)).size).toBe(2);
    expect(new Set(peers.map((p) => p.checksum)).size).toBe(2);
  });

  it('rejects package resource symlinks instead of attesting bytes outside the sealed tree', async () => {
    const root = await fixture();
    await symlink(
      join(root, 'pnpm-lock.yaml'),
      join(root, 'node_modules/peer-only/redirected-resource'),
    );
    await expect(measureDshNativeArtifact(root)).rejects.toThrow(
      'PACKAGE_FILE_LINK',
    );
  });
  it('re-enumerates added bytes and preserves identity only for an unchanged relative layout', async () => {
    const root = await fixture(),
      first = await measureDshNativeArtifact(root);
    const clone = await mkdtemp(join(tmpdir(), 'allrice-native-clone-'));
    roots.push(clone);
    await cp(root, clone, { recursive: true });
    expect((await measureDshNativeArtifact(clone)).artifactId).toBe(
      first.artifactId,
    );
    await put(
      clone,
      'node_modules/peer-only/new-resource.wasm',
      'new resource',
    );
    expect((await measureDshNativeArtifact(clone)).artifactId).not.toBe(
      first.artifactId,
    );
    for (const path of [
      'patches/@deepseek-ai__fixture.patch',
      'pnpm-lock.yaml',
      nativeProfiles.technical,
    ]) {
      const bytes = await readFile(join(root, path));
      await writeFile(
        join(root, path),
        Buffer.concat([bytes, Buffer.from('\n# changed')]),
      );
      expect((await measureDshNativeArtifact(root)).artifactId).not.toBe(
        first.artifactId,
      );
      await writeFile(join(root, path), bytes);
    }
  });
  it('never treats a self-generated manifest as independent deployment approval', async () => {
    const root = await fixture(),
      first = await seal(root);
    await expect(
      verifyDshNativeArtifact({ root, expectedId: '' }),
    ).rejects.toThrow('APPROVAL_REQUIRED');
    await expect(
      verifyDshNativeArtifact({ root, expectedId: 'sha256:' + '0'.repeat(64) }),
    ).rejects.toThrow('MANIFEST_DIGEST');
    await expect(
      verifyDshNativeArtifact({
        root,
        expectedId: first.artifactId,
        sourceSha: 'c'.repeat(40),
      }),
    ).rejects.toThrow('SOURCE_MISMATCH');
    const artifact = await verifyDshNativeArtifact({
      root,
      expectedId: first.artifactId,
      sourceSha: 'a'.repeat(40),
    });
    const launch = {
      artifact,
      command: process.execPath,
      args: [join(root, artifact.content.entrypoint)],
      profile: join(root, nativeProfiles.restricted),
    };
    expect(assertDshNativeLaunch(launch)).toEqual({
      artifactId: first.artifactId,
      profileId: 'restricted',
    });
    // Child cwd is the tenant runtime directory, not the Worker cwd. Even a
    // relative argument that resolves correctly here cannot attest that child.
    expect(() =>
      assertDshNativeLaunch({
        ...launch,
        args: [relative(process.cwd(), launch.args[0]!)],
      }),
    ).toThrow('COMMAND_OVERRIDE');
    expect(() =>
      assertDshNativeLaunch({
        ...launch,
        args: ['--import', 'unapproved-loader', ...launch.args],
      }),
    ).toThrow('COMMAND_OVERRIDE');
    expect(() =>
      assertDshNativeLaunch({
        ...launch,
        profile: join(root, 'unapproved.yml'),
      }),
    ).toThrow('PROFILE_OVERRIDE');
  });
});

describe('bounded native package leaf reads', () => {
  it.each([false, true])(
    'keeps the complete v1 manifest and input reads identical (current=%s)',
    async (current) => {
      const f = await leafFixture(current);
      const memory = vi.spyOn(process, 'availableMemory').mockReturnValue(0);
      const inputs: string[] = [];
      leafIo.read = async (path, read) => {
        const bytes = await read();
        expect(Buffer.isBuffer(bytes)).toBe(true);
        inputs.push(JSON.stringify([path, (bytes as Buffer).toString('hex')]));
        return bytes;
      };
      const serial = await measureDshNativeArtifact(f.root);
      const serialInputs = inputs.splice(0).sort();
      memory.mockReturnValue(4 * 1024 ** 3);
      let active = 0,
        peak = 0;
      let release!: () => void;
      const fourReaders = new Promise<void>((resolve) => {
        release = resolve;
      });
      leafIo.read = async (path, read) => {
        if (isLeaf(path)) {
          active++;
          peak = Math.max(peak, active);
          if (active === 4) release();
        }
        try {
          if (isLeaf(path)) await fourReaders;
          const bytes = await read();
          expect(Buffer.isBuffer(bytes)).toBe(true);
          inputs.push(
            JSON.stringify([path, (bytes as Buffer).toString('hex')]),
          );
          return bytes;
        } finally {
          if (isLeaf(path)) active--;
        }
      };
      expect(await measureDshNativeArtifact(f.root)).toEqual(serial);
      expect(inputs.sort()).toEqual(serialInputs);
      expect(peak).toBe(4);
      expect(active).toBe(0);
    },
  );

  it.each([0, 4 * 1024 ** 3 - 1, Number.NaN, Number.POSITIVE_INFINITY])(
    'uses one leaf reader with unavailable or low memory (%s)',
    async (memory) => {
      const f = await leafFixture();
      vi.spyOn(process, 'availableMemory').mockReturnValue(memory);
      let active = 0,
        peak = 0;
      leafIo.read = async (path, read) => {
        if (!isLeaf(path)) return read();
        active++;
        peak = Math.max(peak, active);
        try {
          await delayLeaf();
          return await read();
        } finally {
          active--;
        }
      };
      await measureDshNativeArtifact(f.root);
      expect(peak).toBe(1);
      expect(active).toBe(0);
    },
  );

  it('stays serial if the memory probe throws', async () => {
    const f = await leafFixture();
    vi.spyOn(process, 'availableMemory').mockImplementation(() => {
      throw Error('memory probe unavailable');
    });
    let active = 0,
      peak = 0;
    leafIo.read = async (path, read) => {
      if (!isLeaf(path)) return read();
      active++;
      peak = Math.max(peak, active);
      try {
        await delayLeaf();
        return await read();
      } finally {
        active--;
      }
    };
    await measureDshNativeArtifact(f.root);
    expect(peak).toBe(1);
    expect(active).toBe(0);
  });

  it.each(['EIO', 'AbortError'])(
    'returns the serial-first %s failure after settling every started read',
    async (reason) => {
      const f = await leafFixture();
      vi.spyOn(process, 'availableMemory').mockReturnValue(4 * 1024 ** 3);
      const first = Object.assign(Error('first leaf'), {
        name: reason === 'AbortError' ? reason : 'Error',
        code: reason,
      });
      const second = Error('later leaf');
      let release!: () => void;
      const laterStarted = new Promise<void>((resolve) => {
        release = resolve;
      });
      let active = 0;
      const started: string[] = [],
        settled: string[] = [],
        unhandled: unknown[] = [];
      const onUnhandled = (error: unknown) => unhandled.push(error);
      process.on('unhandledRejection', onUnhandled);
      leafIo.read = async (path, read) => {
        if (!isLeaf(path)) return read();
        started.push(path);
        active++;
        try {
          if (path === f.leaf(0)) {
            await laterStarted;
            await delayLeaf();
            throw first;
          }
          if (path === f.leaf(1)) {
            release();
            throw second;
          }
          await delayLeaf();
          return await read();
        } finally {
          active--;
          settled.push(path);
        }
      };
      try {
        await expect(measureDshNativeArtifact(f.root)).rejects.toBe(first);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(active).toBe(0);
        expect(started).toContain(f.leaf(1));
        expect(started.length).toBeLessThanOrEqual(4);
        expect(settled.sort()).toEqual(started.sort());
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    },
  );

  it('keeps an earlier read failure ahead of a later discovery failure', async () => {
    const f = await leafFixture();
    vi.spyOn(process, 'availableMemory').mockReturnValue(4 * 1024 ** 3);
    const first = Error('earlier read'),
      later = Error('later lstat');
    let release!: () => void;
    const discovered = new Promise<void>((resolve) => {
      release = resolve;
    });
    leafIo.read = async (path, read) => {
      if (path === f.leaf(0)) {
        await discovered;
        throw first;
      }
      return read();
    };
    leafIo.stat = async (path, stat) => {
      if (path === f.leaf(1)) {
        release();
        throw later;
      }
      return stat();
    };
    await expect(measureDshNativeArtifact(f.root)).rejects.toBe(first);
  });

  it('settles earlier leaves before rejecting a symlink', async () => {
    const f = await leafFixture();
    await rm(f.leaf(2));
    await symlink(f.leaf(0), f.leaf(2));
    vi.spyOn(process, 'availableMemory').mockReturnValue(4 * 1024 ** 3);
    let active = 0;
    leafIo.read = async (path, read) => {
      if (!isLeaf(path)) return read();
      active++;
      try {
        await delayLeaf();
        return await read();
      } finally {
        active--;
      }
    };
    await expect(measureDshNativeArtifact(f.root)).rejects.toThrow(
      'PACKAGE_FILE_LINK',
    );
    expect(active).toBe(0);
  });

  it('runs a leaf declared above 8 MiB alone', async () => {
    const f = await leafFixture();
    vi.spyOn(process, 'availableMemory').mockReturnValue(4 * 1024 ** 3);
    leafIo.stat = async (path, stat) => {
      const actual = await stat();
      if (path === f.leaf(2))
        Object.defineProperty(actual, 'size', { value: 8 * 1024 ** 2 + 1 });
      return actual;
    };
    let active = 0,
      largeActive = false,
      overlaps = 0;
    leafIo.read = async (path, read) => {
      if (!isLeaf(path)) return read();
      const large = path === f.leaf(2);
      if ((large && active > 0) || largeActive) overlaps++;
      active++;
      if (large) largeActive = true;
      try {
        await delayLeaf();
        return await read();
      } finally {
        active--;
        if (large) largeActive = false;
      }
    };
    await measureDshNativeArtifact(f.root);
    expect(overlaps).toBe(0);
    expect(active).toBe(0);
  });

  it('rejects oversized leaves before reading bytes', async () => {
    const f = await leafFixture();
    vi.spyOn(process, 'availableMemory').mockReturnValue(4 * 1024 ** 3);
    leafIo.stat = async (path, stat) => {
      const actual = await stat();
      if (path === f.leaf(0))
        Object.defineProperty(actual, 'size', { value: 256 * 1024 ** 2 + 1 });
      return actual;
    };
    let oversizedReads = 0;
    leafIo.read = async (path, read) => {
      if (path === f.leaf(0)) oversizedReads++;
      return read();
    };
    await expect(measureDshNativeArtifact(f.root)).rejects.toThrow(
      'FILE_TYPE_OR_SIZE',
    );
    expect(oversizedReads).toBe(0);
  });

  it.each([
    [1, 'FILE_TYPE_OR_SIZE'],
    [2, 'FILE_RESOLUTION_CHANGED'],
  ] as const)(
    'retains the path-replacement rejection after lstat #%s',
    async (replaceAfter, reason) => {
      const f = await leafFixture();
      vi.spyOn(process, 'availableMemory').mockReturnValue(4 * 1024 ** 3);
      let checks = 0;
      leafIo.stat = async (path, stat) => {
        const actual = await stat();
        if (path === f.leaf(0) && ++checks === replaceAfter) {
          await rm(path);
          await symlink(f.leaf(1), path);
        }
        return actual;
      };
      await expect(measureDshNativeArtifact(f.root)).rejects.toThrow(reason);
    },
  );
});

describe('MET195 observational native metrics', () => {
  it('counts actual verifier release reads and package cache visits without changing any v1 identity field', async () => {
    const root = await fixture();
    const original = await measureDshNativeArtifact(root);
    const metrics: Array<
      Parameters<
        NonNullable<Parameters<typeof verifyDshNativeArtifact>[0]['observe']>
      >[0]
    > = [];
    const observed = await measureDshNativeArtifact(root, (metric) =>
      metrics.push(metric),
    );
    expect(observed).toEqual(original);
    expect(metrics.filter((m) => m.kind === 'package')).toHaveLength(
      original.content.packages.length,
    );
    expect(metrics.filter((m) => m.kind === 'read').length).toBeGreaterThan(
      original.content.files.length,
    );
    expect(metrics.some((m) => m.kind === 'read' && m.bytes > 0)).toBe(true);
    expect(metrics.some((m) => m.kind === 'cache' && !m.hit)).toBe(true);
    const sealed = await seal(root);
    const verified = await verifyDshNativeArtifact({
      root,
      expectedId: sealed.artifactId,
      observe: (metric) => metrics.push(metric),
    });
    expect(verified.artifactId).toBe(sealed.artifactId);
    expect(verified.content).toEqual(sealed.content);
  });
  it('does not let a failing diagnostic sink bypass unchanged content verification or replace a valid result', async () => {
    const root = await fixture();
    const sealed = await seal(root);
    const observe = () => {
      throw Error('diagnostic sink unavailable');
    };
    expect(
      (
        await verifyDshNativeArtifact({
          root,
          expectedId: sealed.artifactId,
          observe,
        })
      ).artifactId,
    ).toBe(sealed.artifactId);
    await put(
      root,
      'node_modules/peer-only/index.js',
      'export const tampered = true;',
    );
    await expect(
      verifyDshNativeArtifact({ root, expectedId: sealed.artifactId, observe }),
    ).rejects.toThrow('CONTENT_MISMATCH');
  });
});
