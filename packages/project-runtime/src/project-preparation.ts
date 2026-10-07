import type { ProjectRuntimeCommand } from './types.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import {
  RuntimeProjectPreparationSchema,
  RuntimeProjectScopeSchema,
  projectRuntimeCacheIdentity,
  projectPreparationLimits,
  runtimeNpmPackageUrl,
  type RuntimeProjectPreparation,
  type RuntimeProjectScope,
} from '@allrice/contracts';
import {
  mutateProjectCache,
  reserveProjectArchive,
  retainProjectArchives,
} from './project-cache.js';
import { RuntimeCommandError as LocalCommandError } from './errors.js';
import { downloadPublicPackage } from './npm-registry-download.js';
import { downloadManagedRuntimeAsset } from './runtime-asset-download.js';
import { projectToolReleases } from './project-tool-releases.js';

// Standard preparation retains its original ceiling. Large web dependencies
// use verified chunks; Docker's per-request 24 MB ceiling is never raised.
export const projectDependencyArchiveLimit = 23_000_000;

/** Match pnpm's target platform without altering the saved lock. Only foreign
 * optional snapshots may be skipped; incompatible mandatory packages fail. */
export function projectDependencyIndexes(
  command: ProjectRuntimeCommand,
  files: ProjectSourceFile[],
  architecture?: 'amd64' | 'arm64',
) {
  const spec = validateProjectPreparation(command, files);
  if (spec.manager !== 'pnpm' || !architecture)
    return spec.packages.map((_, i) => i);
  const lock = parseDocument(
    Buffer.from(
      files.find((f) => f.path === spec.lockPath)!.content,
      'base64',
    ).toString('utf8'),
  ).toJS({ maxAliasCount: 0 });
  const matches = (value: unknown, target: string) => {
    if (value === undefined) return true;
    if (
      !Array.isArray(value) ||
      !value.length ||
      value.some((v) => typeof v !== 'string' || !/^!?[a-z0-9_]+$/.test(v))
    )
      throw new LocalCommandError('PROJECT_LOCK_UNSUPPORTED');
    return (
      !value.includes('!' + target) &&
      (value.includes('any') ||
        value.every((v: string) => v.startsWith('!')) ||
        value.includes(target))
    );
  };
  return spec.packages.flatMap((pkg, i) => {
    const key = `${pkg.name}@${pkg.version}`,
      entry = lock.packages[key];
    if (
      matches(entry.os, 'linux') &&
      matches(entry.cpu, architecture === 'amd64' ? 'x64' : 'arm64') &&
      matches(entry.libc, 'glibc')
    )
      return [i];
    const snapshots = Object.entries(lock.snapshots ?? {}).filter(
      ([name]) => name === key || name.startsWith(key + '('),
    );
    if (
      !snapshots.length ||
      snapshots.some(([, v]) => !object(v) || v.optional !== true)
    )
      throw new LocalCommandError('PROJECT_LOCK_UNSUPPORTED');
    return [];
  });
}

export type ProjectSourceFile = { path: string; content: string };
const hash = (s: string | Buffer) =>
  `sha256:${createHash('sha256').update(s).digest('hex')}`;
export function projectSourceDigest(files: { path: string; sha256: string }[]) {
  return hash(
    JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path))),
  );
}
/** Project versions/SRI stay frozen. Only the installer in the isolated copy
 * sees local verified tarballs instead of public registry URLs. The supervisor
 * restores the original lock bytes before running project code.
 */
