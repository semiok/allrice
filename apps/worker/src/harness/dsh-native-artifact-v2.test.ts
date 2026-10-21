/** Filesystem-only verifier regressions. Never imports an artifact's JS,
 * starts a Host, installs a dependency, connects to a DB or invokes a model. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as FsPromises from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  realpath,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  measureDshNativeArtifact,
  verifyDshNativeArtifact,
  nativeArtifactPath,
  nativeProfiles,
  nativeLoaderPlatformPackage,
} from './dsh-native-artifact.js';
import { copyDshNativeArtifact } from './dsh-native-artifact-copy.js';

const io = vi.hoisted(() => ({
  read: undefined as
    | undefined
    | ((path: string, read: () => Promise<unknown>) => Promise<unknown>),
}));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) =>
      io.read
        ? io.read(String(args[0]), () =>
            Reflect.apply(actual.readFile, actual, args),
          )
        : Reflect.apply(actual.readFile, actual, args),
  };
});
const owned: string[] = [];
vi.setConfig({ testTimeout: 30_000 });
afterEach(async () => {
  io.read = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    owned.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const version = '0.2.1-rc.2';
const generation = 'dsh-0.2.1-rc.2-687f282';
const digest = (value: string) =>
  'sha256:' + createHash('sha256').update(value).digest('hex');
const v2 = (
  root: string,
  observe?: Parameters<typeof measureDshNativeArtifact>[1],
) => measureDshNativeArtifact(root, observe, { schemaVersion: 2 });
const metadataModules = [
  'dsh-app-boot',
  'dsh-agent',
  'dsh-agent-loop',
  'dsh-llm',
  'dsh-session',
  'dsh-sdk-protocol',
  'dsh-sdk-jsonrpc-server',
];
// Same public keys as the existing control carrier. The fixture deliberately
// puts commands/connection in a controller-local resolver context.
const moduleNames = {
  cordis: 'cordis',
  llm: 'dsh-llm',
  sessions: 'dsh-session',
  projections: 'dsh-session-projection',
  systemPrompt: 'dsh-system-prompt',
  files: 'dsh-fs-local',
  directory: 'dsh-working-directory',
  tools: 'dsh-tools',
  agents: 'dsh-agent',
  loop: 'dsh-agent-loop',
  jsonl: 'dsh-session-persistence-jsonl',
  storage: 'dsh-storage',
  domain: 'dsh-storage-domain',
  workspace: 'dsh-workspace',
  typert: 'dsh-typert-registry',
  defaultModel: 'dsh-agent-default-model',
  credentials: 'dsh-credentials',
  commands: 'dsh-commands',
  connection: 'dsh-client-connection',
  attachment: 'dsh-attachment-local',
  upload: 'dsh-client-file-upload',
  query: 'dsh-session-query-sqlite',
  controller: 'dsh-api-session-controller',
  sdk: 'dsh-sdk-jsonrpc-server',
  schedule: 'dsh-schedule',
};
const moduleMap = Object.fromEntries(
  Object.entries(moduleNames).map(([key, name]) => [
    key,
    {
      specifier: '@deepseek-ai/' + name,
      anchor: ['commands', 'connection'].includes(key)
        ? 'controller'
        : 'factory',
    },
  ]),
);
const factoryPath = 'apps/worker/dsh/native-schedule-host-factory.mjs';
const adapterPath = 'apps/worker/dsh/allrice-jsonrpc-runtime.mjs';
const controllerPath = 'node_modules/@deepseek-ai/dsh-api-session-controller';
const contractsPath = 'node_modules/@allrice/contracts';
async function put(root: string, path: string, value: string | object) {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(
    join(root, path),
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-native-v2-')),
  );
  owned.push(root);
  const selected = {
    generation,
    version,
    commit: '687f282e8625c6b8d11ff58211a90524be2e4317',
    profile: 'allrice-restricted.cordis.yml',
    frozenProfileAllowed: true,
  };
  await put(root, 'apps/worker/dsh/distribution.json', {
    schemaVersion: 2,
    installedGeneration: generation,
    generations: [selected],
  });
  for (const name of ['upstream', 'compatibility', 'patch-ledger'])
    await put(root, `apps/worker/dsh/${name}.json`, { provenanceOnly: name });
  await put(root, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
  await put(root, 'pnpm-workspace.yaml', 'packages: []\n');
  await put(
    root,
    'patches/@deepseek-ai__old-rc3.patch',
    'old installation recipe',
  );
  await put(root, 'apps/worker/package.json', {
    name: '@allrice/worker',
    type: 'module',
    dependencies: {
      '@allrice/contracts': 'workspace:*',
      '@deepseek-ai/unused-root': '1.0.0',
    },
  });
  const roots = new Set([...metadataModules, ...Object.values(moduleNames)]);
  for (const name of roots) {
    const path = 'node_modules/@deepseek-ai/' + name;
    await put(root, path + '/package.json', {
      name: '@deepseek-ai/' + name,
      version: name === 'cordis' ? '4.0.5' : version,
      type: 'module',
      exports: {
        '.': { import: './esm.js', require: './cjs.cjs' },
        './package.json': {
          import: './esm-metadata.json',
          require: './package.json',
        },
      },
      ...(name === 'dsh-api-session-controller'
        ? {
            dependencies: {
              '@deepseek-ai/dsh-commands': version,
              '@deepseek-ai/dsh-client-connection': version,
            },
          }
        : {}),
    });
    await put(
      root,
      path + '/esm.js',
      'throw Error("UNAPPROVED_ESM_MUST_NOT_RUN");',
    );
    await put(
      root,
      path + '/cjs.cjs',
      'throw Error("UNAPPROVED_CJS_MUST_NOT_RUN");',
    );
    await put(root, path + '/esm-metadata.json', {
      version: 'wrong-esm-metadata',
    });
  }
  for (const name of ['dsh-commands', 'dsh-client-connection']) {
    const path = `${controllerPath}/node_modules/@deepseek-ai/${name}`;
    await put(root, path + '/package.json', {
      name: '@deepseek-ai/' + name,
      version,
      type: 'module',
      exports: './selected.js',
    });
    await put(
      root,
      path + '/selected.js',
      'throw Error("CONTROLLER_LOCAL_MUST_NOT_RUN");',
    );
  }
  for (const [name, path] of [
    ['@fixture/probe-only', 'node_modules/@fixture/probe-only'],
    ['@deepseek-ai/unused-root', 'node_modules/@deepseek-ai/unused-root'],
  ]) {
    await put(root, path! + '/package.json', {
      name,
      version: '1.0.0',
      type: 'module',
      exports: './index.js',
    });
    await put(
      root,
      path! + '/index.js',
      'throw Error("UNAPPROVED_PACKAGE_MUST_NOT_RUN");',
    );
  }
  await put(root, contractsPath + '/package.json', {
    name: '@allrice/contracts',
    version: '0.1.0',
    type: 'module',
    exports: {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './native-runtime': {
        types: './dist/native-runtime.d.ts',
        default: './dist/native-runtime.js',
      },
    },
    dependencies: { zod: '1.0.0' },
  });
  await put(
    root,
    contractsPath + '/dist/native-runtime.js',
    "export { schema } from './validator.js';",
  );
  await put(
    root,
    contractsPath + '/dist/validator.js',
    "import { marker } from 'zod'; export const schema = marker;",
  );
  await put(
    root,
    contractsPath + '/dist/index.js',
    'throw Error("UNUSED_BARREL_MUST_NOT_RUN");',
  );
  await put(root, contractsPath + '/dist/unrelated.js', 'unused JS');
  await put(
    root,
    contractsPath + '/dist/native-runtime.d.ts',
    'export declare const schema: unknown;',
  );
  await put(root, contractsPath + '/dist/validator.js.map', '{}');
  await put(root, 'node_modules/zod/package.json', {
    name: 'zod',
    version: '1.0.0',
    type: 'module',
    exports: { '.': { import: './import.js', require: './require.cjs' } },
  });
  await put(root, 'node_modules/zod/import.js', 'export const marker = 1;');
  await put(
    root,
    'node_modules/zod/require.cjs',
    'module.exports = {marker:2};',
  );
  await put(
    root,
    adapterPath,
    [
      "import { createRequire } from 'node:module';",
      "import { schema } from '@allrice/contracts/native-runtime';",
      'throw Error("ARTIFACT_MAIN_MUST_NOT_RUN");',
      `const installedModules = ${JSON.stringify(metadataModules)};`,
      'const requirePackage = createRequire(import.meta.url);',
      'installedModules.map((name) => requirePackage(`@deepseek-ai/${name}/package.json`).version);',
    ].join('\n'),
  );
  await put(
    root,
    factoryPath,
    `export const nativeScheduleModuleMap = ${JSON.stringify(moduleMap)};\nexport async function openNativeScheduleControlHost({source}) { const m = await source.loadModules(); return m.schedule; }`,
  );
  for (const profile of Object.values(nativeProfiles))
    await put(
      root,
      profile,
      "- id: fixture\n  name: '@deepseek-ai/dsh-agent'\n  config:\n    value: !!js process.env.NEVER_EVALUATE_THIS\n",
    );
  await put(
    root,
    'apps/worker/dsh/allrice-codex-cap-probe.cordis.yml',
    "- id: probe\n  name: '@fixture/probe-only'\n",
  );
  return root;
}
async function seal(root: string, schemaVersion: 1 | 2 = 2) {
  const result = await measureDshNativeArtifact(root, undefined, {
    schemaVersion,
  });
  await put(root, nativeArtifactPath, {
    ...result,
    source: { sha: 'a'.repeat(40), tree: 'b'.repeat(40) },
  });
  return result;
}

describe('native artifact v2: closed runtime boundary', () => {
  it('copies the approved portable JS closure with its resolver links and independently verifies the same content identity', async () => {
    const root = await fixture();
    const approved = await seal(root);
    const container = await realpath(
      await mkdtemp(join(tmpdir(), 'allrice-native-v2-copy-')),
    );
    owned.push(container);
    const target = join(container, 'portable');
    const result = await copyDshNativeArtifact({
      root,
      target,
      expectedId: approved.artifactId,
      sourceSha: 'a'.repeat(40),
      sourceTree: 'b'.repeat(40),
    });
    expect(result.artifactId).toBe(approved.artifactId);
    expect(result.storageCopied).toBe(false);
    expect(result.deploymentApprovalGranted).toBe(false);
    expect((await readdir(join(target, contractsPath, 'dist'))).sort()).toEqual(
      ['native-runtime.js', 'validator.js'],
    );
    const copied = await verifyDshNativeArtifact({
      root: target,
      expectedId: approved.artifactId,
      sourceSha: 'a'.repeat(40),
      sourceTree: 'b'.repeat(40),
    });
    expect(copied.content).toEqual(approved.content);
    expect(copied.source).toEqual({
      sha: 'a'.repeat(40),
      tree: 'b'.repeat(40),
    });
  });
  it('measures real JS, all public metadata/control/probe roots and their actual resolver modes without executing them', async () => {
    const root = await fixture();
    const result = await seal(root);
    expect(result.content.schemaVersion).toBe(2);
    expect(
      result.content.contractsRuntime?.files.map((file) => file.path),
    ).toEqual(['dist/native-runtime.js', 'dist/validator.js']);
    expect(
      result.content.packages.some(
        (p) => p.name === '@deepseek-ai/unused-root',
      ),
    ).toBe(false);
    expect(
      result.content.packages.some((p) => p.name === '@fixture/probe-only'),
    ).toBe(true);
    expect(
      result.content.imports.filter((i) => i.mode === 'cjs-metadata'),
    ).toHaveLength(7);
    expect(result.content.imports).toContainEqual(
      expect.objectContaining({
        specifier: '@deepseek-ai/dsh-agent/package.json',
        mode: 'cjs-metadata',
        target: 'node_modules/@deepseek-ai/dsh-agent/package.json',
      }),
    );
    expect(result.content.imports).toContainEqual(
      expect.objectContaining({
        specifier: '@deepseek-ai/dsh-commands',
        mode: 'cjs-control',
        anchor: controllerPath + '/cjs.cjs',
        target:
          controllerPath +
          '/node_modules/@deepseek-ai/dsh-commands/selected.js',
      }),
    );
    expect(result.content.imports).toContainEqual(
      expect.objectContaining({
        importer: contractsPath + '/dist/validator.js',
        specifier: 'zod',
        mode: 'esm',
        target: 'node_modules/zod/import.js',
      }),
    );
    expect(result.content.installation?.distribution).toEqual({
      generation,
      version,
      commit: '687f282e8625c6b8d11ff58211a90524be2e4317',
    });
    expect(
      await verifyDshNativeArtifact({
        root,
        expectedId: result.artifactId,
        sourceSha: 'a'.repeat(40),
        sourceTree: 'b'.repeat(40),
      }),
    ).toMatchObject({ artifactId: result.artifactId });
  });

  it('keeps v2 identity stable across unrelated source/install metadata, declarations, maps and data changes', async () => {
    const root = await fixture();
    const before = await v2(root);
    for (const [path, value] of [
      ['pnpm-lock.yaml', '# unrelated importer\nlockfileVersion: 9'],
      [
        'pnpm-workspace.yaml',
        'packages: []\npackageExtensions: {ui-only: {dependencies: {ui-child: 1}}}',
      ],
      [
        'patches/@deepseek-ai__old-rc3.patch',
        'changed historical patch explanation',
      ],
      ['apps/worker/dsh/patch-ledger.json', { changedHistoricalReason: true }],
      ['apps/worker/dsh/upstream.json', { provenanceChanged: true }],
      ['apps/worker/dsh/compatibility.json', { historicalTestsChanged: true }],
      [contractsPath + '/dist/native-runtime.d.ts', 'changed declarations'],
      [contractsPath + '/dist/validator.js.map', '{"changed":true}'],
      [contractsPath + '/dist/index.js', 'changed unused barrel'],
      [contractsPath + '/dist/unrelated.js', 'changed unused runtime module'],
      ['apps/worker/src/unrelated.ts', 'changed host observation only'],
      ['apps/web/unrelated.css', 'body { color: red }'],
      [
        '.local/sessions/synthetic.json',
        {
          employeeModel: 'different',
          tools: ['different'],
          business: 'different',
        },
      ],
    ] as const) {
      await put(root, path, value);
      expect((await v2(root)).artifactId, path).toBe(before.artifactId);
    }
    const pkg = JSON.parse(
      await readFile(join(root, contractsPath, 'package.json'), 'utf8'),
    );
    pkg.scripts = { unrelated: 'never-run' };
    pkg.exports['.'] = {
      types: './dist/other.d.ts',
      default: './dist/other-unused.js',
    };
    pkg.exports['./native-runtime'].types = './dist/changed.d.ts';
    await put(root, contractsPath + '/package.json', pkg);
    await put(root, 'apps/worker/package.json', {
      name: '@allrice/worker',
      scripts: { changed: 'unused' },
      dependencies: { '@deepseek-ai/undeployed-unused': '999' },
    });
    expect((await v2(root)).artifactId).toBe(before.artifactId);
    const catalog = JSON.parse(
      await readFile(join(root, 'apps/worker/dsh/distribution.json'), 'utf8'),
    );
    catalog.generations.push({
      generation: 'dsh-0.1.5-rc.3-a4c74a9',
      version: '0.1.5-rc.3',
      commit: 'a4c74a91e06b00fe0b0937bde982170c526cc842',
      profile: 'allrice-restricted.cordis.yml',
      frozenProfileAllowed: true,
      reason: 'changed governance only',
    });
    catalog.promotionPolicy = { changed: true };
    await put(root, 'apps/worker/dsh/distribution.json', catalog);
    expect((await v2(root)).artifactId).toBe(before.artifactId);
  });

  it.each([
    [
      contractsPath + '/dist/validator.js',
      "import { marker } from 'zod'; export const schema = marker + 1;",
    ],
    ['node_modules/zod/import.js', 'export const marker = 3;'],
    ['node_modules/zod/necessary-runtime.wasm', 'new necessary runtime bytes'],
    [
      'apps/worker/dsh/allrice-codex-cap-probe.cordis.yml',
      "- id: renamed-probe\n  name: '@fixture/probe-only'\n",
    ],
  ])(
    'invalidates an old approval when actual runtime bytes change: %s',
    async (path, value) => {
      const root = await fixture();
      const approved = await seal(root);
      await put(root, path!, value!);
      expect((await v2(root)).artifactId).not.toBe(approved.artifactId);
      await expect(
        verifyDshNativeArtifact({ root, expectedId: approved.artifactId }),
      ).rejects.toThrow('CONTENT_MISMATCH');
    },
  );

  it.each([
    ["export * from './index.js';", 'CONTRACTS_RUNTIME_TARGET'],
    [
      'const name = process.env.MODULE; await import(name);',
      'CONTRACTS_RUNTIME_IMPORT_UNCLOSED',
    ],
    [
      "import 'node:fs'; export const schema = 1;",
      'CONTRACTS_RUNTIME_IMPORT_UNCLOSED',
    ],
    ["export { x } from './asset.json';", 'CONTRACTS_RUNTIME_TARGET'],
  ])(
    'fails closed on an unclosed contracts runtime edge: %s',
    async (source, reason) => {
      const root = await fixture();
      await put(root, contractsPath + '/dist/validator.js', source!);
      await expect(v2(root)).rejects.toThrow(reason!);
    },
  );

  it('rejects the old barrel, missing/transplanted JS and a nearer contracts resolver override', async () => {
    const root = await fixture();
    const original = await readFile(join(root, adapterPath), 'utf8');
    await put(
      root,
      adapterPath,
      original.replace(
        '@allrice/contracts/native-runtime',
        '@allrice/contracts',
      ),
    );
    await expect(v2(root)).rejects.toThrow('CONTRACTS_ENTRY_REQUIRED');
    await put(root, adapterPath, original);
    const target = join(root, contractsPath, 'dist/validator.js');
    const bytes = await readFile(target);
    await rm(target);
    await expect(v2(root)).rejects.toThrow();
    await symlink(join(root, 'node_modules/zod/import.js'), target);
    await expect(v2(root)).rejects.toThrow('FILE_TYPE_OR_SIZE');
    await rm(target);
    await writeFile(target, bytes);
    await mkdir(join(root, contractsPath, 'dist/node_modules'));
    await expect(v2(root)).rejects.toThrow('NESTED_MODULE_OVERRIDE');
  });

  it('does not reuse a contracts slice for an uninspected third-party consumer', async () => {
    const root = await fixture();
    const path = 'node_modules/zod/package.json';
    const pkg = JSON.parse(await readFile(join(root, path), 'utf8'));
    pkg.dependencies = { '@allrice/contracts': '0.1.0' };
    await put(root, path, pkg);
    await expect(v2(root)).rejects.toThrow(
      'CONTRACTS_EXTERNAL_CONSUMER_UNCLOSED',
    );
  });

  it('measures only the selected distribution projection and rejects disabled or ambiguous selections', async () => {
    const root = await fixture();
    const before = await v2(root);
    const path = 'apps/worker/dsh/distribution.json';
    const catalog = JSON.parse(await readFile(join(root, path), 'utf8'));
    catalog.generations[0].commit = '687f282e8625c6b8d11ff58211a90524be2e4318';
    await put(root, path, catalog);
    expect((await v2(root)).artifactId).not.toBe(before.artifactId);
    catalog.generations[0].frozenProfileAllowed = false;
    await put(root, path, catalog);
    await expect(v2(root)).rejects.toThrow('V2_DISTRIBUTION');
    catalog.generations[0].frozenProfileAllowed = true;
    catalog.generations.push({ ...catalog.generations[0] });
    await put(root, path, catalog);
    await expect(v2(root)).rejects.toThrow('V2_DISTRIBUTION');
  });

  it('refuses missing/computed control mappings, missing used keys and a split cordis instance', async () => {
    const root = await fixture();
    await put(
      root,
      factoryPath,
      'export async function openNativeScheduleControlHost({source}) { const m = await source.loadModules(); return m.schedule; }',
    );
    await expect(v2(root)).rejects.toThrow('CONTROL_MODULE_MAP_REQUIRED');
    await put(
      root,
      factoryPath,
      'export const nativeScheduleModuleMap = JSON.parse(process.env.MAP);',
    );
    await expect(v2(root)).rejects.toThrow('V2_LITERAL_REQUIRED');
    await put(
      root,
      factoryPath,
      `export const nativeScheduleModuleMap = ${JSON.stringify(moduleMap)}; export function check(m) { return m.missing; }`,
    );
    await expect(v2(root)).rejects.toThrow('CONTROL_MODULE_MAP_UNCLOSED');
    await put(
      root,
      factoryPath,
      `export const nativeScheduleModuleMap = ${JSON.stringify(moduleMap)};`,
    );
    const path = controllerPath + '/node_modules/@deepseek-ai/cordis';
    await put(root, path + '/package.json', {
      name: '@deepseek-ai/cordis',
      version: '4.0.5',
      main: 'split.cjs',
    });
    await put(root, path + '/split.cjs', 'module.exports = {};');
    await expect(v2(root)).rejects.toThrow('CONTROL_CORDIS_RESOLUTION');
  });

  it('uses actual CJS package metadata exports and requires the third probe profile', async () => {
    const root = await fixture();
    const path = 'node_modules/@deepseek-ai/dsh-agent/package.json';
    const pkg = JSON.parse(await readFile(join(root, path), 'utf8'));
    pkg.exports['./package.json'].require = './esm-metadata.json';
    await put(root, path, pkg);
    await expect(v2(root)).rejects.toThrow('METADATA_RESOLUTION_MISMATCH');
    pkg.exports['./package.json'].require = './package.json';
    await put(root, path, pkg);
    await rm(join(root, 'apps/worker/dsh/allrice-codex-cap-probe.cordis.yml'));
    await expect(v2(root)).rejects.toThrow('V2_ENTRY_MISSING');
  });

  it('keeps v1 defaults and raw-input behavior while verification explicitly dispatches each approved schema', async () => {
    const root = await fixture();
    const legacy = await seal(root, 1);
    expect(await measureDshNativeArtifact(root)).toEqual(
      await measureDshNativeArtifact(root, undefined, { schemaVersion: 1 }),
    );
    expect(legacy.content).not.toHaveProperty('contractsRuntime');
    expect(legacy.content).not.toHaveProperty('installation');
    expect(
      (await verifyDshNativeArtifact({ root, expectedId: legacy.artifactId }))
        .artifactId,
    ).toBe(legacy.artifactId);
    await put(root, 'pnpm-lock.yaml', '# v1 raw change\nlockfileVersion: 9');
    await expect(
      verifyDshNativeArtifact({ root, expectedId: legacy.artifactId }),
    ).rejects.toThrow('CONTENT_MISMATCH');
    const modern = await seal(root, 2);
    expect(modern.artifactId).not.toBe(legacy.artifactId);
    expect(
      (await verifyDshNativeArtifact({ root, expectedId: modern.artifactId }))
        .content.schemaVersion,
    ).toBe(2);
    const unsupported = { ...modern.content, schemaVersion: 99 };
    const unsupportedId = digest(JSON.stringify(unsupported));
    await put(root, nativeArtifactPath, {
      artifactId: unsupportedId,
      content: unsupported,
    });
    await expect(
      verifyDshNativeArtifact({ root, expectedId: unsupportedId }),
    ).rejects.toThrow('MANIFEST_VERSION');
  });

  it('preserves independent approval, manifest digest and exact source-pair gates', async () => {
    const root = await fixture();
    const artifact = await seal(root);
    await expect(
      verifyDshNativeArtifact({ root, expectedId: '' }),
    ).rejects.toThrow('APPROVAL_REQUIRED');
    await expect(
      verifyDshNativeArtifact({ root, expectedId: digest('unapproved') }),
    ).rejects.toThrow('MANIFEST_DIGEST');
    await expect(
      verifyDshNativeArtifact({
        root,
        expectedId: artifact.artifactId,
        sourceSha: 'c'.repeat(40),
      }),
    ).rejects.toThrow('SOURCE_MISMATCH');
    await expect(
      verifyDshNativeArtifact({
        root,
        expectedId: artifact.artifactId,
        sourceTree: 'c'.repeat(40),
      }),
    ).rejects.toThrow('SOURCE_MISMATCH');
  });

  it('keeps the original bounded package walker and observational metrics in v2', async () => {
    const root = await fixture();
    for (let index = 0; index < 12; index++)
      await put(
        root,
        `node_modules/zod/leaves/${String(index).padStart(2, '0')}.txt`,
        'leaf-' + index,
      );
    const memory = vi.spyOn(process, 'availableMemory').mockReturnValue(0);
    const serial = await v2(root);
    memory.mockReturnValue(4 * 1024 ** 3);
    let active = 0,
      peak = 0;
    let release!: () => void;
    const batch = new Promise<void>((resolve) => {
      release = resolve;
    });
    io.read = async (path, read) => {
      if (!/\/zod\/leaves\/\d+\.txt$/.test(path)) return read();
      active++;
      peak = Math.max(peak, active);
      if (active === 4) release();
      try {
        await batch;
        return await read();
      } finally {
        active--;
      }
    };
    const metrics: Array<
      Parameters<NonNullable<Parameters<typeof measureDshNativeArtifact>[1]>>[0]
    > = [];
    expect(await v2(root, (metric) => metrics.push(metric))).toEqual(serial);
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(metrics.filter((m) => m.kind === 'package')).toHaveLength(
      serial.content.packages.length,
    );
    expect(metrics.some((m) => m.kind === 'read')).toBe(true);
    io.read = undefined;
    expect(
      await v2(root, () => {
        throw Error('diagnostics failed');
      }),
    ).toEqual(serial);
  });

  it('rereads contracts JS for AST checks and rejects replacement after the hash read', async () => {
    const root = await fixture();
    const target = join(root, contractsPath, 'dist/validator.js');
    let replaced = false;
    io.read = async (path, read) => {
      const bytes = await read();
      if (path === target && !replaced) {
        replaced = true;
        await writeFile(
          target,
          'const name = process.env.MODULE; await import(name);',
        );
      }
      return bytes;
    };
    await expect(v2(root)).rejects.toThrow('CONTRACTS_RUNTIME_CONTENT_CHANGED');
    expect(replaced).toBe(true);
  });
});

// Active helper coverage uses synthetic bytes only. The .node file is hashed,
// never dlopened. The actual ABI prerequisite remains a production root fact.
async function addNativeHelper(root: string) {
  const platforms = Object.fromEntries(
    [
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64-gnu',
      'linux-arm64-musl',
      'linux-x64-gnu',
      'linux-x64-musl',
      'win32-arm64-msvc',
      'win32-ia32-msvc',
      'win32-x64-msvc',
    ].map((name) => ['node-addon-require-builtin-' + name, '0.1.9']),
  );
  const host = nativeLoaderPlatformPackage({
    platform: process.platform,
    arch: process.arch,
    mappedLibraries:
      process.platform === 'linux'
        ? await readFile('/proc/self/maps', 'utf8')
        : undefined,
  });
  const entry = 'node_modules/node-addon-require-builtin';
  const helper = 'node_modules/node-addon-native-custom-loader';
  const binary = entry + '/node_modules/' + host;
  await put(root, 'pnpm-workspace.yaml', {
    packageExtensions: {
      'node-addon-native-custom-loader@0.1.9': {
        optionalDependencies: platforms,
      },
    },
  });
  for (const [
    path,
    name,
    optionalDependencies,
    dependencies,
    installedVersion,
  ] of [
    [
      entry,
      'node-addon-require-builtin',
      platforms,
      { 'node-addon-native-custom-loader': '0.1.9' },
      '0.1.9',
    ],
    [helper, 'node-addon-native-custom-loader', {}, {}, '0.1.9'],
    [binary, host, {}, {}, '0.1.9'],
    ['node_modules/' + host, host, {}, {}, '0.1.5'],
  ] as const) {
    await put(root, path + '/package.json', {
      name,
      version: installedVersion,
      main: 'index.cjs',
      optionalDependencies,
      dependencies,
    });
    await put(root, path + '/index.cjs', 'module.exports = {};');
  }
  await put(root, binary + '/native.node', 'synthetic binary bytes');
  await put(
    root,
    adapterPath,
    (await readFile(join(root, adapterPath), 'utf8')) +
      "\nimport 'node-addon-require-builtin';",
  );
  return { platforms, host, entry, helper, binary };
}
it('measures the active helper extension and actual helper-local platform edge, and rejects an old public hoist', async () => {
  const root = await fixture();
  const f = await addNativeHelper(root);
  await expect(v2(root)).rejects.toThrow('NATIVE_LOADER_PLATFORM_MISMATCH');
  const directory = join(root, f.helper, 'node_modules');
  await mkdir(directory);
  await symlink(
    relative(directory, join(root, f.binary)),
    join(directory, f.host),
  );
  const result = await seal(root);
  expect(
    result.content.installation?.nativeLoaderExtension?.optionalDependencies,
  ).toEqual(f.platforms);
  expect(result.content.dependencyEdges).toContainEqual({
    importer: f.helper,
    name: f.host,
    kind: 'optional',
    declared: '0.1.9',
    optional: true,
    target: f.binary,
  });
  await put(root, f.binary + '/native.node', 'changed synthetic binary');
  await expect(
    verifyDshNativeArtifact({ root, expectedId: result.artifactId }),
  ).rejects.toThrow('CONTENT_MISMATCH');
  await put(root, 'pnpm-workspace.yaml', {
    packageExtensions: {
      'node-addon-native-custom-loader@0.1.9': {
        optionalDependencies: f.platforms,
        dependencies: { 'unreviewed-extra-loader-edge': '1.0.0' },
      },
    },
  });
  await expect(v2(root)).rejects.toThrow('NATIVE_LOADER_EXTENSION');
  await put(root, 'pnpm-workspace.yaml', {
    packageExtensions: {
      'node-addon-native-custom-loader@0.1.9': { optionalDependencies: {} },
    },
  });
  await expect(v2(root)).rejects.toThrow('NATIVE_LOADER_EXTENSION');
  const helperMetadata = JSON.parse(
    await readFile(join(root, f.helper, 'package.json'), 'utf8'),
  );
  helperMetadata.version = '0.1.10';
  await put(root, f.helper + '/package.json', helperMetadata);
  await expect(v2(root)).rejects.toThrow('NATIVE_LOADER_UNSUPPORTED');
});
