import { createRequire } from 'node:module';
import type * as Yaml from '../../../packages/project-runtime/node_modules/yaml';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { ProjectPreparation } from '../../../packages/project-runtime/src/project-preparation.ts';
import { downloadPublicPackage } from '../../../packages/project-runtime/src/npm-registry-download.ts';
import { projectToolReleases } from '../../../packages/project-runtime/src/project-tool-releases.ts';
import {
  repositoryDigest,
  repositoryDependencyDigest,
  boundedRepositoryCatalogRead,
} from '../../../packages/database/src/platform-repository-source.ts';
import {
  dependencyMaterialDigest,
  readCompiledDependencies,
} from '../../../packages/database/src/platform-repair-dependencies.ts';
import {
  CompiledDependencyDescriptorSchema,
  CompiledDependencyBundleSchema,
  compiledRepairProfileId,
  compiledRepairLimits,
} from '../../../packages/database/src/platform-repair-compiled-contracts.ts';
import type { RepositoryArchive } from '../../../packages/database/src/platform-repair-contracts.ts';
const { parseDocument } = createRequire(
  new URL('../../../packages/project-runtime/package.json', import.meta.url),
)('yaml') as typeof Yaml;

/** Operator preparation only. Uses the fifth-round verified manager/downloader;
 * no new registry client, installer, VM or model-facing configuration surface. */