export function projectInstallLock(
  command: ProjectRuntimeCommand,
  files: ProjectSourceFile[],
) {
  const spec = validateProjectPreparation(command, files);
  if (spec.manager !== 'pnpm') return null;
  const original = Buffer.from(
    files.find((f) => f.path === spec.lockPath)!.content,
    'base64',
  );
  const lock = parseDocument(original.toString('utf8')).toJS({
    maxAliasCount: 0,
  }) as {
    packages?: Record<
      string,
      { resolution: { integrity: string; tarball?: string } }
    >;
  };
  for (const [index, pkg] of spec.packages.entries()) {
    lock.packages![`${pkg.name}@${pkg.version}`]!.resolution.tarball =
      `file:/tmp/work/.allrice/archives/${index}.tgz`;
  }
  return { original, projected: Buffer.from(JSON.stringify(lock)) };
}
const normalized = (s: string) => s.toLowerCase().replace(/[-_.]+/g, '-');
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Source and dependency layout are checked before any network or VM effect. */
export function validateProjectPreparation(
  command: ProjectRuntimeCommand,
  files: ProjectSourceFile[],
) {
  const spec = RuntimeProjectPreparationSchema.parse(
    command.arguments.projectPreparation,
  );
  if (spec.sourceDigest !== projectSourceDigest(command.arguments.files))
    throw new LocalCommandError('PROJECT_SOURCE_CHANGED');
  const source = files.find((f) => f.path === spec.lockPath);
  if (
    !source ||
    hash(Buffer.from(source.content, 'base64')) !== spec.lockChecksum
  )
    throw new LocalCommandError('PROJECT_SOURCE_CHANGED');
  const prefix =
    command.arguments.path === '.' ? '' : `${command.arguments.path}/`;
  if (
    spec.lockPath !==
    prefix + (spec.manager === 'pnpm' ? 'pnpm-lock.yaml' : 'requirements.lock')
  )
    throw new LocalCommandError('PROJECT_LOCK_UNSUPPORTED');
  if (
    files.some((f) =>
      f.path
        .split('/')
        .some((p) =>
          [
            'node_modules',
            '.venv',
            '.npmrc',
            '.pnpmfile.cjs',
            'pnpmfile.cjs',
            'uv.toml',
            '.allrice',
          ].includes(p),
        ),
    )
  )
    throw new LocalCommandError('PROJECT_LOCK_UNSUPPORTED');
  const used = new Set<string>();
  if (spec.manager === 'pnpm') {
    const doc = parseDocument(
      Buffer.from(source.content, 'base64').toString('utf8'),
      { uniqueKeys: true },
    );
    if (doc.errors.length)
      throw new LocalCommandError('PROJECT_LOCK_UNSUPPORTED');
    let lock: unknown;
    try {
      lock = doc.toJS({ maxAliasCount: 0 });
    } catch {
      throw new LocalCommandError('PROJECT_LOCK_UNSUPPORTED');
    }
    if (
      !object(lock) ||
      String(lock.lockfileVersion) !== '9.0' ||
      !object(lock.importers) ||
      Object.keys(lock.importers).length !== 1 ||
      !object(lock.importers['.']) ||
      (lock.packages !== undefined && !object(lock.packages)) ||
      lock.patchedDependencies ||
      lock.overrides ||
      lock.catalogs
    )
      throw new LocalCommandError('PROJECT_LOCK_UNSUPPORTED');
    const pkgFile = files.find((f) => f.path === prefix + 'package.json');
    let pkg: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(
        Buffer.from(pkgFile?.content ?? '', 'base64').toString('utf8'),
      );
      if (!object(v)) throw Error();
      pkg = v;
    } catch {
      throw new LocalCommandError('PROJECT_LOCK_UNSUPPORTED');
    }
    if (
      pkg.workspaces ||
      pkg.pnpm ||
      pkg.overrides ||
      (pkg.packageManager !== undefined &&
        pkg.packageManager !== 'pnpm@10.33.3')
    )
      throw new LocalCommandError('PROJECT_LOCK_UNSUPPORTED');
    for (const [key, value] of Object.entries(lock.packages ?? {})) {
      if (
        !object(value) ||
        !object(value.resolution) ||
        Object.keys(value.resolution).some((k) => k !== 'integrity')
      )
        throw new LocalCommandError('PROJECT_LOCK_UNSUPPORTED');
      const resolution = value.resolution;
      const approved = spec.packages.find(
        (p) =>
          `${p.name}@${p.version}` === key &&
          p.integrity === resolution.integrity,
      );
      if (!approved) throw new LocalCommandError('PROJECT_LOCK_MISMATCH');
      used.add(`${approved.name}@${approved.version}`);
    }
    for (const section of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
    ]) {
      const entries = lock.importers['.'][section];
      if (entries !== undefined && !object(entries))
        throw new LocalCommandError('PROJECT_LOCK_UNSUPPORTED');
      for (const [name, value] of Object.entries(entries ?? {})) {
        const version = object(value) ? value.version : undefined;
        if (
          !object(value) ||
          typeof version !== 'string' ||
          !spec.packages.some(
            (p) =>
              p.name === name &&
              (version === p.version || version.startsWith(p.version + '(')),
          )
        )
          throw new LocalCommandError('PROJECT_LOCK_MISMATCH');
      }
    }
  } else {
    // Exact hashed wheel-only requirements, generated by uv pip compile.
    // uv.lock/source resolution is the PR3 workspace layer's responsibility.
    const text = Buffer.from(source.content, 'base64')
      .toString('utf8')
      .replace(/\\\r?\n\s*/g, ' ');
    for (const line of text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'))) {
      const m =
        /^([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9][A-Za-z0-9.!+_-]*)\s+--hash=sha256:([a-f0-9]{64})$/.exec(
          line,
        );
      const approved =
        m &&
        spec.packages.find(
          (p) =>
            normalized(p.name) === normalized(m[1]!) &&
            p.version === m[2] &&
            p.sha256 === `sha256:${m[3]}`,
        );
      if (!approved || used.has(normalized(approved.name)))
        throw new LocalCommandError('PROJECT_LOCK_MISMATCH');
      if (
        new URL(approved.url).pathname.split('/').at(-1) !==
          approved.fileName ||
        !approved.fileName.startsWith(
          `${approved.name.replace(/[-.]/g, '_')}-${approved.version}-`,
        )
      )
        throw new LocalCommandError('PROJECT_LOCK_UNSUPPORTED');
      used.add(normalized(approved.name));
    }
  }
  if (used.size !== spec.packages.length)
    throw new LocalCommandError('PROJECT_LOCK_MISMATCH');
  return spec;
}

