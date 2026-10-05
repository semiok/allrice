import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  readdirSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  RepositoryArchiveSchema,
  RepositoryBaselineSchema,
  RepositoryCatalogSchema,
  RepositoryCandidateSchema,
  repairProductPath,
  repositorySourceLimits,
  type RepositoryArchive,
  type RepositoryBaseline,
  type RepositoryCandidate,
} from './platform-repair-contracts.ts';

export const repositoryDigest = (value: string | Buffer) =>
  'sha256:' + createHash('sha256').update(value).digest('hex');
export function repositoryManifest(files: RepositoryArchive['files']) {
  return files
    .map(({ path, mode, sizeBytes, checksum }) => ({
      path,
      mode,
      sizeBytes,
      checksum,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
export const repositoryMaterialDigest = (files: RepositoryArchive['files']) =>
  repositoryDigest(JSON.stringify(repositoryManifest(files)));

/** Trusted registered Git material only; no host paths or network in the archive. */
export function validateRepositoryArchive(raw: unknown): RepositoryArchive {
  const value = RepositoryArchiveSchema.parse(raw);
  let total = 0;
  const seen = new Set<string>();
  for (const f of value.files) {
    const key = f.path.normalize('NFC').toLowerCase();
    if (
      seen.has(key) ||
      f.path !== f.path.normalize('NFC') ||
      f.path
        .split('/')
        .some(
          (p) =>
            /^(?:\.git|\.ssh|\.aws|\.gnupg|\.credentials(?:\..*)?|\.netrc|\.npmrc|\.env(?:\..*)?|id_rsa|id_ed25519)$/i.test(
              p,
            ) &&
            p !== '.env.example' &&
            !(p === '.npmrc' && f.path === '.npmrc'),
        )
    )
      throw Error('REPOSITORY_PATH_UNSAFE');
    seen.add(key);
    const bytes = Buffer.from(f.contentBase64, 'base64');
    if (f.path === '.npmrc') {
      const text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
      if (
        text
          .split('\n')
          .some(
            (line) =>
              line.trim() &&
              !/^[#;]/.test(line.trim()) &&
              !/^(engine-strict|strict-peer-dependencies|shared-workspace-lockfile|enable-pre-post-scripts|ignore-scripts)=(true|false)$/.test(
                line.trim(),
              ),
          )
      )
        throw Error('REPOSITORY_NPM_CONFIG_UNSAFE');
    }
    total += bytes.length;
    if (
      bytes.toString('base64') !== f.contentBase64 ||
      bytes.length !== f.sizeBytes ||
      repositoryDigest(bytes) !== f.checksum ||
      total > repositorySourceLimits.totalBytes
    )
      throw Error('REPOSITORY_SOURCE_CHANGED');
  }
  const keys = [...seen].sort();
  if (
    keys.some((key) =>
      key
        .split('/')
        .slice(0, -1)
        .some((_, i, parts) => seen.has(parts.slice(0, i + 1).join('/'))),
    )
  )
    throw Error('REPOSITORY_PATH_UNSAFE');
  return value;
}
export function readRepositoryArchive(
  bytes: Buffer,
  baseline: RepositoryBaseline,
) {
  RepositoryBaselineSchema.parse(baseline);
  if (
    bytes.length !== baseline.archiveBytes ||
    bytes.length > repositorySourceLimits.archiveBytes ||
    repositoryDigest(bytes) !== baseline.archiveChecksum
  )
    throw Error('REPOSITORY_ARCHIVE_CHANGED');
  const value = validateRepositoryArchive(
    JSON.parse(
      gunzipSync(bytes, {
        maxOutputLength: repositorySourceLimits.jsonBytes,
      }).toString('utf8'),
    ),
  );
  if (
    value.files.length !== baseline.fileCount ||
    value.files.reduce((n, f) => n + f.sizeBytes, 0) !== baseline.sourceBytes ||
    repositoryMaterialDigest(value.files) !== baseline.sourceDigest ||
    value.files.find((f) => f.path === 'pnpm-lock.yaml')?.checksum !==
      baseline.rootLockChecksum ||
    repositoryDependencyDigest(value.files) !==
      baseline.dependencyConfigurationDigest
  )
    throw Error('REPOSITORY_BASELINE_CHANGED');
  return value;
}
export function repositoryDependencyDigest(files: RepositoryArchive['files']) {
  return repositoryMaterialDigest(
    files.filter(
      (f) =>
        /(?:^|\/)(?:package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|\.pnpmfile\.cjs|\.npmrc)$/.test(
          f.path,
        ) || f.path.startsWith('patches/'),
    ),
  );
}
export function applyRepositoryCandidate(
  archive: RepositoryArchive,
  raw: unknown,
) {
  const candidate = RepositoryCandidateSchema.parse(raw);
  if (
    candidate.checksum !==
      repositoryDigest(
        JSON.stringify({
          version: 1,
          revision: candidate.revision,
          files: candidate.files,
        }),
      ) ||
    (candidate.revision === 0) !== (candidate.files.length === 0)
  )
    throw Error('REPOSITORY_CANDIDATE_CHANGED');
  const files = archive.files.map((f) => ({ ...f }));
  for (const patch of candidate.files) {
    const f = files.find((f) => f.path === repairProductPath);
    const bytes = Buffer.from(patch.afterBase64, 'base64');
    if (
      !f ||
      f.checksum !== patch.beforeChecksum ||
      bytes.toString('base64') !== patch.afterBase64 ||
      bytes.length > 50_000 ||
      !bytes.length
    )
      throw Error('REPOSITORY_PATCH_CONFLICT');
    const text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw Error('REPOSITORY_PATCH_BINARY');
    Object.assign(f, {
      checksum: repositoryDigest(bytes),
      sizeBytes: bytes.length,
      contentBase64: patch.afterBase64,
    });
  }
  return {
    candidate,
    archive: validateRepositoryArchive({ version: 1, files }),
  };
}
export function repositoryCandidate(
  revision: number,
  files: RepositoryCandidate['files'],
): RepositoryCandidate {
  const value = { version: 1, revision, files };
  return RepositoryCandidateSchema.parse({
    ...value,
    checksum: repositoryDigest(JSON.stringify(value)),
  });
}

/** Bounded no-follow reads from an operator-owned immutable catalog. */
function bounded(path: string, maximum: number) {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size <= 0 ||
      before.size > maximum
    )
      throw Error('REPOSITORY_CATALOG_UNSAFE');
    const bytes = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, null);
      if (!n) break;
      size += n;
    }
    const after = fstatSync(fd);
    if (
      size !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw Error('REPOSITORY_CATALOG_CHANGED');
    return bytes.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}
function rootPath(directory: string) {
  const path = resolve(directory);
  if (realpathSync(path) !== path) throw Error('REPOSITORY_CATALOG_UNSAFE');
  return path;
}
export function loadRepositoryBaseline(
  directory: string | undefined,
  id: string,
) {
  if (!directory || !/^[a-f0-9-]{36}$/.test(id))
    throw Error('REPOSITORY_BASELINE_UNAVAILABLE');
  const root = rootPath(directory),
    folder = join(root, id);
  if (realpathSync(folder) !== folder) throw Error('REPOSITORY_CATALOG_UNSAFE');
  const baseline = RepositoryBaselineSchema.parse(
    JSON.parse(bounded(join(folder, 'baseline.json'), 20_000).toString('utf8')),
  );
  if (baseline.id !== id) throw Error('REPOSITORY_BASELINE_CHANGED');
  const bytes = bounded(
    join(folder, 'source.json.gz'),
    repositorySourceLimits.archiveBytes,
  );
  return { baseline, bytes, archive: readRepositoryArchive(bytes, baseline) };
}
export function repositoryCatalog(directory: string | undefined) {
  if (!directory)
    return RepositoryCatalogSchema.parse({
      state: 'not_configured',
      baselines: [],
    });
  try {
    const root = rootPath(directory);
    const ids = readdirSync(root).filter((p) => /^[a-f0-9-]{36}$/.test(p));
    if (ids.length > 12) throw Error('REPOSITORY_CATALOG_LIMIT');
    const baselines = ids.map(
      (id) => loadRepositoryBaseline(root, id).baseline,
    );
    return RepositoryCatalogSchema.parse({ state: 'available', baselines });
  } catch {
    return RepositoryCatalogSchema.parse({
      state: 'unavailable',
      baselines: [],
    });
  }
}
