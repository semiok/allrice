import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire, isBuiltin } from 'node:module';
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'acorn';
import { parseDocument, isMap, isSeq, isScalar } from 'yaml';

const hash = (bytes: string | Buffer) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const run = promisify(execFile);
export type DshNativeVerificationObserver = (
  metric:
    | { kind: 'read'; bytes: number }
    | { kind: 'package' }
    | { kind: 'cache'; hit: boolean },
) => void;
function observeNative(
  observer: DshNativeVerificationObserver | undefined,
  metric: Parameters<DshNativeVerificationObserver>[0],
) {
  try {
    observer?.(metric);
  } catch {
    /* diagnostics never grant or deny approval */
  }
}
const nativeDirectory = 'apps/worker/dsh';
export const nativeArtifactPath = '.local/dsh-native-artifact.json';
export const nativeProfiles = Object.freeze({
  restricted: 'apps/worker/dsh/allrice-restricted.cordis.yml',
  technical: 'apps/worker/dsh/allrice-technical.cordis.yml',
} as const);

interface FileFact {
  path: string;
  bytes: number;
  checksum: string;
}
interface PackageFact {
  path: string;
  name: string;
  version: string;
  files: number;
  bytes: number;
  checksum: string;
}
interface DependencyEdge {
  importer: string;
  name: string;
  kind: 'dependency' | 'optional' | 'peer';
  declared: string;
  optional: boolean;
  target: string | null;
}
interface ImportFact {
  importer: string;
  specifier: string;
  target: string;
  mode?: 'esm' | 'profile' | 'cjs-metadata' | 'cjs-control';
  anchor?: string;
}
interface ContractsRuntimeFact {
  packagePath: string;
  entrypoint: 'dist/native-runtime.js';
  resolution: {
    name: string;
    version: string;
    type: 'module';
    nativeExport: './dist/native-runtime.js';
    dependencies: Record<string, string>;
  };
  files: FileFact[];
}
interface NativeInstallationFact {
  distribution: { generation: string; version: string; commit: string };
  nativeLoaderExtension: null | {
    package: 'node-addon-native-custom-loader';
    version: '0.1.9';
    optionalDependencies: Record<string, string>;
  };
}
export interface DshNativeArtifactContent {
  schemaVersion: 1 | 2;
  generation: string;
  prerequisites: {
    nodeMajor: number;
    platform: string;
    arch: string;
    modules: string;
  };
  entrypoint: string;
  profiles: typeof nativeProfiles;
  requiredWire: { protocol: 1; taskProgress: 1; boundedReceiptDrain: 1 };
  files: FileFact[];
  packages: PackageFact[];
  dependencyEdges: DependencyEdge[];
  imports: ImportFact[];
  exclusions: readonly string[];
  // Present only in v2. v1 emits neither property, preserving its exact ID.
  installation?: NativeInstallationFact;
  contractsRuntime?: ContractsRuntimeFact;
}
export interface DshNativeArtifactManifest {
  artifactId: string;
  content: DshNativeArtifactContent;
  // Build provenance is not part of the portable content identity or approval.
  source?: { sha: string; tree: string };
}
interface PackageMetadata {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  type?: string;
  exports?: unknown;
  imports?: unknown;
}
export interface DshNativeArtifactMeasurementOptions {
  schemaVersion: 1 | 2;
}
function fail(reason: string): never {
  throw Error('DSH_NATIVE_ARTIFACT_' + reason);
}

/** Match the loaded process's libc, without executing an unapproved package or
 * the expensive process.report CPU inventory. Ambiguous Linux facts fail closed. */
export function nativeLoaderPlatformPackage(input: {
  platform: string;
  arch: string;
  mappedLibraries?: string;
}) {
  const base = `node-addon-require-builtin-${input.platform}-${input.arch}`;
  if (input.platform === 'win32') return base + '-msvc';
  if (input.platform !== 'linux') return base;
  const maps = input.mappedLibraries ?? '';
  const musl = /\/ld-musl-|\/libc\.musl-/.test(maps);
  const gnu = /\/libc\.so\.6|\/libc-2\.\d+\.so/.test(maps);
  if (musl === gnu) fail('NATIVE_LOADER_LIBC_UNKNOWN');
  return base + (gnu ? '-gnu' : '-musl');
}

/** Read data from the measured root, never execute that root's Worker. An
 * independently approved content ID still authorizes the actual artifact. */
function rootDistribution(bytes: Buffer) {
  const catalog = JSON.parse(bytes.toString()) as {
    schemaVersion?: unknown;
    installedGeneration?: unknown;
    generations?: {
      generation?: unknown;
      version?: unknown;
      commit?: unknown;
    }[];
  };
  const selected = Array.isArray(catalog.generations)
    ? catalog.generations.find(
        (item) => item && item.generation === catalog.installedGeneration,
      )
    : undefined;
  if (
    catalog.schemaVersion !== 2 ||
    typeof selected?.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(selected.version) ||
    typeof selected.commit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(selected.commit) ||
    selected.generation !==
      `dsh-${selected.version}-${selected.commit.slice(0, 7)}`
  )
    fail('ROOT_DISTRIBUTION');
  return {
    generation: selected.generation as string,
    version: selected.version,
  };
}

/** Measures reviewed code and the resolved declared dependency graph, never
 * credentials, prompts, personal Skills or the evaluated !!js profile values. */