export function projectCacheKey(input: {
  spec: RuntimeProjectPreparation;
  scope: RuntimeProjectScope;
  image: string;
  architecture: string;
}) {
  return hash(JSON.stringify(projectRuntimeCacheIdentity(input)));
}

async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const s = await lstat(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid?.() ||
    s.mode & 0o077
  )
    throw new LocalCommandError('PROJECT_CACHE_UNSAFE');
}
async function cached(
  path: string,
  checksum: (bytes: Buffer) => boolean,
  maximum: number,
): Promise<Buffer | null> {
  let h;
  try {
    h = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await h.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      before.mode & 0o077 ||
      before.size > maximum
    )
      throw new LocalCommandError('PROJECT_CACHE_UNSAFE');
    const bytes = Buffer.alloc(before.size);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const next = await h.read(
        bytes,
        bytesRead,
        bytes.length - bytesRead,
        bytesRead,
      );
      if (!next.bytesRead) break;
      bytesRead += next.bytesRead;
    }
    const after = await h.stat();
    if (
      bytesRead !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      !checksum(bytes)
    )
      return null;
    return bytes;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  } finally {
    await h?.close();
  }
}

/** Public, immutable tools share a cache; dependency archives stay employee scoped.
 * Execution/venvs/install scripts always belong to the VM work volume, not here.
 */
