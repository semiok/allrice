import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire, isBuiltin } from 'node:module';
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { parseDocument, isMap, isSeq, isScalar } from 'yaml';

const hash = (bytes: string | Buffer) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const run = promisify(execFile);
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
}
export interface DshNativeArtifactContent {
  schemaVersion: 1;
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
}
function fail(reason: string): never {
  throw Error('DSH_NATIVE_ARTIFACT_' + reason);
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
): Promise<DshNativeArtifactManifest> {
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
    return readFile(path);
  };
  const fileFact = async (path: string): Promise<FileFact> => {
    const bytes = await bytesAt(path);
    return { path: inside(path), bytes: bytes.length, checksum: hash(bytes) };
  };
  const native = join(root, nativeDirectory);
  const distribution = rootDistribution(
    await bytesAt(join(native, 'distribution.json')),
  );
  const productionModules: string[] = [];
  for (const entry of (await readdir(native, { withFileTypes: true })).sort(
    (a, b) => order(a.name, b.name),
  )) {
    if (entry.name === 'fixtures' || entry.name.endsWith('.test.mjs')) continue;
    if (!entry.isFile()) fail('UNREVIEWED_NATIVE_DIRECTORY');
    const path = join(native, entry.name);
    files.push(await fileFact(path));
    if (entry.name.endsWith('.mjs')) productionModules.push(path);
  }
  for (const path of [
    'apps/worker/package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
  ])
    files.push(await fileFact(join(root, path)));
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
  const visit = async (path: string): Promise<void> => {
    if (packages.has(path)) return;
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
    const item: PackageFact = {
      path: inside(path),
      name: metadata.name,
      version: metadata.version,
      files: 0,
      bytes: 0,
      checksum: '',
    };
    packages.set(path, item);
    const packageFiles: FileFact[] = [];
    const walk = async (folder: string): Promise<void> => {
      for (const entry of (await readdir(folder, { withFileTypes: true })).sort(
        (a, b) => order(a.name, b.name),
      )) {
        if (entry.name === 'node_modules') {
          if (folder !== path) fail('NESTED_MODULE_OVERRIDE');
          continue; // Declared edges below measure this resolution boundary.
        }
        const file = join(folder, entry.name);
        const stat = await lstat(file);
        if (stat.isSymbolicLink()) fail('PACKAGE_FILE_LINK');
        if (stat.isDirectory()) await walk(file);
        else {
          const fact = await fileFact(file);
          packageFiles.push({ ...fact, path: relative(path, file) });
          if (packageFiles.length > 100000) fail('FILE_LIMIT');
        }
      }
    };
    if (metadata.name === '@allrice/contracts') {
      packageFiles.push({
        ...(await fileFact(join(path, 'package.json'))),
        path: 'package.json',
      });
      await walk(join(path, 'dist'));
    } else await walk(path);
    packageFiles.sort((a, b) => order(a.path, b.path));
    item.files = packageFiles.length;
    item.bytes = packageFiles.reduce((n, f) => n + f.bytes, 0);
    item.checksum = hash(JSON.stringify(packageFiles));
    let effectiveOptional = metadata.optionalDependencies ?? {};
    // pnpm extensions do not rewrite published package.json. This one known
    // helper performs a dynamic require from its own path, so measure its
    // effective optional edges explicitly. Historical approved roots retain
    // their original v1 identity and are never reinterpreted by this rule.
    if (
      distribution.version === '0.2.1-rc.2' &&
      metadata.name === 'node-addon-native-custom-loader' &&
      metadata.version === '0.1.9'
    ) {
      const loader = await locate(worker, '@deepseek-ai/cordis-plugin-loader');
      const entry =
        loader && (await locate(loader, 'node-addon-require-builtin'));
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
      let hostPresent = false;
      const host = `node-addon-require-builtin-${process.platform}-${process.arch}`;
      for (const name of expected) {
        const target = await locate(path, name);
        if (!target) continue;
        const binary = JSON.parse(
          (await bytesAt(join(target, 'package.json'))).toString(),
        ) as PackageMetadata;
        if (binary.name !== name || binary.version !== '0.1.9')
          fail('NATIVE_LOADER_PLATFORM_MISMATCH');
        if (name === host || name.startsWith(host + '-')) hostPresent = true;
      }
      if (!hostPresent) fail('NATIVE_LOADER_PLATFORM_MISSING');
      effectiveOptional = { ...effectiveOptional, ...platforms };
    }
    const groups = [
      ['dependency', metadata.dependencies ?? {}],
      ['optional', effectiveOptional],
      ['peer', metadata.peerDependencies ?? {}],
    ] as const;
    for (const [kind, group] of groups)
      for (const name of Object.keys(group).sort(order)) {
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
  for (const name of Object.keys(declared.dependencies ?? {}).sort(order))
    if (
      name.startsWith('@deepseek-ai/') ||
      name.startsWith('@earendil-works/') ||
      ['@modelcontextprotocol/sdk', '@allrice/contracts', 'zod'].includes(name)
    )
      rootPackages.add(name);

  // Parse our reviewed production modules, rather than scanning strings or
  // treating a CJS export resolution as Node ESM resolution evidence.
  const nativeImports: { importer: string; specifier: string }[] = [];
  for (const file of productionModules) {
    const source = (await bytesAt(file)).toString();
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const add = (value: unknown) => {
      if (typeof value !== 'string') fail('DYNAMIC_IMPORT');
      nativeImports.push({ importer: inside(file), specifier: value });
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
          if (arg?.type === 'Literal') add(arg.value);
          else if (
            callee.name !== 'requirePackage' ||
            source.slice(Number(node.start), Number(node.end)) !==
              'requirePackage(`@deepseek-ai/${name}/package.json`)'
          )
            fail('DYNAMIC_REQUIRE');
        }
      }
      for (const child of Object.values(node))
        if (child && typeof child === 'object') scan(child);
    };
    scan(ast);
  }
  for (const profile of Object.values(nativeProfiles)) {
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
      nativeImports.push({ importer: profile, specifier: name.value });
    }
  }
  const packageName = (specifier: string) =>
    specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0]!;
  for (const item of nativeImports)
    if (!isBuiltin(item.specifier) && !item.specifier.startsWith('.'))
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
  for (const item of nativeImports) {
    if (isBuiltin(item.specifier)) continue;
    const target = await realpath(fileURLToPath(resolved.get(item.specifier)!));
    inside(target);
    if (
      item.specifier.startsWith('.') &&
      !files.some((f) => f.path === inside(target))
    )
      fail('EXCLUDED_NATIVE_IMPORT');
    if (!item.specifier.startsWith('.')) {
      const packageRoot = await locate(worker, packageName(item.specifier));
      if (!packageRoot || !target.startsWith(packageRoot + sep))
        fail('IMPORT_RESOLUTION_MISMATCH');
    }
    imports.push({ ...item, target: inside(target) });
  }
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
  return { artifactId: hash(JSON.stringify(content)), content };
}

/** The independently supplied expected ID is deployment approval. A matching
 * self-generated JSON file alone never grants approval or execution rights. */
export async function verifyDshNativeArtifact(input: {
  root: string;
  expectedId: string;
  sourceSha?: string;
  sourceTree?: string;
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
  const stored = JSON.parse(
    await readFile(path, 'utf8'),
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
  const measured = await measureDshNativeArtifact(root);
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
  if (retainedArtifacts.size >= 4 || retainedArtifacts.has(input.expectedId))
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