export async function measureDshNativeArtifact(
  rootInput: string,
  observer?: DshNativeVerificationObserver,
  options: DshNativeArtifactMeasurementOptions = { schemaVersion: 1 },
): Promise<DshNativeArtifactManifest> {
  // Keep the public default compatible; new preparation must request v2.
  // Verification always dispatches from the independently approved manifest.
  const format = options.schemaVersion;
  if (format !== 1 && format !== 2) fail('MANIFEST_VERSION');
  const root = await realpath(rootInput);
  const files: FileFact[] = [],
    packages = new Map<string, PackageFact>();
  const dependencyEdges: DependencyEdge[] = [],
    imports: ImportFact[] = [];
  const inside = (path: string) => {
    if (!path.startsWith(root + sep)) fail('PATH_OUTSIDE_RELEASE');
    return relative(root, path);
  };
  const bytesAt = async (path: string) => {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 ** 2)
      fail('FILE_TYPE_OR_SIZE');
    if ((await realpath(path)) !== path) fail('FILE_RESOLUTION_CHANGED');
    inside(path);
    const bytes = await readFile(path);
    observeNative(observer, { kind: 'read', bytes: bytes.length });
    return bytes;
  };
  const fileFact = async (path: string): Promise<FileFact> => {
    const bytes = await bytesAt(path);
    return { path: inside(path), bytes: bytes.length, checksum: hash(bytes) };
  };
  const native = join(root, nativeDirectory);
  const distributionBytes = await bytesAt(join(native, 'distribution.json'));
  const distribution = rootDistribution(distributionBytes);
  let installation: NativeInstallationFact | undefined;
  let contractsRuntime: ContractsRuntimeFact | undefined;
  if (format === 2) {
    const catalog = JSON.parse(distributionBytes.toString()) as {
      generations: {
        generation: string;
        commit: string;
        profile?: string;
        frozenProfileAllowed?: boolean;
      }[];
    };
    const selected = catalog.generations.filter(
      (item) => item.generation === distribution.generation,
    );
    if (
      distribution.generation !== 'dsh-0.2.1-rc.2-687f282' ||
      selected.length !== 1 ||
      selected[0]!.profile !== 'allrice-restricted.cordis.yml' ||
      selected[0]!.frozenProfileAllowed !== true
    )
      fail('V2_DISTRIBUTION');
    installation = {
      distribution: { ...distribution, commit: selected[0]!.commit },
      nativeLoaderExtension: null,
    };
  }
  const productionModules: string[] = [];
  const profilePaths: string[] = [];
  const governanceNames = new Set([
    'distribution.json',
    'compatibility.json',
    'upstream.json',
    'patch-ledger.json',
  ]);
  for (const entry of (await readdir(native, { withFileTypes: true })).sort(
    (a, b) => order(a.name, b.name),
  )) {
    if (entry.name === 'fixtures' || entry.name.endsWith('.test.mjs')) continue;
    if (!entry.isFile()) fail('UNREVIEWED_NATIVE_DIRECTORY');
    const path = join(native, entry.name);
    if (format === 2 && governanceNames.has(entry.name)) continue;
    if (
      format === 2 &&
      !entry.name.endsWith('.mjs') &&
      !entry.name.endsWith('.cordis.yml')
    )
      fail('UNREVIEWED_NATIVE_FILE');
    files.push(await fileFact(path));
    if (entry.name.endsWith('.mjs')) productionModules.push(path);
    if (entry.name.endsWith('.cordis.yml')) profilePaths.push(inside(path));
  }
  if (format === 2)
    for (const path of [
      ...Object.values(nativeProfiles),
      nativeDirectory + '/allrice-codex-cap-probe.cordis.yml',
      nativeDirectory + '/native-schedule-host-factory.mjs',
    ])
      if (!files.some((fact) => fact.path === path)) fail('V2_ENTRY_MISSING');
  if (format === 1)
    for (const path of [
      'apps/worker/package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
    ])
      files.push(await fileFact(join(root, path)));
  if (format === 1)
    for (const name of (await readdir(join(root, 'patches'))).sort(order))
      if (name.startsWith('@deepseek-ai__') && name.endsWith('.patch'))
        files.push(await fileFact(join(root, 'patches', name)));

  // Public Node package search paths, anchored at each actual package instance.
  // A peer context is a path, never a name/version deduplication key.
  const locate = async (from: string, name: string): Promise<string | null> => {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) fail('PACKAGE_NAME');
    for (const folder of createRequire(
      join(from, 'package.json'),
    ).resolve.paths(name) ?? []) {
      const candidate = join(folder, name);
      try {
        await lstat(join(candidate, 'package.json'));
        const actual = await realpath(candidate);
        inside(actual);
        return actual;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return null;
  };
  const packageName = (specifier: string) =>
    specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0]!;
  const esmTargets = async (directory: string, names: readonly string[]) => {
    const query = [...new Set(names)].sort(order);
    if (!query.length) return new Map<string, string>();
    const script =
      'const names=JSON.parse(process.argv[1]);console.log(JSON.stringify(names.map(name=>[name,import.meta.resolve(name)])));';
    const result = await run(
      process.execPath,
      ['--input-type=module', '-e', script, JSON.stringify(query)],
      {
        cwd: directory,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        timeout: 15000,
        maxBuffer: 2 * 1024 ** 2,
      },
    );
    const resolved = new Map<string, string>(JSON.parse(result.stdout));
    if (resolved.size !== query.length) fail('IMPORT_RESOLUTION_MISMATCH');
    return resolved;
  };
  const resolvedFile = async (url: string) => {
    const value = new URL(url);
    if (value.protocol !== 'file:' || value.search || value.hash)
      fail('IMPORT_RESOLUTION_MISMATCH');
    const target = await realpath(fileURLToPath(value));
    inside(target);
    return target;
  };
  const rejectNearerModules = async (start: string, boundary: string) => {
    for (
      let directory = start;
      directory !== boundary;
      directory = dirname(directory)
    ) {
      if (!directory.startsWith(boundary + sep)) fail('PATH_OUTSIDE_RELEASE');
      try {
        await lstat(join(directory, 'node_modules'));
        fail('NESTED_MODULE_OVERRIDE');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  };
  const measureContracts = async (
    path: string,
    metadata: PackageMetadata,
  ): Promise<ContractsRuntimeFact> => {
    const exported = metadata.exports as Record<string, unknown> | undefined;
    const nativeExport = exported?.['./native-runtime'];
    const selected =
      typeof nativeExport === 'string'
        ? nativeExport
        : nativeExport &&
            typeof nativeExport === 'object' &&
            !Array.isArray(nativeExport) &&
            Object.keys(nativeExport).every(
              (key) => key === 'types' || key === 'default',
            )
          ? (nativeExport as Record<string, unknown>).default
          : undefined;
    if (
      metadata.type !== 'module' ||
      selected !== './dist/native-runtime.js' ||
      (metadata.imports !== undefined &&
        (!metadata.imports ||
          typeof metadata.imports !== 'object' ||
          Array.isArray(metadata.imports) ||
          Object.keys(metadata.imports).length))
    )
      fail('CONTRACTS_RUNTIME_EXPORT');
    const dist = join(path, 'dist');
    const entrypoint = join(dist, 'native-runtime.js');
    const queue = [entrypoint];
    const seen = new Set<string>();
    const members: FileFact[] = [];
    const external: { importer: string; specifier: string }[] = [];
    const used = new Set<string>();
    while (queue.length) {
      const module = queue.shift()!;
      if (seen.has(module)) continue;
      if (
        !module.startsWith(dist + sep) ||
        !module.endsWith('.js') ||
        module === join(dist, 'index.js') ||
        seen.size >= 100000
      )
        fail('CONTRACTS_RUNTIME_TARGET');
      seen.add(module);
      await rejectNearerModules(dirname(module), path);
      const fact = await fileFact(module);
      members.push({ ...fact, path: relative(path, module) });
      // Never cache completed buffers: parsing is an independent real read.
      const bytes = await bytesAt(module);
      if (hash(bytes) !== fact.checksum)
        fail('CONTRACTS_RUNTIME_CONTENT_CHANGED');
      const ast = parse(bytes.toString(), {
        ecmaVersion: 'latest',
        sourceType: 'module',
      });
      const add = (specifier: unknown) => {
        if (
          typeof specifier !== 'string' ||
          isBuiltin(specifier) ||
          specifier.startsWith('#')
        )
          fail('CONTRACTS_RUNTIME_IMPORT_UNCLOSED');
        if (specifier.startsWith('.')) {
          const url = new URL(specifier, pathToFileURL(module));
          if (url.search || url.hash) fail('CONTRACTS_RUNTIME_TARGET');
          const target = fileURLToPath(url);
          if (
            !target.startsWith(dist + sep) ||
            !target.endsWith('.js') ||
            target === join(dist, 'index.js')
          )
            fail('CONTRACTS_RUNTIME_TARGET');
          imports.push({
            importer: inside(module),
            specifier,
            target: inside(target),
            mode: 'esm',
            anchor: inside(module),
          });
          queue.push(target);
        } else {
          const name = packageName(specifier);
          if (
            name === '@allrice/contracts' ||
            !Object.hasOwn(metadata.dependencies ?? {}, name)
          )
            fail('CONTRACTS_RUNTIME_IMPORT_UNCLOSED');
          used.add(name);
          external.push({ importer: module, specifier });
        }
      };
      const scan = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const child of value) scan(child);
          return;
        }
        if (!value || typeof value !== 'object') return;
        const node = value as Record<string, unknown>;
        if (
          [
            'ImportDeclaration',
            'ExportNamedDeclaration',
            'ExportAllDeclaration',
          ].includes(String(node.type)) &&
          node.source
        )
          add((node.source as { value?: unknown }).value);
        if (node.type === 'ImportExpression')
          add((node.source as { value?: unknown }).value);
        if (node.type === 'CallExpression') {
          const callee = node.callee as { type?: string; name?: string };
          if (
            callee.type === 'Identifier' &&
            ['require', 'eval', 'Function'].includes(callee.name ?? '')
          )
            fail('CONTRACTS_RUNTIME_IMPORT_UNCLOSED');
        }
        if (
          node.type === 'NewExpression' &&
          (node.callee as { name?: string }).name === 'Function'
        )
          fail('CONTRACTS_RUNTIME_IMPORT_UNCLOSED');
        for (const child of Object.values(node))
          if (child && typeof child === 'object') scan(child);
      };
      scan(ast);
    }
    const groups = new Map<string, typeof external>();
    for (const item of external) {
      const directory = dirname(item.importer);
      groups.set(directory, [...(groups.get(directory) ?? []), item]);
    }
    for (const [directory, items] of [...groups].sort(([a], [b]) =>
      order(a, b),
    )) {
      const targets = await esmTargets(
        directory,
        items.map((item) => item.specifier),
      );
      for (const item of items) {
        const target = await resolvedFile(targets.get(item.specifier)!);
        const dependency = await locate(directory, packageName(item.specifier));
        const declaredTarget = await locate(path, packageName(item.specifier));
        if (
          !dependency ||
          dependency !== declaredTarget ||
          !target.startsWith(dependency + sep)
        )
          fail('IMPORT_RESOLUTION_MISMATCH');
        imports.push({
          importer: inside(item.importer),
          specifier: item.specifier,
          target: inside(target),
          mode: 'esm',
          anchor: inside(item.importer),
        });
      }
    }
    const dependencies = Object.fromEntries(
      [...used].sort(order).map((name) => {
        const declared = metadata.dependencies?.[name];
        if (typeof declared !== 'string' || !declared) fail('PACKAGE_METADATA');
        return [name, declared];
      }),
    );
    return {
      packagePath: inside(path),
      entrypoint: 'dist/native-runtime.js',
      resolution: {
        name: metadata.name,
        version: metadata.version,
        type: 'module',
        nativeExport: './dist/native-runtime.js',
        dependencies,
      },
      files: members.sort((a, b) => order(a.path, b.path)),
    };
  };
  const visit = async (path: string): Promise<void> => {
    const cached = packages.has(path);
    observeNative(observer, { kind: 'cache', hit: cached });
    if (cached) return;
    if (packages.size >= 1000) fail('PACKAGE_LIMIT');
    const metadata = JSON.parse(
      (await bytesAt(join(path, 'package.json'))).toString(),
    ) as PackageMetadata;
    if (
      typeof metadata.name !== 'string' ||
      typeof metadata.version !== 'string'
    )
      fail('PACKAGE_METADATA');
    if (
      metadata.name.startsWith('@deepseek-ai/dsh-') &&
      metadata.version !== distribution.version
    )
      fail('GENERATION_MISMATCH');
    if (
      format === 2 &&
      metadata.name === 'node-addon-native-custom-loader' &&
      metadata.version !== '0.1.9'
    )
      fail('NATIVE_LOADER_UNSUPPORTED');
    const item: PackageFact = {
      path: inside(path),
      name: metadata.name,
      version: metadata.version,
      files: 0,
      bytes: 0,
      checksum: '',
    };
    packages.set(path, item);
    observeNative(observer, { kind: 'package' });
    const packageFiles: FileFact[] = [];
    // At most four leaves of <=8 MiB (32 MiB declared payload) may overlap.
    // Larger leaves run alone under the existing 256 MiB limit. Unknown or
    // <4 GiB available memory keeps the original serial traversal. This bounds
    // tasks, not RSS or a file growing between lstat and readFile.
    const memory = (() => {
      try {
        return process.availableMemory?.() ?? 0;
      } catch {
        return 0;
      }
    })();
    const leafConcurrency =
      Number.isFinite(memory) && memory >= 4 * 1024 ** 3 ? 4 : 1;
    type LeafResult =
      { ok: true; fact: FileFact } | { ok: false; error: unknown };
    const walk = async (folder: string): Promise<void> => {
      const pending: Promise<LeafResult>[] = [];
      let failed = false;
      const flush = async () => {
        // Tasks always resolve to outcomes. Await all of them before returning
        // the first error in traversal order, even if a later read fails first.
        const completed = await Promise.all(pending.splice(0));
        for (const result of completed) {
          if (!result.ok) throw result.error;
          packageFiles.push(result.fact);
          if (packageFiles.length > 100000) fail('FILE_LIMIT');
        }
      };
      try {
        for (const entry of (
          await readdir(folder, { withFileTypes: true })
        ).sort((a, b) => order(a.name, b.name))) {
          if (failed) await flush();
          if (entry.name === 'node_modules') {
            await flush();
            if (folder !== path) fail('NESTED_MODULE_OVERRIDE');
            continue; // Declared edges below measure this resolution boundary.
          }
          const file = join(folder, entry.name);
          const stat = await lstat(file);
          if (stat.isSymbolicLink()) {
            await flush();
            fail('PACKAGE_FILE_LINK');
          }
          if (stat.isDirectory()) {
            await flush();
            await walk(file);
          } else {
            if (failed) await flush();
            const large = stat.size > 8 * 1024 ** 2;
            if (large) await flush();
            pending.push(
              (async (): Promise<LeafResult> => {
                try {
                  const fact = await fileFact(file);
                  return {
                    ok: true,
                    fact: { ...fact, path: relative(path, file) },
                  };
                } catch (error) {
                  failed = true;
                  return { ok: false, error };
                }
              })(),
            );
            if (large || pending.length >= leafConcurrency) await flush();
          }
        }
      } catch (error) {
        // Discovery follows earlier queued leaves in the serial traversal.
        // Drain them first; an earlier leaf error keeps priority over discovery.
        await flush();
        throw error;
      }
      await flush();
    };
    let runtimeSlice: ContractsRuntimeFact | undefined;
    if (metadata.name === '@allrice/contracts' && format === 2) {
      if (contractsRuntime && contractsRuntime.packagePath !== inside(path))
        fail('CONTRACTS_RUNTIME_MULTIPLE_INSTANCES');
      runtimeSlice = await measureContracts(path, metadata);
      contractsRuntime = runtimeSlice;
      packageFiles.push(...runtimeSlice.files);
    } else if (metadata.name === '@allrice/contracts') {
      packageFiles.push({
        ...(await fileFact(join(path, 'package.json'))),
        path: 'package.json',
      });
      await walk(join(path, 'dist'));
    } else await walk(path);
    packageFiles.sort((a, b) => order(a.path, b.path));
    item.files = packageFiles.length;
    item.bytes = packageFiles.reduce((n, f) => n + f.bytes, 0);
    item.checksum = hash(
      JSON.stringify(
        runtimeSlice
          ? { resolution: runtimeSlice.resolution, files: packageFiles }
          : packageFiles,
      ),
    );
    let effectiveOptional = runtimeSlice
      ? {}
      : (metadata.optionalDependencies ?? {});
    // The immutable legacy v1 ID already hashes the entry's optional platform
    // package, but not the helper's dynamic resolution edge. Preserve that ID
    // and require its actual lookup to reach the same already-measured target.
    // This is a consistency guard, not a new edge or a portable legacy copy.
    if (
      distribution.version === '0.1.5-rc.3' &&
      metadata.name === 'node-addon-native-custom-loader' &&
      metadata.version === '0.1.5'
    ) {
      const loader = await locate(worker, '@deepseek-ai/dsh-app-boot');
      const plugin =
        loader && (await locate(loader, '@deepseek-ai/cordis-plugin-loader'));
      const entry =
        plugin && (await locate(plugin, 'node-addon-require-builtin'));
      if (!entry) fail('LEGACY_NATIVE_LOADER_ENTRY_MISSING');
      const published = JSON.parse(
        (await bytesAt(join(entry, 'package.json'))).toString(),
      ) as PackageMetadata;
      const host = nativeLoaderPlatformPackage({
        platform: process.platform,
        arch: process.arch,
        mappedLibraries:
          process.platform === 'linux'
            ? await readFile('/proc/self/maps', 'utf8').catch(() => '')
            : undefined,
      });
      const declared = await locate(entry, host),
        actual = await locate(path, host);
      if (
        published.optionalDependencies?.[host] !== '0.1.5' ||
        !declared ||
        actual !== declared
      )
        fail('LEGACY_NATIVE_LOADER_RESOLUTION');
    }
    // pnpm extensions do not rewrite published package.json. This one known
    // helper performs a dynamic require from its own path, so measure its
    // effective optional edges explicitly. Historical approved roots retain
    // their original v1 identity and are never reinterpreted by this rule.
    if (
      distribution.version === '0.2.1-rc.2' &&
      metadata.name === 'node-addon-native-custom-loader' &&
      metadata.version === '0.1.9'
    ) {
      const loader =
        format === 1
          ? await locate(worker, '@deepseek-ai/cordis-plugin-loader')
          : null;
      // v2 follows the actual entry -> helper edge already discovered in this
      // traversal, rather than borrowing a same-named Worker hoist.
      const incoming =
        format === 2
          ? dependencyEdges.find(
              (edge) =>
                edge.name === metadata.name && edge.target === inside(path),
            )
          : undefined;
      const entry =
        format === 2
          ? incoming && join(root, incoming.importer)
          : loader && (await locate(loader, 'node-addon-require-builtin'));
      if (!entry) fail('NATIVE_LOADER_ENTRY_MISSING');
      const published = JSON.parse(
        (await bytesAt(join(entry, 'package.json'))).toString(),
      ) as PackageMetadata;
      const platforms = published.optionalDependencies ?? {};
      const workspace = parseDocument(
        (await bytesAt(join(root, 'pnpm-workspace.yaml'))).toString(),
      );
      if (workspace.errors.length) fail('NATIVE_LOADER_EXTENSION');
      const extension =
        workspace.toJS()?.packageExtensions?.[
          'node-addon-native-custom-loader@0.1.9'
        ]?.optionalDependencies;
      if (format === 2) {
        const selectedExtension =
          workspace.toJS()?.packageExtensions?.[
            'node-addon-native-custom-loader@0.1.9'
          ];
        if (
          !selectedExtension ||
          typeof selectedExtension !== 'object' ||
          Array.isArray(selectedExtension) ||
          JSON.stringify(Object.keys(selectedExtension).sort(order)) !==
            JSON.stringify(['optionalDependencies'])
        )
          fail('NATIVE_LOADER_EXTENSION');
      }
      const expected = [
        'darwin-arm64',
        'darwin-x64',
        'linux-arm64-gnu',
        'linux-arm64-musl',
        'linux-x64-gnu',
        'linux-x64-musl',
        'win32-arm64-msvc',
        'win32-ia32-msvc',
        'win32-x64-msvc',
      ]
        .map((suffix) => 'node-addon-require-builtin-' + suffix)
        .sort(order);
      if (
        published.name !== 'node-addon-require-builtin' ||
        published.version !== '0.1.9' ||
        !extension ||
        JSON.stringify(Object.keys(platforms).sort(order)) !==
          JSON.stringify(expected) ||
        JSON.stringify(Object.keys(extension).sort(order)) !==
          JSON.stringify(expected) ||
        expected.some(
          (name) => platforms[name] !== '0.1.9' || extension[name] !== '0.1.9',
        )
      )
        fail('NATIVE_LOADER_EXTENSION');
      if (format === 2)
        installation!.nativeLoaderExtension = {
          package: 'node-addon-native-custom-loader',
          version: '0.1.9',
          optionalDependencies: Object.fromEntries(
            expected.map((name) => [name, platforms[name]!]),
          ),
        };
      let hostPresent = false;
      const host = nativeLoaderPlatformPackage({
        platform: process.platform,
        arch: process.arch,
        mappedLibraries:
          process.platform === 'linux'
            ? await readFile('/proc/self/maps', 'utf8').catch(() => '')
            : undefined,
      });
      for (const name of expected) {
        const target = await locate(path, name);
        if (!target) continue;
        const binary = JSON.parse(
          (await bytesAt(join(target, 'package.json'))).toString(),
        ) as PackageMetadata;
        if (binary.name !== name || binary.version !== '0.1.9')
          fail('NATIVE_LOADER_PLATFORM_MISMATCH');
        if (name === host) hostPresent = true;
      }
      if (!hostPresent) fail('NATIVE_LOADER_PLATFORM_MISSING');
      effectiveOptional = { ...effectiveOptional, ...platforms };
    }
    const groups = [
      [
        'dependency',
        runtimeSlice?.resolution.dependencies ?? metadata.dependencies ?? {},
      ],
      ['optional', effectiveOptional],
      ['peer', runtimeSlice ? {} : (metadata.peerDependencies ?? {})],
    ] as const;
    for (const [kind, group] of groups)
      for (const name of Object.keys(group).sort(order)) {
        // Only the native subpath and its inspected JS may consume this slice.
        // A third-party consumer could select the root barrel instead.
        if (format === 2 && name === '@allrice/contracts')
          fail('CONTRACTS_EXTERNAL_CONSUMER_UNCLOSED');
        const optional =
          kind === 'optional' ||
          Object.hasOwn(metadata.optionalDependencies ?? {}, name) ||
          (kind === 'peer' &&
            metadata.peerDependenciesMeta?.[name]?.optional === true);
        const target = await locate(path, name);
        if (!target && !optional) fail('REQUIRED_DEPENDENCY_MISSING');
        dependencyEdges.push({
          importer: inside(path),
          name,
          kind,
          declared: group[name]!,
          optional,
          target: target ? inside(target) : null,
        });
        if (target) await visit(target);
      }
  };
  const worker = join(root, 'apps/worker');
  const declared = JSON.parse(
    (await bytesAt(join(worker, 'package.json'))).toString(),
  ) as PackageMetadata;
  const rootPackages = new Set<string>();
  if (format === 1)
    for (const name of Object.keys(declared.dependencies ?? {}).sort(order))
      if (
        name.startsWith('@deepseek-ai/') ||
        name.startsWith('@earendil-works/') ||
        ['@modelcontextprotocol/sdk', '@allrice/contracts', 'zod'].includes(
          name,
        )
      )
        rootPackages.add(name);

  // Parse our reviewed production modules, rather than scanning strings or
  // treating a CJS export resolution as Node ESM resolution evidence.
  const nativeImports: {
    importer: string;
    specifier: string;
    mode?: 'esm' | 'profile';
  }[] = [];
  const metadataNames: string[] = [];
  let computedMetadata = false;
  const controlModules = new Map<
    string,
    {
      specifier: string;
      anchor: 'factory' | 'controller';
    }
  >();
  const controlAccesses = new Set<string>();
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      fail('V2_LITERAL_REQUIRED');
    return value as Record<string, unknown>;
  };
  const literalName = (value: unknown) => {
    const node = record(value);
    if (node.type === 'Identifier' && typeof node.name === 'string')
      return node.name;
    if (node.type === 'Literal' && typeof node.value === 'string')
      return node.value;
    return fail('V2_LITERAL_REQUIRED');
  };
  const initializer = (ast: unknown, name: string, exported: boolean) => {
    for (const item of record(ast).body as unknown[]) {
      const outer = record(item);
      if (exported && outer.type !== 'ExportNamedDeclaration') continue;
      const statement =
        outer.type === 'ExportNamedDeclaration'
          ? record(outer.declaration)
          : outer;
      if (statement.type !== 'VariableDeclaration') continue;
      for (const declaration of statement.declarations as unknown[]) {
        const value = record(declaration);
        if (record(value.id).name !== name) continue;
        let init = record(value.init);
        if (init.type === 'CallExpression') {
          const callee = record(init.callee);
          if (
            callee.type !== 'MemberExpression' ||
            callee.computed ||
            record(callee.object).name !== 'Object' ||
            record(callee.property).name !== 'freeze' ||
            (init.arguments as unknown[]).length !== 1
          )
            fail('V2_LITERAL_REQUIRED');
          init = record((init.arguments as unknown[])[0]);
        }
        return init;
      }
    }
    return undefined;
  };
  for (const file of productionModules) {
    const bytes = await bytesAt(file);
    if (
      format === 2 &&
      hash(bytes) !== files.find((fact) => fact.path === inside(file))!.checksum
    )
      fail('FILE_CONTENT_CHANGED');
    const source = bytes.toString();
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    if (format === 2 && file === join(native, 'allrice-jsonrpc-runtime.mjs')) {
      const list = initializer(ast, 'installedModules', false);
      if (
        list?.type !== 'ArrayExpression' ||
        !(list.elements as unknown[]).length
      )
        fail('METADATA_MODULES_REQUIRED');
      for (const item of list.elements as unknown[]) {
        const node = record(item);
        if (
          node.type !== 'Literal' ||
          typeof node.value !== 'string' ||
          !/^[a-z0-9_.-]+$/.test(node.value)
        )
          fail('METADATA_MODULES_REQUIRED');
        metadataNames.push('@deepseek-ai/' + node.value);
      }
      if (new Set(metadataNames).size !== metadataNames.length)
        fail('METADATA_MODULES_REQUIRED');
    }
    if (
      format === 2 &&
      file === join(native, 'native-schedule-host-factory.mjs')
    ) {
      const map = initializer(ast, 'nativeScheduleModuleMap', true);
      if (map?.type !== 'ObjectExpression') fail('CONTROL_MODULE_MAP_REQUIRED');
      for (const item of map.properties as unknown[]) {
        const property = record(item);
        if (
          property.type !== 'Property' ||
          property.computed ||
          property.method ||
          property.kind !== 'init'
        )
          fail('CONTROL_MODULE_MAP_UNCLOSED');
        const key = literalName(property.key);
        const value = record(property.value);
        if (value.type !== 'ObjectExpression' || controlModules.has(key))
          fail('CONTROL_MODULE_MAP_UNCLOSED');
        const fields = new Map<string, string>();
        for (const field of value.properties as unknown[]) {
          const member = record(field);
          const literal = record(member.value);
          if (
            member.type !== 'Property' ||
            member.computed ||
            member.method ||
            member.kind !== 'init' ||
            literal.type !== 'Literal' ||
            typeof literal.value !== 'string'
          )
            fail('CONTROL_MODULE_MAP_UNCLOSED');
          const name = literalName(member.key);
          if (fields.has(name)) fail('CONTROL_MODULE_MAP_UNCLOSED');
          fields.set(name, literal.value);
        }
        const specifier = fields.get('specifier');
        const anchor = fields.get('anchor');
        if (
          fields.size !== 2 ||
          typeof specifier !== 'string' ||
          !/^@[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(specifier) ||
          (anchor !== 'factory' && anchor !== 'controller')
        )
          fail('CONTROL_MODULE_MAP_UNCLOSED');
        controlModules.set(key, { specifier, anchor });
      }
      if (
        !controlModules.size ||
        controlModules.get('controller')?.specifier !==
          '@deepseek-ai/dsh-api-session-controller' ||
        controlModules.get('controller')?.anchor !== 'factory' ||
        controlModules.get('cordis')?.specifier !== '@deepseek-ai/cordis' ||
        controlModules.get('cordis')?.anchor !== 'factory'
      )
        fail('CONTROL_MODULE_MAP_UNCLOSED');
    }
    const add = (value: unknown) => {
      if (typeof value !== 'string') fail('DYNAMIC_IMPORT');
      if (
        format === 2 &&
        packageName(value) === '@allrice/contracts' &&
        value !== '@allrice/contracts/native-runtime'
      )
        fail('CONTRACTS_ENTRY_REQUIRED');
      nativeImports.push({
        importer: inside(file),
        specifier: value,
        ...(format === 2 ? { mode: 'esm' as const } : {}),
      });
    };
    const scan = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const child of value) scan(child);
        return;
      }
      if (!value || typeof value !== 'object') return;
      const node = value as Record<string, unknown>;
      if (
        format === 2 &&
        file === join(native, 'native-schedule-host-factory.mjs') &&
        node.type === 'MemberExpression' &&
        record(node.object).type === 'Identifier' &&
        record(node.object).name === 'm'
      ) {
        const property = record(node.property);
        if (
          node.computed &&
          (property.type !== 'Literal' || typeof property.value !== 'string')
        )
          fail('CONTROL_MODULE_MAP_UNCLOSED');
        controlAccesses.add(literalName(property));
      }
      if (
        [
          'ImportDeclaration',
          'ExportNamedDeclaration',
          'ExportAllDeclaration',
        ].includes(String(node.type)) &&
        node.source
      )
        add((node.source as { value?: unknown }).value);
      if (node.type === 'ImportExpression')
        add((node.source as { value?: unknown }).value);
      // The only computed require in these modules reads the seven public
      // package.json files already covered by the complete declared roots.
      if (node.type === 'CallExpression') {
        const callee = node.callee as { type?: string; name?: string };
        if (
          callee.type === 'Identifier' &&
          ['require', 'requirePackage'].includes(callee.name ?? '')
        ) {
          const arg = (
            node.arguments as { type?: string; value?: unknown }[]
          )[0];
          if (arg?.type === 'Literal') {
            // No production adapter currently has a literal CJS import. Do
            // not mis-attest a new require with the ESM resolver below.
            if (format === 2) fail('NATIVE_CJS_IMPORT_UNCLOSED');
            add(arg.value);
          } else {
            if (
              callee.name !== 'requirePackage' ||
              source.slice(Number(node.start), Number(node.end)) !==
                'requirePackage(`@deepseek-ai/${name}/package.json`)' ||
              (format === 2 &&
                file !== join(native, 'allrice-jsonrpc-runtime.mjs'))
            )
              fail('DYNAMIC_REQUIRE');
            if (format === 2) computedMetadata = true;
          }
        }
      }
      for (const child of Object.values(node))
        if (child && typeof child === 'object') scan(child);
    };
    scan(ast);
  }
  if (format === 2) {
    if (!computedMetadata || !metadataNames.length)
      fail('METADATA_MODULES_REQUIRED');
    for (const key of controlAccesses)
      if (!controlModules.has(key)) fail('CONTROL_MODULE_MAP_UNCLOSED');
  }
  for (const profile of format === 2
    ? profilePaths
    : Object.values(nativeProfiles)) {
    const document = parseDocument(
      (await bytesAt(join(root, profile))).toString(),
      {
        customTags: [
          { tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value },
        ],
      },
    );
    if (document.errors.length || !isSeq(document.contents))
      fail('PROFILE_FORMAT');
    for (const entry of document.contents.items) {
      if (!isMap(entry)) fail('PROFILE_ENTRY');
      const name = entry.get('name', true);
      if (
        !isScalar(name) ||
        name.tag === 'tag:yaml.org,2002:js' ||
        typeof name.value !== 'string'
      )
        fail('PROFILE_DYNAMIC_NAME');
      nativeImports.push({
        importer: profile,
        specifier: name.value,
        ...(format === 2 ? { mode: 'profile' as const } : {}),
      });
    }
  }
  for (const item of nativeImports)
    if (
      format === 1 &&
      !isBuiltin(item.specifier) &&
      !item.specifier.startsWith('.')
    )
      rootPackages.add(packageName(item.specifier));
  // All production native modules and approved profiles share this flat,
  // closed directory. Reject a nearer resolver override before measuring.
  for (const path of [join(native, 'node_modules')]) {
    try {
      await lstat(path);
      fail('NATIVE_MODULE_OVERRIDE');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const query = [...new Set(nativeImports.map((x) => x.specifier))]
    .filter((s) => !isBuiltin(s))
    .sort(order);
  const script =
    'const names=JSON.parse(process.argv[1]);console.log(JSON.stringify(names.map(name=>[name,import.meta.resolve(name)])));';
  const result = await run(
    process.execPath,
    ['--input-type=module', '-e', script, JSON.stringify(query)],
    {
      cwd: native,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      timeout: 15000,
      maxBuffer: 2 * 1024 ** 2,
    },
  );
  const resolved = new Map<string, string>(JSON.parse(result.stdout));
  const rootsV2 = new Map<
    string,
    {
      importer: string;
      name: string;
      target: string;
    }
  >();
  const includeRoot = async (
    anchor: string,
    specifier: string,
    target: string,
  ) => {
    const name = packageName(specifier);
    const packageRoot = await locate(dirname(anchor), name);
    if (!packageRoot || !target.startsWith(packageRoot + sep))
      fail('IMPORT_RESOLUTION_MISMATCH');
    const value = {
      importer: inside(dirname(anchor)),
      name,
      target: inside(packageRoot),
    };
    rootsV2.set(JSON.stringify(value), value);
    return packageRoot;
  };
  for (const item of nativeImports) {
    if (isBuiltin(item.specifier)) continue;
    const target =
      format === 1
        ? await realpath(fileURLToPath(resolved.get(item.specifier)!))
        : await resolvedFile(resolved.get(item.specifier)!);
    inside(target);
    if (
      item.specifier.startsWith('.') &&
      !files.some((f) => f.path === inside(target))
    )
      fail('EXCLUDED_NATIVE_IMPORT');
    if (!item.specifier.startsWith('.')) {
      const packageRoot =
        format === 1
          ? await locate(worker, packageName(item.specifier))
          : await includeRoot(
              join(root, item.importer),
              item.specifier,
              target,
            );
      if (!packageRoot || !target.startsWith(packageRoot + sep))
        fail('IMPORT_RESOLUTION_MISMATCH');
      if (
        format === 2 &&
        packageName(item.specifier) === '@allrice/contracts' &&
        target !== join(packageRoot, 'dist/native-runtime.js')
      )
        fail('CONTRACTS_RUNTIME_EXPORT');
    }
    imports.push({
      ...item,
      target: inside(target),
      ...(format === 2 ? { anchor: item.importer } : {}),
    });
  }
  if (format === 2) {
    const adapter = join(native, 'allrice-jsonrpc-runtime.mjs');
    const factory = join(native, 'native-schedule-host-factory.mjs');
    const cjs = async (
      anchor: string,
      specifier: string,
      mode: 'cjs-metadata' | 'cjs-control',
      importer: string,
    ) => {
      const target = await realpath(createRequire(anchor).resolve(specifier));
      inside(target);
      const packageRoot = await includeRoot(anchor, specifier, target);
      const metadata = JSON.parse(
        (await bytesAt(join(packageRoot, 'package.json'))).toString(),
      ) as PackageMetadata;
      const name = packageName(specifier);
      if (
        metadata.name !== name ||
        metadata.version !==
          (name === '@deepseek-ai/cordis' ? '4.0.5' : distribution.version)
      )
        fail('CONTROL_OR_METADATA_VERSION');
      if (
        mode === 'cjs-metadata' &&
        target !== join(packageRoot, 'package.json')
      )
        fail('METADATA_RESOLUTION_MISMATCH');
      imports.push({
        importer: inside(importer),
        specifier,
        target: inside(target),
        mode,
        anchor: inside(anchor),
      });
      return target;
    };
    for (const name of metadataNames)
      await cjs(adapter, name + '/package.json', 'cjs-metadata', adapter);
    const controller = await cjs(
      factory,
      '@deepseek-ai/dsh-api-session-controller',
      'cjs-control',
      factory,
    );
    const cordis = await cjs(
      factory,
      '@deepseek-ai/cordis',
      'cjs-control',
      factory,
    );
    for (const [key, item] of [...controlModules].sort(([a], [b]) =>
      order(a, b),
    )) {
      const anchor = item.anchor === 'controller' ? controller : factory;
      const target =
        key === 'controller'
          ? controller
          : key === 'cordis'
            ? cordis
            : await cjs(anchor, item.specifier, 'cjs-control', factory);
      if (
        (await cjs(target, '@deepseek-ai/cordis', 'cjs-control', factory)) !==
        cordis
      )
        fail('CONTROL_CORDIS_RESOLUTION');
    }
    for (const item of [...rootsV2.values()].sort((a, b) =>
      order(JSON.stringify(a), JSON.stringify(b)),
    )) {
      dependencyEdges.push({
        ...item,
        kind: 'dependency',
        declared: 'native-runtime-root',
        optional: false,
      });
      await visit(join(root, item.target));
    }
    if (!contractsRuntime) fail('CONTRACTS_ENTRY_REQUIRED');
  }
  if (format === 1)
    for (const name of [...rootPackages].sort(order)) {
      if (name.startsWith('.') || name.startsWith('/') || name.includes(':'))
        fail('PACKAGE_SPECIFIER');
      const target = await locate(worker, name);
      if (!target) fail('NATIVE_DEPENDENCY_MISSING');
      dependencyEdges.push({
        importer: 'apps/worker',
        name,
        kind: 'dependency',
        declared: declared.dependencies?.[name] ?? 'profile-or-public-import',
        optional: false,
        target: inside(target),
      });
      await visit(target);
    }
  const content: DshNativeArtifactContent = {
    schemaVersion: 1,
    generation: distribution.generation,
    prerequisites: {
      nodeMajor: Number(process.versions.node.split('.')[0]),
      platform: process.platform,
      arch: process.arch,
      modules: process.versions.modules,
    },
    entrypoint: nativeDirectory + '/allrice-jsonrpc-runtime.mjs',
    profiles: nativeProfiles,
    requiredWire: { protocol: 1, taskProgress: 1, boundedReceiptDrain: 1 },
    files: files.sort((a, b) => order(a.path, b.path)),
    packages: [...packages.values()].sort((a, b) => order(a.path, b.path)),
    dependencyEdges: dependencyEdges.sort((a, b) =>
      order(JSON.stringify(a), JSON.stringify(b)),
    ),
    imports: imports.sort((a, b) =>
      order(JSON.stringify(a), JSON.stringify(b)),
    ),
    exclusions: [
      'apps/worker/dsh/fixtures/**',
      'apps/worker/dsh/*.test.mjs',
      'contracts source/tests; published dist measured',
      'credentials, evaluated environment, Session data, personal Skill bodies',
      'operating system and external programs',
    ],
  };
  if (format === 2) {
    content.schemaVersion = 2;
    content.installation = installation!;
    content.contractsRuntime = contractsRuntime!;
    content.exclusions = [
      'apps/worker/dsh/fixtures/**',
      'apps/worker/dsh/*.test.mjs',
      'unreachable contracts JS, declarations and source maps',
      'unrelated installation metadata and historical patch text; full-release seal required',
      'credentials, evaluated environment, Session data, personal Skill bodies',
      'operating system and external programs',
    ];
  }
  return { artifactId: hash(JSON.stringify(content)), content };
}

/** The independently supplied expected ID is deployment approval. A matching
 * self-generated JSON file alone never grants approval or execution rights. */
export async function verifyDshNativeArtifact(input: {
  root: string;
  expectedId: string;
  sourceSha?: string;
  sourceTree?: string;
  observe?: DshNativeVerificationObserver;
}) {
  if (!/^sha256:[a-f0-9]{64}$/.test(input.expectedId))
    fail('APPROVAL_REQUIRED');
  const root = await realpath(input.root);
  const path = join(root, nativeArtifactPath),
    stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 4 * 1024 ** 2 ||
    (await realpath(path)) !== path
  )
    fail('MANIFEST_FILE');
  const manifestBytes = await readFile(path);
  observeNative(input.observe, { kind: 'read', bytes: manifestBytes.length });
  const stored = JSON.parse(
    manifestBytes.toString('utf8'),
  ) as DshNativeArtifactManifest;
  if (
    stored.artifactId !== input.expectedId ||
    hash(JSON.stringify(stored.content)) !== input.expectedId
  )
    fail('MANIFEST_DIGEST');
  if (input.sourceSha && stored.source?.sha !== input.sourceSha)
    fail('SOURCE_MISMATCH');
  if (input.sourceTree && stored.source?.tree !== input.sourceTree)
    fail('SOURCE_MISMATCH');
  const format = stored.content.schemaVersion;
  if (format !== 1 && format !== 2) fail('MANIFEST_VERSION');
  const measured = await measureDshNativeArtifact(root, input.observe, {
    schemaVersion: format,
  });
  if (measured.artifactId !== input.expectedId) fail('CONTENT_MISMATCH');
  return {
    ...measured,
    source: stored.source,
    root,
    version: measured.content.generation.slice(4, -8),
  };
}