export async function prepareRepositoryCompiledDependencies(
  source: RepositoryArchive,
  options: { cacheDirectory: string; nodeVersion: string; timeoutMs?: number },
) {
  const text = (path: string) =>
    Buffer.from(
      source.files.find((f) => f.path === path)!.contentBase64,
      'base64',
    ).toString('utf8');
  const doc = parseDocument(text('pnpm-lock.yaml'), { uniqueKeys: true });
  if (doc.errors.length) throw Error('REPOSITORY_COMPILED_LOCK_UNSUPPORTED');
  const lock = doc.toJS({ maxAliasCount: 0 });
  const root = JSON.parse(text('package.json'));
  if (
    String(lock.lockfileVersion) !== '9.0' ||
    root.packageManager !== 'pnpm@10.33.3' ||
    lock.importers?.['.']?.devDependencies?.typescript?.version !== '5.9.3'
  )
    throw Error('REPOSITORY_COMPILED_LOCK_UNSUPPORTED');
  const importers = {
    '.': {
      devDependencies: Object.fromEntries(
        ['@types/node', 'typescript'].map((n) => [
          n,
          lock.importers['.'].devDependencies[n],
        ]),
      ),
    },
    'packages/contracts': lock.importers['packages/contracts'],
    'packages/project-runtime': lock.importers['packages/project-runtime'],
  };
  for (const path of ['packages/contracts', 'packages/project-runtime']) {
    const pkg = JSON.parse(text(path + '/package.json'));
    if (pkg.scripts?.build !== 'tsc -p tsconfig.build.json')
      throw Error('REPOSITORY_COMPILED_PLAN_CHANGED');
  }
  const keys = new Set<string>();
  const add = (name: string, version: string) => {
    if (name === '@allrice/contracts' && version === 'link:../contracts')
      return;
    const key = name + '@' + version;
    if (keys.has(key)) return;
    if (
      !lock.packages?.[key] ||
      !lock.snapshots?.[key] ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(
        lock.packages[key].resolution?.integrity,
      ) ||
      Object.keys(lock.packages[key].resolution).some(
        (k) => k !== 'integrity',
      ) ||
      lock.packages[key].requiresBuild ||
      lock.snapshots[key].optionalDependencies
    )
      throw Error('REPOSITORY_COMPILED_LOCK_UNSUPPORTED');
    keys.add(key);
    for (const [n, v] of Object.entries(lock.snapshots[key].dependencies ?? {}))
      add(n, v as string);
  };
  for (const imp of Object.values(importers))
    for (const section of ['dependencies', 'devDependencies'])
      for (const [n, v] of Object.entries(
        (imp as Record<string, Record<string, { version: string }>>)[section] ??
          {},
      ))
        add(n, v.version);
  const selected = [...keys].sort();
  if (
    selected.length !== 7 ||
    selected.some(
      (k) =>
        ![
          '@types/node@',
          '@types/ws@',
          'typescript@',
          'undici-types@',
          'ws@',
          'yaml@',
          'zod@',
        ].some((p) => k.startsWith(p)),
    )
  )
    throw Error('REPOSITORY_COMPILED_CLOSURE_CHANGED');
  mkdirSync(options.cacheDirectory, { recursive: true, mode: 0o700 });
  const manager = await new ProjectPreparation(options.cacheDirectory).tool(
    'pnpm',
    'amd64',
    AbortSignal.timeout(60000),
  );
  if (
    repositoryDigest(manager.bytes) !==
    'sha256:' + projectToolReleases.pnpm.sha256
  )
    throw Error('REPOSITORY_COMPILED_MANAGER_CHANGED');
  const files: {
    path: string;
    checksum: string;
    contentBase64: string;
    sizeBytes: number;
  }[] = [];
  const append = (path: string, b: Buffer) =>
    files.push({
      path,
      checksum: repositoryDigest(b),
      contentBase64: b.toString('base64'),
      sizeBytes: b.length,
    });
  append('manager.tgz', manager.bytes);
  const packages = [],
    resolutions: Record<string, unknown> = {};
  for (const [i, key] of selected.entries()) {
    const split = key.lastIndexOf('@'),
      name = key.slice(0, split),
      version = key.slice(split + 1),
      integrity = lock.packages[key].resolution.integrity;
    const cache = join(
      options.cacheDirectory,
      'npm-' + createHash('sha256').update(integrity).digest('hex') + '.tgz',
    );
    const bytes = existsSync(cache)
      ? boundedRepositoryCatalogRead(cache, 5_000_000)
      : await downloadPublicPackage(
          new URL(
            'https://registry.npmjs.org/' +
              name +
              '/-/' +
              name.split('/').at(-1) +
              '-' +
              version +
              '.tgz',
          ),
          AbortSignal.timeout(45000),
          5_000_000,
        );
    if (
      'sha512-' + createHash('sha512').update(bytes).digest('base64') !==
      integrity
    )
      throw Error('REPOSITORY_COMPILED_INTEGRITY');
    if (!existsSync(cache))
      writeFileSync(cache, bytes, { flag: 'wx', mode: 0o400 });
    append(`archives/${i}.tgz`, bytes);
    packages.push({
      name,
      version,
      integrity,
      checksum: repositoryDigest(bytes),
      sizeBytes: bytes.length,
    });
    resolutions[key] = {
      ...lock.packages[key],
      resolution: {
        integrity,
        tarball: `file:/tmp/work/dependencies/archives/${i}.tgz`,
      },
    };
  }
  append(
    'workspace/package.json',
    Buffer.from(
      JSON.stringify({
        name: 'allrice-private-compiled-verification',
        private: true,
        type: 'module',
        packageManager: root.packageManager,
        devDependencies: Object.fromEntries(
          ['@types/node', 'typescript'].map((n) => [
            n,
            root.devDependencies[n],
          ]),
        ),
      }),
    ),
  );
  append(
    'workspace/pnpm-workspace.yaml',
    Buffer.from(
      'packages:\n  - packages/contracts\n  - packages/project-runtime\n',
    ),
  );
  append(
    'workspace/pnpm-lock.yaml',
    Buffer.from(
      JSON.stringify({
        lockfileVersion: lock.lockfileVersion,
        settings: lock.settings,
        importers,
        packages: resolutions,
        snapshots: Object.fromEntries(
          selected.map((k) => [k, lock.snapshots[k]]),
        ),
      }),
    ),
  );
  const rootLockChecksum = repositoryDigest(text('pnpm-lock.yaml')),
    dependencyConfigurationDigest = repositoryDependencyDigest(source.files);
  const bundle = CompiledDependencyBundleSchema.parse({
    version: 1,
    profileId: compiledRepairProfileId,
    rootLockChecksum,
    dependencyConfigurationDigest,
    files,
  });
  const bytes = gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 9 });
  const descriptor = CompiledDependencyDescriptorSchema.parse({
    version: 1,
    profileId: compiledRepairProfileId,
    rootLockChecksum,
    dependencyConfigurationDigest,
    bundleChecksum: repositoryDigest(bytes),
    bundleBytes: bytes.length,
    materialDigest: dependencyMaterialDigest(files),
    planDigest: dependencyMaterialDigest(
      files.filter((f) => f.path.startsWith('workspace/')),
    ),
    nodeVersion: options.nodeVersion,
    timeoutMs: options.timeoutMs ?? compiledRepairLimits.defaultTimeoutMs,
    memoryMiB: compiledRepairLimits.memoryMiB,
    compilerHeapMiB: compiledRepairLimits.compilerHeapMiB,
    manager: {
      version: '10.33.3',
      checksum: repositoryDigest(manager.bytes),
      sizeBytes: manager.bytes.length,
    },
    packages,
  });
  return readCompiledDependencies(bytes, descriptor, {
    rootLockChecksum,
    dependencyConfigurationDigest,
  });
}
