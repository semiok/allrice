import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const checksum = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const role = z.enum(['web', 'worker']);
export type ServiceBuildRole = z.infer<typeof role>;
const relativePath = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      p.split('/').every((s) => s !== '' && s !== '.' && s !== '..'),
  );
const fileSchema = z
  .object({
    path: relativePath,
    scope: z.enum(['web', 'worker', 'graph']),
    checksum,
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1024 ** 2),
  })
  .strict();
const workspaceEdgeSchema = z
  .object({
    importer: relativePath,
    dependency: z.string().regex(/^@allrice\/[a-z0-9-]+$/),
    packagePath: relativePath,
    specifier: z.string().min(1).max(200),
    entrypoint: relativePath,
    checksum,
  })
  .strict();
const manifestBodySchema = z
  .object({
    version: z.literal(1),
    environment: z.literal('dev'),
    repository: z.literal('semiok/allrice'),
    sourceSha: sha,
    sourceTree: sha,
    webBuildId: z.string().min(1).max(200),
    protocols: z
      .object({
        identity: z.literal(1),
        ordinaryConsumer: z.literal(1),
        releaseAdmission: z.literal('disabled'),
      })
      .strict(),
    files: z.array(fileSchema).min(4).max(10000),
    workspaceEdges: z.array(workspaceEdgeSchema).max(1000),
  })
  .strict();
export const ServiceBuildManifestSchema = manifestBodySchema
  .extend({ manifestDigest: checksum })
  .strict();
export type ServiceBuildManifest = z.infer<typeof ServiceBuildManifestSchema>;
export interface ServiceBuildIdentity {
  version: 1;
  environment: 'dev';
  service: ServiceBuildRole;
  mode: 'production';
  sourceSha: string;
  sourceTree: string;
  manifestDigest: string;
  artifactDigest: string;
  runtimeGraphDigest: string;
  webBuildId: string;
  bootId: string;
  pid: number;
  startedAt: string;
  nodeVersion: string;
  protocols: ServiceBuildManifest['protocols'];
}
const digest = (value: string | Buffer) =>
  'sha256:' + createHash('sha256').update(value).digest('hex');
const fileDigest = (files: ServiceBuildManifest['files']) =>
  digest(JSON.stringify(files));