export function assertDshNativeLaunch(input: {
  artifact: Awaited<ReturnType<typeof verifyDshNativeArtifact>>;
  command: string;
  args: readonly string[];
  profile: string;
}) {
  const { artifact } = input;
  if (
    input.command !== process.execPath ||
    input.args.length !== 1 ||
    !isAbsolute(input.args[0]!) ||
    resolve(input.args[0]!) !== join(artifact.root, artifact.content.entrypoint)
  )
    fail('COMMAND_OVERRIDE');
  const profile = Object.entries(artifact.content.profiles).find(
    ([, path]) => join(artifact.root, path) === resolve(input.profile),
  );
  if (!profile) fail('PROFILE_OVERRIDE');
  return { artifactId: artifact.artifactId, profileId: profile[0] };
}

let approvedArtifact:
  Awaited<ReturnType<typeof verifyDshNativeArtifact>> | undefined;
const retainedArtifacts = new Map<
  string,
  Awaited<ReturnType<typeof verifyDshNativeArtifact>>
>();

export interface ApprovedDshNativeControlArtifact {
  artifactId: string;
  generation: string;
  root: string;
  content: Pick<
    DshNativeArtifactContent,
    'schemaVersion' | 'files' | 'packages'
  >;
}

/** Read-only exact lookup for a private control carrier. It registers nothing,
 * grants no business profile, and never substitutes another approved reader. */
