import { createHash } from 'node:crypto';
import {
  readFile,
  writeFile,
  rm,
  mkdir,
  cp,
  mkdtemp,
  readdir,
  realpath,
  symlink,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve, relative, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { build } from 'esbuild';
import {
  WorkspaceAnalyzer,
  WorkspaceCaches,
  FaceModelEmitter,
  writePackageArtifacts,
} from '@deepseek-ai/dsh-typert-generator';

const root = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(root, '../..');
const lib = resolve(root, 'lib');
const require = createRequire(import.meta.url);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(
  await readFile(resolve(root, 'package.json'), 'utf8'),
);
const dshVersion = '0.2.1-rc.2';

// M3-05: rc.2's analyzer recognizes Remote identity from a registered
// protocol source project. These are the exact published declaration bytes,
// used only as build inputs; no native runtime/model/descriptor is authored.
const protocolDeclarations = {
  'index.d.ts':
    'abc85ba5decc22b4fe8773b49fbdd7b648560afc3289e2d053d07332bff19ebc',
  'json-value.d.ts':
    '9a20b430cf45612cc2d3a5d3f10a8d19d2690e3effb1c513c7991d57787c4352',
  'owned-value.d.ts':
    'fc1763edadf02c8c00d175d3c2e7784cc89e265c472e53026948544b8b914fe5',
  'principal.d.ts':
    '4a26eb780cc38714756c025724db3fc583b161ed17cb078ef32fdcc626cbbcd2',
  'remote-access.d.ts':
    '3a23e3f2c56778a5685c972ffb57c112b200c757ab923e9619b0d3d7f5ade776',
  'remote-error.d.ts':
    '47a11a8c1de82413cbf10bb4ed3ff9ece8a9e31c1f483fa86df1985b61a3d96c',
  'remote-info.d.ts':
    '7f6772ade81733c5b2ddfb249a6632b2699a7d1c213a6dd69aad2df7fbc38e7a',
  'types.d.ts':
    '0012b113b2b7518a19c0a5ccb637abb1c70cda29e59709c0b715627aa4634b98',
};

/** Build-only input adapter, shared with its direct tests. The CLI always uses
 * the installed public protocol export; the optional path permits isolated
 * corruption fixtures without ever changing an installed dependency.
 * @template T
 * @param {(options: import('@deepseek-ai/dsh-typert-generator').WorkspaceAnalyzerOptions) => T | Promise<T>} consume
 * @param {string} protocol
 * @returns {Promise<T>}
 */
export async function withPrincipalGeneratorInput(
  consume,
  protocol = dirname(
    require.resolve('@deepseek-ai/dsh-typert-protocol/package.json'),
  ),
) {
  const createdScratch = await mkdtemp(
    join(tmpdir(), 'allrice-principal-typert-'),
  );
  try {
    const scratch = await realpath(createdScratch);
    const nativeRoot = join(scratch, 'packages/d-entry-principal');
    const contractsRoot = join(scratch, 'packages/contracts');
    const protocolRoot = join(scratch, 'packages/protocol');
    const sourcePackages = [
      [root, nativeRoot],
      [join(workspace, 'packages/contracts'), contractsRoot],
    ];
    for (const [originalRoot, stagedRoot] of sourcePackages) {
      await cp(join(originalRoot, 'src'), join(stagedRoot, 'src'), {
        recursive: true,
        filter: (path) => !path.endsWith('.test.ts'),
      });
      await cp(
        join(originalRoot, 'package.json'),
        join(stagedRoot, 'package.json'),
      );
      if (stagedRoot === contractsRoot) {
        const path = join(stagedRoot, 'package.json');
        const contracts = JSON.parse(await readFile(path, 'utf8'));
        // The public analyzer maps lib/types to src, but not this owned
        // package's dist directory. Point only its temporary type entries at
        // the same real source exports already selected by authoring paths.
        for (const [subpath, entry] of [
          ['.', 'index'],
          ['./native-runtime', 'native-runtime'],
        ]) {
          if (contracts.exports[subpath].types !== `./dist/${entry}.d.ts`)
            throw Error('PRINCIPAL_CONTRACTS_EXPORTS_CHANGED');
          contracts.exports[subpath].types = `./src/${entry}.ts`;
        }
        await writeFile(path, JSON.stringify(contracts));
      }
      await symlink(
        join(originalRoot, 'node_modules'),
        join(stagedRoot, 'node_modules'),
        'dir',
      );
    }
    const protocolManifest = await readFile(join(protocol, 'package.json'));
    const metadata = JSON.parse(protocolManifest.toString());
    if (
      metadata.name !== '@deepseek-ai/dsh-typert-protocol' ||
      metadata.version !== dshVersion ||
      digest(protocolManifest) !==
        '7d989625c8ecc8f5f42457d2aae6acb7aba9db735ba45fed223d0608e2c62b0d'
    )
      throw Error('PRINCIPAL_PROTOCOL_PACKAGE_CHANGED');
    const declared = join(protocol, 'lib/types');
    const names = (await readdir(declared))
      .filter((name) => name.endsWith('.d.ts'))
      .sort();
    if (names.join(',') !== Object.keys(protocolDeclarations).sort().join(','))
      throw Error('PRINCIPAL_PROTOCOL_DECLARATIONS_CHANGED');
    const source = join(protocolRoot, 'src');
    await mkdir(source, { recursive: true });
    await writeFile(join(protocolRoot, 'package.json'), protocolManifest);
    for (const name of names) {
      const bytes = await readFile(join(declared, name));
      if (digest(bytes) !== protocolDeclarations[name])
        throw Error('PRINCIPAL_PROTOCOL_DECLARATIONS_CHANGED');
      const target = join(source, name.replace(/\.d\.ts$/, '.ts'));
      await writeFile(target, bytes);
      if (digest(await readFile(target)) !== protocolDeclarations[name])
        throw Error('PRINCIPAL_PROTOCOL_COPY_CHANGED');
    }
    await symlink(
      join(workspace, 'node_modules'),
      join(scratch, 'node_modules'),
      'dir',
    );
    await symlink(
      dirname(dirname(protocol)),
      join(protocolRoot, 'node_modules'),
      'dir',
    );
    // rc.2 checks each source project with rootDir fixed to the analyzer root.
    // Keep the real principal/contracts graph within that root, preserving the
    // existing aliases' targets and every original strict compiler option.
    const original = new WorkspaceCaches().config(join(root, 'tsconfig.json'))
      .parsed.options;
    const paths = Object.fromEntries(
      Object.entries(original.paths ?? {}).map(([name, targets]) => [
        name,
        targets.map((target) => {
          const absolute = resolve(original.baseUrl ?? workspace, target);
          const sourcePackage = sourcePackages.find(
            ([originalRoot]) =>
              absolute === originalRoot ||
              absolute.startsWith(`${originalRoot}${sep}`),
          );
          return sourcePackage
            ? resolve(sourcePackage[1], relative(sourcePackage[0], absolute))
            : absolute;
        }),
      ]),
    );
    const config = {
      extends: join(root, 'tsconfig.json'),
      compilerOptions: {
        paths: {
          ...paths,
          '@deepseek-ai/dsh-typert-protocol': [join(source, 'index.ts')],
        },
      },
      include: ['src/**/*.ts'],
    };
    for (const [originalRoot, packageRoot] of [
      ...sourcePackages,
      [root, protocolRoot],
    ])
      await writeFile(
        join(packageRoot, 'tsconfig.json'),
        JSON.stringify({
          ...config,
          extends: join(originalRoot, 'tsconfig.json'),
        }),
      );
    await writeFile(
      join(scratch, 'tsconfig.host.json'),
      JSON.stringify({
        ...config,
        include: [],
        files: [],
        references: [nativeRoot, contractsRoot, protocolRoot].map((path) => ({
          path,
        })),
      }),
    );
    return await consume({
      root: scratch,
      faces: ['host'],
      packages: [manifest.name],
      checkDiagnostics: true,
      rejectBuildOutputs: true,
    });
  } finally {
    // Remove only this created directory. fs.rm does not follow its symlinks.
    await rm(createdScratch, { recursive: true, force: true });
  }
}

async function buildPrincipal() {
  // A partial generation/build is never a prepared artifact: remove the old
  // receipt first and only publish the new receipt after all outputs validate.
  await rm(resolve(lib, 'current-principal.manifest.json'), { force: true });
  await mkdir(lib, { recursive: true });
  const generated = await withPrincipalGeneratorInput((options) => {
    const analysis = new WorkspaceAnalyzer(options).analyze();
    const host = analysis.faces.find((face) => face.face === 'host');
    if (!host) throw Error('PRINCIPAL_HOST_MODEL_MISSING');
    const artifact = new FaceModelEmitter(host).emit(manifest.name);
    if (!artifact.remote) throw Error('PRINCIPAL_REMOTE_MODEL_MISSING');
    return artifact;
  });
  writePackageArtifacts(root, [
    { ...generated, packageRoot: relative(workspace, root) },
  ]);
  await writeFile(
    resolve(lib, 'artifacts.js'),
    "export { TYPERT } from './typert.host.js';\nexport { TYPERT_REMOTE } from './typert.remote-client.js';\n",
  );
  await build({
    absWorkingDir: root,
    entryPoints: { types: 'src/types.ts', policy: 'src/policy.ts' },
    outdir: 'lib',
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external: ['@deepseek-ai/*'],
  });

  // Source, contracts, Zod and both generated contributions are one closure.
  // Only public guest DSH/Cordis exports stay external so class/service identity
  // is the actual Host's identity, resolved from its trusted CLI, not this tree.
  const output = await build({
    absWorkingDir: root,
    entryPoints: ['src/host.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    write: false,
    metafile: true,
    external: ['@deepseek-ai/*', 'node:*'],
    tsconfig: 'tsconfig.json',
  });
  const compiled = output.outputFiles[0];
  if (!compiled) throw Error('PRINCIPAL_HOST_BUILD_MISSING');
  const publicImports = [
    ...new Set(
      Object.values(output.metafile.outputs).flatMap((file) =>
        file.imports
          .filter((entry) => entry.external && !entry.path.startsWith('node:'))
          .map((entry) => entry.path),
      ),
    ),
  ].sort();
  const modules = [];
  for (const specifier of publicImports) {
    if (
      !specifier.startsWith('@deepseek-ai/') ||
      specifier.includes('/src/') ||
      specifier.endsWith('/internal')
    )
      throw Error('PRINCIPAL_PRIVATE_IMPORT');
    const packageName = specifier.split('/').slice(0, 2).join('/');
    const version = JSON.parse(
      await readFile(require.resolve(`${packageName}/package.json`), 'utf8'),
    ).version;
    if (
      (packageName === '@deepseek-ai/cordis' && version !== '4.0.5') ||
      (packageName.startsWith('@deepseek-ai/dsh-') && version !== dshVersion)
    )
      throw Error('PRINCIPAL_MODULE_VERSION');
    modules.push({
      specifier,
      version,
      sha256: digest(await readFile(require.resolve(specifier))),
    });
  }
  const source = `import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
export const name = 'allrice-current-principal';
export const inject = ['connection', 'remoteAccess', 'typertGateway', 'typert', 'sessionController'];
const expected = ${JSON.stringify(modules)};
export async function apply(ctx, config) {
  const resolve = createRequire(config.moduleBase);
  const modules = new Map();
  for (const entry of expected) {
    const name = entry.specifier.split('/').slice(0, 2).join('/');
    const manifest = JSON.parse(await readFile(resolve.resolve(name + '/package.json'), 'utf8'));
    const path = resolve.resolve(entry.specifier);
    const hash = createHash('sha256').update(await readFile(path)).digest('hex');
    if (manifest.version !== entry.version || hash !== entry.sha256) throw Error('PRINCIPAL_GUEST_ARTIFACT_MISMATCH');
    modules.set(entry.specifier, await import(pathToFileURL(path).href));
  }
  const module = { exports: {} };
  const require = (name) => {
    if (name.startsWith('node:')) return resolve(name);
    if (!modules.has(name)) throw Error('PRINCIPAL_UNSEALED_IMPORT');
    return modules.get(name);
  };
  ((require, module, exports) => {
${compiled.text}
  })(require, module, module.exports);
  if (typeof module.exports.apply !== 'function') throw Error('PRINCIPAL_PLUGIN_MISSING');
  return module.exports.apply(ctx, config);
}
`;
  await writeFile(resolve(lib, 'host.js'), source);
  const declarations = spawnSync(
    process.execPath,
    [
      require.resolve('typescript/bin/tsc'),
      '-p',
      resolve(root, 'tsconfig.build.json'),
    ],
    { stdio: 'inherit' },
  );
  if (declarations.status !== 0) throw Error('PRINCIPAL_DECLARATIONS_FAILED');
  const files = [];
  for (const path of [
    'host.js',
    'types.js',
    'policy.js',
    'artifacts.js',
    'typert.host.js',
    'typert.host.d.ts',
    'typert.remote-client.js',
    'typert.remote-client.d.ts',
    'typert.remote-client.d.ts.map',
    'types/host.d.ts',
    'types/types.d.ts',
    'types/policy.d.ts',
  ]) {
    files.push({ path, sha256: digest(await readFile(resolve(lib, path))) });
  }
  await writeFile(
    resolve(lib, 'current-principal.manifest.json'),
    `${JSON.stringify({ schema: 1, package: manifest.name, version: manifest.version, dshVersion, files, modules }, null, 2)}\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await buildPrincipal();