type WorkspacePackage = {
  path: string;
  data: {
    dependencies?: Record<string, string>;
    main?: string;
    exports?: unknown;
  };
};
async function workspacePackages(root: string) {
  const packages = new Map<string, WorkspacePackage>();
  for (const folder of ['apps', 'packages']) {
    for (const entry of await readdir(join(root, folder))) {
      const path = folder + '/' + entry;
      try {
        const data = JSON.parse(
          (await bytesAt(root, path + '/package.json')).toString(),
        );
        if (typeof data.name === 'string') {
          if (packages.has(data.name))
            throw Error('DEV_BUILD_RUNTIME_GRAPH_INVALID');
          packages.set(data.name, { path, data });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return packages;
}

// Current workspace exports use unconditional/default runtime targets. Reject
// conditional import/require maps rather than attest a CJS target for ESM.
function runtimeExports(pkg: WorkspacePackage): [string, string][] {
  const target = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => key === 'types' || key === 'default') &&
      typeof (value as { default?: unknown }).default === 'string'
    )
      return (value as { default: string }).default;
    throw Error('DEV_BUILD_RUNTIME_EXPORT_UNSUPPORTED');
  };
  const exports = pkg.data.exports;
  const entries: [string, string][] =
    exports &&
    typeof exports === 'object' &&
    !Array.isArray(exports) &&
    Object.keys(exports).every((key) => key === '.' || key.startsWith('./'))
      ? Object.entries(exports).map(([key, value]) => [key, target(value)])
      : [['.', target(exports ?? pkg.data.main)]];
  for (const [key, path] of entries) {
    if (key.includes('*') || !path.startsWith('./'))
      throw Error('DEV_BUILD_RUNTIME_EXPORT_UNSUPPORTED');
    relativePath.parse(path.slice(2));
  }
  return entries;
}

async function resolveWorkspaceGraph(
  root: string,
  packages: Map<string, WorkspacePackage>,
) {
  const pending = ['@allrice/web', '@allrice/worker'],
    seen = new Set<string>();
  const edges: ServiceBuildManifest['workspaceEdges'] = [];
  while (pending.length) {
    const name = pending.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const importer = packages.get(name);
    if (!importer) throw Error('DEV_BUILD_RUNTIME_GRAPH_MISSING');
    const resolver = createRequire(join(root, importer.path, 'package.json'));
    const dependencies = Object.entries(importer.data.dependencies ?? {})
      .filter(
        ([name, version]) =>
          name.startsWith('@allrice/') || version.startsWith('workspace:'),
      )
      .map(([name]) => name);
    for (const dependency of dependencies) {
      if (!packages.has(dependency))
        throw Error('DEV_BUILD_RUNTIME_GRAPH_MISSING');
      const pkg = packages.get(dependency)!;
      if (
        (await realpath(
          join(root, importer.path, 'node_modules', dependency),
        )) !== join(root, pkg.path)
      )
        throw Error('DEV_BUILD_RUNTIME_GRAPH_INVALID');
      for (const [subpath, exportedPath] of runtimeExports(pkg)) {
        const specifier =
          dependency + (subpath === '.' ? '' : subpath.slice(1));
        const entrypoint = await realpath(resolver.resolve(specifier));
        const expected = join(root, pkg.path, exportedPath.slice(2));
        if (entrypoint !== expected)
          throw Error('DEV_BUILD_RUNTIME_GRAPH_INVALID');
        edges.push({
          importer: importer.path,
          dependency,
          packagePath: pkg.path,
          specifier,
          entrypoint: relative(root, entrypoint),
          checksum: digest(await bytesAt(root, relative(root, entrypoint))),
        });
      }
      pending.push(dependency);
    }
  }
  edges.sort(
    (a, b) =>
      a.importer.localeCompare(b.importer) ||
      a.specifier.localeCompare(b.specifier),
  );
  return { edges, names: seen };
}

async function bytesAt(root: string, path: string) {
  const target = join(root, path);
  const stat = await lstat(target);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 64 * 1024 ** 2 ||
    !(await realpath(target)).startsWith(root + sep)
  )
    throw Error('DEV_BUILD_IDENTITY_INVALID');
  return readFile(target);
}
async function walk(
  root: string,
  path: string,
  scope: 'web' | 'worker' | 'graph',
  files: ServiceBuildManifest['files'],
) {
  // Node resolves dependencies from the nearest importer directory. A nested
  // node_modules layer could bypass the package-root links measured below.
  if (path.split('/').includes('node_modules'))
    throw Error('DEV_BUILD_RUNTIME_GRAPH_INVALID');
  const target = join(root, path),
    stat = await lstat(target);
  if (stat.isSymbolicLink()) throw Error('DEV_BUILD_IDENTITY_INVALID');
  if (stat.isDirectory()) {
    for (const entry of (await readdir(target)).sort())
      await walk(root, path + '/' + entry, scope, files);
  } else {
    const bytes = await bytesAt(root, path);
    files.push({ path, scope, checksum: digest(bytes), bytes: bytes.length });
    if (files.length > 10000) throw Error('DEV_BUILD_IDENTITY_INVALID');
  }
}

/** Operator-only preparation; caller must prove the exact clean Git SHA/tree.
 * No model/browser path, command, credential or deployment permission is accepted. */
export async function prepareServiceBuildManifest(input: {
  root: string;
  sourceSha: string;
  sourceTree: string;
}): Promise<ServiceBuildManifest> {
  sha.parse(input.sourceSha);
  sha.parse(input.sourceTree);
  const root = await realpath(input.root),
    files: ServiceBuildManifest['files'] = [];
  await walk(root, 'apps/web/.next/server', 'web', files);
  await walk(root, 'apps/web/.next/static', 'web', files);
  await walk(root, 'apps/web/server.mjs', 'web', files);
  await walk(root, 'apps/web/server', 'web', files);
  for (const entry of await readdir(join(root, 'apps/web/.next'))) {
    if (entry === 'node_modules')
      throw Error('DEV_BUILD_RUNTIME_GRAPH_INVALID');
    if ((await lstat(join(root, 'apps/web/.next', entry))).isFile())
      await walk(root, 'apps/web/.next/' + entry, 'web', files);
  }
  await walk(root, 'apps/worker/dist', 'worker', files);
  const packages = await workspacePackages(root);
  const graph = await resolveWorkspaceGraph(root, packages);
  for (const name of graph.names) {
    const pkg = packages.get(name);
    if (!pkg) throw Error('DEV_BUILD_RUNTIME_GRAPH_MISSING');
    await walk(root, pkg.path + '/package.json', 'graph', files);
    const entries = (value: unknown): string[] =>
      typeof value === 'string'
        ? [value]
        : value && typeof value === 'object'
          ? Object.values(value).flatMap(entries)
          : [];
    if (
      [pkg.data.main, ...entries(pkg.data.exports)].some(
        (p) => typeof p === 'string' && p.includes('dist/'),
      )
    ) {
      await walk(root, pkg.path + '/dist', 'graph', files);
    }
  }
  for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
    await walk(root, path, 'graph', files);
  files.sort(
    (a, b) => a.path.localeCompare(b.path) || a.scope.localeCompare(b.scope),
  );
  const body = manifestBodySchema.parse({
    version: 1,
    environment: 'dev',
    repository: 'semiok/allrice',
    sourceSha: input.sourceSha,
    sourceTree: input.sourceTree,
    webBuildId: (await bytesAt(root, 'apps/web/.next/BUILD_ID'))
      .toString()
      .trim(),
    protocols: {
      identity: 1,
      ordinaryConsumer: 1,
      releaseAdmission: 'disabled',
    },
    files,
    workspaceEdges: graph.edges,
  });
  return ServiceBuildManifestSchema.parse({
    ...body,
    manifestDigest: digest(JSON.stringify(body)),
  });
}