export class ProjectPreparation {
  constructor(readonly root: string) {}
  async tool(
    manager: 'pnpm' | 'uv',
    architecture: 'amd64' | 'arm64',
    signal: AbortSignal,
    offline = false,
  ) {
    const asset =
      manager === 'pnpm'
        ? projectToolReleases.pnpm
        : projectToolReleases.uv[architecture];
    const dir = join(this.root, 'tools');
    await privateDirectory(this.root);
    await privateDirectory(dir);
    const path = join(dir, asset.fileName);
    if (
      offline &&
      !(await cached(
        path,
        (b) => hash(b) === 'sha256:' + asset.sha256,
        asset.sizeBytes,
      ))
    )
      throw new LocalCommandError('PROJECT_RUNTIME_UNAVAILABLE');
    try {
      await downloadManagedRuntimeAsset(path, asset, signal);
    } catch (error) {
      if (signal.aborted) throw new LocalCommandError('EXECUTION_REVOKED');
      if (
        error instanceof LocalCommandError &&
        error.code === 'RUNTIME_CHECKSUM_MISMATCH'
      )
        throw new LocalCommandError('PROJECT_TOOL_INTEGRITY');
      throw new LocalCommandError('PROJECT_RUNTIME_UNAVAILABLE');
    }
    const bytes = await cached(
      path,
      (b) => hash(b) === 'sha256:' + asset.sha256,
      asset.sizeBytes,
    );
    if (!bytes) throw new LocalCommandError('PROJECT_DEPENDENCY_INTEGRITY');
    return { path: '.allrice/manager.tar.gz', bytes, asset };
  }
  async archives(input: {
    command: ProjectRuntimeCommand;
    files: ProjectSourceFile[];
    scope: RuntimeProjectScope;
    signal: AbortSignal;
    maintainLease?: () => Promise<boolean>;
    onProgress?: (text: string) => void;
    architecture?: 'amd64' | 'arm64';
  }) {
    const spec = validateProjectPreparation(input.command, input.files);
    const limits = projectPreparationLimits(spec);
    const indexes = projectDependencyIndexes(
      input.command,
      input.files,
      input.architecture,
    );
    const scope = RuntimeProjectScopeSchema.parse(input.scope);
    const directory = join(
      this.root,
      'archives',
      hash(JSON.stringify(scope)).slice(7),
    );
    await privateDirectory(this.root);
    await privateDirectory(join(this.root, 'archives'));
    await privateDirectory(directory);
    const releaseArchives = retainProjectArchives(
      indexes
        .map((i) => spec.packages[i]!)
        .map((pkg) =>
          join(
            directory,
            hash('integrity' in pkg ? pkg.integrity : pkg.sha256).slice(7),
          ),
        ),
    );
    const files: { path: string; bytes: Buffer }[] = [];
    let hits = 0,
      downloads = 0,
      downloadedBytes = 0,
      total = 0;
    const revoked = new AbortController(),
      signal = AbortSignal.any([input.signal, revoked.signal]);
    let checking = false;
    const check = async () => {
      if (
        signal.aborted ||
        (input.maintainLease && !(await input.maintainLease()))
      ) {
        revoked.abort();
        throw new LocalCommandError('EXECUTION_REVOKED');
      }
    };
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void check()
        .catch(() => revoked.abort())
        .finally(() => {
          checking = false;
        });
    }, 1000);
    try {
      await check();
      for (const i of indexes) {
        const pkg = spec.packages[i]!;
        signal.throwIfAborted();
        const npm = 'integrity' in pkg;
        const identity = npm ? pkg.integrity : pkg.sha256;
        const checksum = (b: Buffer) =>
          npm
            ? `sha512-${createHash('sha512').update(b).digest('base64')}` ===
              pkg.integrity
            : hash(b) === pkg.sha256;
        const path = join(directory, hash(identity).slice(7));
        let bytes: Buffer | null = await cached(
          path,
          checksum,
          limits.archiveBytes,
        );
        if (bytes) hits++;
        else {
          const source =
            pkg.archivePath &&
            input.files.find((f) => f.path === pkg.archivePath);
          if (source) bytes = Buffer.from(source.content, 'base64');
          else {
            if (pkg.archivePath)
              throw new LocalCommandError('DEPENDENCY_ARCHIVE_REQUIRED');
            if (spec.offline)
              throw new LocalCommandError('PROJECT_DEPENDENCY_OFFLINE_MISS');
            input.onProgress?.(
              `正在准备项目依赖 ${i + 1}/${spec.packages.length}`,
            );
            try {
              bytes = await downloadPublicPackage(
                new URL(npm ? runtimeNpmPackageUrl(pkg) : pkg.url),
                signal,
                limits.archiveBytes,
              );
            } catch (e) {
              if (signal.aborted)
                throw new LocalCommandError('EXECUTION_REVOKED');
              if (e instanceof LocalCommandError) throw e;
              throw new LocalCommandError('PROJECT_DEPENDENCY_UNAVAILABLE');
            }
            downloads++;
            downloadedBytes += bytes.length;
          }
          if (bytes.length > limits.archiveBytes)
            throw new LocalCommandError('PROJECT_DEPENDENCY_LIMIT');
          if (!checksum(bytes))
            throw new LocalCommandError('PROJECT_DEPENDENCY_INTEGRITY');
          await check();
          await mutateProjectCache(join(this.root, 'archives'), async () => {
            await reserveProjectArchive(
              join(this.root, 'archives'),
              path,
              bytes!.length,
              limits.hostArchiveBytes,
            );
            const temporary = path + '.' + randomUUID() + '.part';
            try {
              await writeFile(temporary, bytes!, { flag: 'wx', mode: 0o600 });
              signal.throwIfAborted();
              await rename(temporary, path);
            } finally {
              await rm(temporary, { force: true });
            }
          });
        }
        total += bytes.length;
        if (total > limits.totalArchiveBytes)
          throw new LocalCommandError('PROJECT_DEPENDENCY_LIMIT');
        files.push({
          path: `.allrice/archives/${npm ? i + '.tgz' : pkg.fileName}`,
          bytes,
        });
      }
      await check();
      const lock = projectInstallLock(input.command, input.files);
      if (lock)
        files.push(
          { path: '.allrice/pnpm-original-lock', bytes: lock.original },
          { path: '.allrice/pnpm-install-lock', bytes: lock.projected },
        );
      return {
        files,
        archiveHits: hits,
        downloadedArchives: downloads,
        downloadedBytes,
      };
    } finally {
      clearInterval(timer);
      releaseArchives();
    }
  }
}