export function approvedDshNativeControlArtifact(
  artifactId: string,
): ApprovedDshNativeControlArtifact {
  assertNativeLoader();
  const artifact =
    retainedArtifacts.get(artifactId) ??
    (approvedArtifact?.artifactId === artifactId
      ? approvedArtifact
      : undefined);
  if (!artifact) fail('CONTROL_NOT_APPROVED');
  return structuredClone({
    artifactId: artifact.artifactId,
    generation: artifact.content.generation,
    root: artifact.root,
    content: {
      schemaVersion: artifact.content.schemaVersion,
      files: artifact.content.files,
      packages: artifact.content.packages,
    },
  });
}

/** A v2 copy contains only the measured contracts runtime closure, not its
 * unrelated root barrel. Select its catalog through the exact installed
 * entrypoint; a missing catalog never falls back to the current Worker. */
export function approvedDshNativeToolCatalog(verifiedEntrypoint: string) {
  if (!approvedArtifact) {
    if (process.env.ALLRICE_SERVICE_ROLE === 'worker') fail('NOT_INSTALLED');
    return null; // Standalone, unapproved protocol fixtures keep their resolver.
  }
  assertNativeLoader();
  const artifact = [approvedArtifact, ...retainedArtifacts.values()].find(
    (item) =>
      isAbsolute(verifiedEntrypoint) &&
      resolve(verifiedEntrypoint) === join(item.root, item.content.entrypoint),
  );
  if (!artifact) fail('TOOL_CATALOG_NOT_APPROVED');
  if (artifact.content.schemaVersion === 1) return null;
  const runtime = artifact.content.contractsRuntime;
  const packages = artifact.content.packages.filter(
    (item) => item.name === '@allrice/contracts',
  );
  const catalogs = runtime?.files.filter(
    (file) => file.path === 'dist/tool-manifest.js',
  );
  if (
    !runtime ||
    packages.length !== 1 ||
    packages[0]!.path !== runtime.packagePath ||
    catalogs?.length !== 1
  )
    fail('TOOL_CATALOG_UNMEASURED');
  const catalog = catalogs[0]!;
  return {
    path: join(artifact.root, runtime.packagePath, catalog.path),
    bytes: catalog.bytes,
    checksum: catalog.checksum,
  };
}
let installing = false;
function assertNativeLoader() {
  const options = [...process.execArgv, process.env.NODE_OPTIONS ?? ''].join(
    ' ',
  );
  if (
    /(?:^|\s)(?:--(?:import|require|loader|experimental-loader|conditions|preserve-symlinks|preserve-symlinks-main)(?:=|\s|$)|-[rC])/.test(
      options,
    )
  )
    fail('LOADER_OVERRIDE');
}
export async function installDshNativeArtifact(
  input: Parameters<typeof verifyDshNativeArtifact>[0],
) {
  if (approvedArtifact || installing) fail('ALREADY_INSTALLED');
  assertNativeLoader();
  const began = performance.now();
  installing = true;
  try {
    approvedArtifact = await verifyDshNativeArtifact(input);
  } finally {
    installing = false;
  }
  return {
    artifactId: approvedArtifact.artifactId,
    generation: approvedArtifact.content.generation,
    verified: true,
    verificationMs: performance.now() - began,
  };
}