/** Actual entrypoint and artifact bytes, not a guessed revision from an env var.
 * Absent manifest is legacy/unverified. A present but invalid manifest is fatal. */
export async function verifyServiceBuildIdentity(input: {
  entrypoint: string;
  service: ServiceBuildRole;
  claimedSha?: string;
  mode: 'production' | 'development';
}): Promise<ServiceBuildIdentity | null> {
  role.parse(input.service);
  // Next development serves .next/dev and source reloads; a retained production
  // build in the same worktree cannot attest that running development process.
  if (input.mode !== 'production') return null;
  const entrypoint = await realpath(input.entrypoint);
  const ending =
    input.service === 'web'
      ? '/apps/web/server.mjs'
      : '/apps/worker/dist/index.js';
  if (!entrypoint.endsWith(ending)) return null;
  const root = entrypoint.slice(0, -ending.length);
  let bytes: Buffer;
  try {
    bytes = await bytesAt(root, '.local/dev-build-identity.json');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw Error('DEV_BUILD_IDENTITY_INVALID');
  }
  try {
    if (bytes.length > 4 * 1024 ** 2) throw Error('invalid');
    const manifest = ServiceBuildManifestSchema.parse(
      JSON.parse(bytes.toString()),
    );
    const { manifestDigest, ...body } = manifest;
    if (
      digest(JSON.stringify(body)) !== manifestDigest ||
      (input.claimedSha !== undefined &&
        input.claimedSha !== manifest.sourceSha)
    )
      throw Error('invalid');
    const paths = manifest.files.map((file) => file.scope + ':' + file.path);
    if (new Set(paths).size !== paths.length) throw Error('invalid');
    const selected = manifest.files.filter(
      (file) => file.scope === input.service || file.scope === 'graph',
    );
    if (
      !selected.some((file) => file.path === relative(root, entrypoint)) ||
      !selected.some((file) => file.scope === 'graph')
    )
      throw Error('invalid');
    // Re-enumerate actual runtime directories, including additions after
    // sealing. Reading only the old file list misses new resolver overrides.
    const measured = await prepareServiceBuildManifest({
      root,
      sourceSha: manifest.sourceSha,
      sourceTree: manifest.sourceTree,
    });
    if (measured.manifestDigest !== manifestDigest) throw Error('invalid');
    return {
      version: 1,
      environment: 'dev',
      service: input.service,
      mode: 'production',
      sourceSha: manifest.sourceSha,
      sourceTree: manifest.sourceTree,
      manifestDigest,
      artifactDigest: fileDigest(
        manifest.files.filter((file) => file.scope === input.service),
      ),
      runtimeGraphDigest: digest(
        JSON.stringify({
          files: manifest.files.filter((file) => file.scope === 'graph'),
          workspaceEdges: manifest.workspaceEdges,
        }),
      ),
      webBuildId: manifest.webBuildId,
      protocols: manifest.protocols,
      bootId: randomUUID(),
      pid: process.pid,
      startedAt: new Date().toISOString(),
      nodeVersion: process.version,
    };
  } catch {
    throw Error('DEV_BUILD_IDENTITY_INVALID');
  }
}
const cacheKey = Symbol.for('allrice.dev.service-build-identity.v1');
type Global = typeof globalThis & {
  [cacheKey]?: Map<ServiceBuildRole, Promise<ServiceBuildIdentity | null>>;
};
export function readServiceBuildIdentity(service: ServiceBuildRole) {
  const cache = ((globalThis as Global)[cacheKey] ??= new Map());
  if (!cache.has(service)) {
    cache.set(
      service,
      process.argv[1]
        ? verifyServiceBuildIdentity({
            entrypoint: resolve(process.argv[1]),
            service,
            claimedSha: process.env.ALLRICE_RELEASE_SHA,
            mode:
              service === 'web' && process.argv.includes('--dev')
                ? 'development'
                : 'production',
          })
        : Promise.resolve(null),
    );
  }
  return cache.get(service)!;
}