/** Deployment configuration only; Session/model parameters cannot register
 * code. Keep the complete measured layout and dependencies at this root. */
export async function installRetainedDshNativeArtifact(
  input: Parameters<typeof verifyDshNativeArtifact>[0],
) {
  if (!approvedArtifact || installing) fail('NOT_INSTALLED');
  if (retainedArtifacts.size >= 7 || retainedArtifacts.has(input.expectedId))
    fail('RETAINED_DUPLICATE_OR_LIMIT');
  assertNativeLoader();
  installing = true;
  try {
    if (
      !isAbsolute(input.root) ||
      resolve(input.root) !== (await realpath(input.root)) ||
      !(await lstat(input.root)).isDirectory()
    )
      fail('RETAINED_ROOT');
    const value = await verifyDshNativeArtifact(input);
    retainedArtifacts.set(value.artifactId, value);
    return {
      artifactId: value.artifactId,
      generation: value.content.generation,
      version: value.version,
      root: value.root,
    };
  } finally {
    installing = false;
  }
}

/** Exact immutable pin selection. Missing approval never falls back to the
 * primary artifact, including when another artifact has the same generation. */
export function nativeArtifactLaunchForPin(input: {
  artifactId: string;
  profileId: 'restricted' | 'technical';
}) {
  const artifact =
    retainedArtifacts.get(input.artifactId) ??
    (approvedArtifact?.artifactId === input.artifactId
      ? approvedArtifact
      : undefined);
  if (!artifact) fail('PIN_NOT_APPROVED');
  return {
    artifactId: artifact.artifactId,
    generation: artifact.content.generation,
    version: artifact.version,
    command: process.execPath,
    args: [join(artifact.root, artifact.content.entrypoint)],
    profile: join(artifact.root, artifact.content.profiles[input.profileId]),
  };
}

export function checkedDshNativeLaunch(input: {
  command: string;
  args: readonly string[];
  profile: string;
}) {
  if (!approvedArtifact) {
    // Standalone protocol fixtures are not a consuming Worker and carry no
    // verified artifact. Every production Worker installs before producers.
    if (process.env.ALLRICE_SERVICE_ROLE === 'worker') fail('NOT_INSTALLED');
    return null;
  }
  const selected = [approvedArtifact, ...retainedArtifacts.values()].find(
    (item) =>
      input.args.length === 1 &&
      isAbsolute(input.args[0]!) &&
      resolve(input.args[0]!) === join(item.root, item.content.entrypoint),
  );
  return assertDshNativeLaunch({
    ...input,
    artifact: selected ?? approvedArtifact,
  });
}
