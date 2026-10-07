import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectEngine } from './types.js';
import { RuntimeCommandError as LocalCommandError } from './errors.js';

export const projectCacheLimits = Object.freeze({
  archiveBytes: 128_000_000,
  archiveFiles: 256,
  volumeBytes: 512_000_000,
  volumeFiles: 8,
  perVolumeBytes: 128_000_000,
});
const queues = new Map<string, Promise<unknown>>();
const readers = new Map<string, number>();
/** Serialize only cache mutation; project execution retains its own ledger lease. */
export async function mutateProjectCache<T>(
  key: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(mutation);
  queues.set(key, current);
  try {
    return await current;
  } finally {
    if (queues.get(key) === current) queues.delete(key);
  }
}
export function retainProjectArchives(paths: string[]) {
  for (const p of paths) readers.set(p, (readers.get(p) ?? 0) + 1);
  return () => {
    for (const p of paths) {
      const n = readers.get(p)! - 1;
      if (n) readers.set(p, n);
      else readers.delete(p);
    }
  };
}

/** Only hash-named, private cache files are removable. Unknown files, links and
 * ongoing downloads are preserved; unavailable quota fails before publication. */
export async function reserveProjectArchive(
  root: string,
  destination: string,
  size: number,
  maximumBytes: number = projectCacheLimits.archiveBytes,
) {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 256_000_000
  )
    throw new LocalCommandError('PROJECT_CACHE_LIMIT');
  const entries: { path: string; bytes: number; at: number }[] = [];
  for (const scope of await readdir(root)) {
    const directory = join(root, scope),
      d = await lstat(directory);
    if (
      !/^[a-f0-9]{64}$/.test(scope) ||
      !d.isDirectory() ||
      d.isSymbolicLink() ||
      d.uid !== process.getuid?.() ||
      d.mode & 0o077
    )
      throw new LocalCommandError('PROJECT_CACHE_UNSAFE');
    for (const file of await readdir(directory)) {
      const path = join(directory, file),
        s = await lstat(path);
      if (
        !s.isFile() ||
        s.isSymbolicLink() ||
        s.nlink !== 1 ||
        s.uid !== process.getuid?.() ||
        s.mode & 0o077
      )
        throw new LocalCommandError('PROJECT_CACHE_UNSAFE');
      // Part files count towards capacity but are never evicted by another call.
      entries.push({ path, bytes: s.size, at: s.mtimeMs });
      if (entries.length > 4096)
        throw new LocalCommandError('PROJECT_CACHE_LIMIT');
    }
  }
  let bytes = entries.reduce(
      (n, e) => n + (e.path === destination ? 0 : e.bytes),
      size,
    ),
    count = entries.filter((e) => e.path !== destination).length + 1;
  for (const e of entries.sort(
    (a, b) => a.at - b.at || a.path.localeCompare(b.path),
  )) {
    if (bytes <= maximumBytes && count <= projectCacheLimits.archiveFiles)
      break;
    if (
      e.path === destination ||
      readers.has(e.path) ||
      !/\/[a-f0-9]{64}$/.test(e.path)
    )
      continue;
    const now = await lstat(e.path);
    if (
      !now.isFile() ||
      now.nlink !== 1 ||
      now.isSymbolicLink() ||
      now.size !== e.bytes ||
      now.mtimeMs !== e.at
    )
      throw new LocalCommandError('PROJECT_CACHE_UNSAFE');
    await rm(e.path);
    bytes -= e.bytes;
    count--;
  }
  if (bytes > maximumBytes || count > projectCacheLimits.archiveFiles)
    throw new LocalCommandError('PROJECT_CACHE_LIMIT');
}
type Volume = {
  Name: string;
  Driver: string;
  Options: Record<string, string> | null;
  Labels: Record<string, string> | null;
  CreatedAt?: string;
  UsageData?: { Size: number; RefCount: number };
};

/** The daemon's measured usage and container references are authoritative.
 * Every referenced/unknown volume is protected; Docker also rejects in-use deletion. */
export async function reserveProjectVolume(
  api: ProjectEngine,
  name: string,
  profile: 'standard' | 'web-development' = 'standard',
) {
  const requestedBytes =
    profile === 'web-development'
      ? 512_000_000
      : projectCacheLimits.perVolumeBytes;
  // One symmetric daemon pool, with the original standard sub-budget. A live
  // web reservation must not prevent a later ordinary project from running.
  const poolBytes = 1_024_000_000;
  const measured = await api.json<{ Volumes?: Volume[] }>('GET', '/system/df');
  const entries = (measured.Volumes ?? []).filter(
    (v) =>
      /^allrice-project-cache-[a-f0-9]{64}$/.test(v.Name) &&
      v.Labels?.['xyz.bplabs.allrice.project.cache'] ===
        `sha256:${v.Name.slice('allrice-project-cache-'.length)}`,
  );
  if (
    entries.some(
      (v) =>
        v.Driver !== 'local' ||
        Object.keys(v.Options ?? {}).length ||
        !v.UsageData ||
        !Number.isSafeInteger(v.UsageData.Size) ||
        !Number.isSafeInteger(v.UsageData.RefCount) ||
        v.UsageData.Size < 0 ||
        v.UsageData.RefCount < 0 ||
        ![undefined, 'standard', 'web-development'].includes(
          v.Labels?.['xyz.bplabs.allrice.project.profile'],
        ) ||
        (v.Name === name &&
          (v.Labels?.['xyz.bplabs.allrice.project.profile'] ?? 'standard') !==
            profile),
    )
  )
    throw new LocalCommandError('PROJECT_CACHE_UNSAFE');
  let count = entries.length + (entries.some((v) => v.Name === name) ? 0 : 1);
  const volumeLimit = (v: Volume) =>
    v.Name === name
      ? requestedBytes
      : v.Labels?.['xyz.bplabs.allrice.project.profile'] === 'web-development'
        ? 512_000_000
        : projectCacheLimits.perVolumeBytes;
  const charge = (v: Volume) =>
    v.Name === name || v.UsageData!.RefCount > 0
      ? Math.max(volumeLimit(v), v.UsageData!.Size)
      : v.UsageData!.Size;
  let bytes = entries.reduce(
    (n, v) => n + charge(v),
    entries.some((v) => v.Name === name) ? 0 : requestedBytes,
  );
  const standard = (v: Volume) =>
    volumeLimit(v) === projectCacheLimits.perVolumeBytes;
  let standardBytes = entries.reduce(
    (n, v) => n + (standard(v) ? charge(v) : 0),
    !entries.some((v) => v.Name === name) && profile === 'standard'
      ? requestedBytes
      : 0,
  );
  for (const v of entries.sort(
    (a, b) =>
      Date.parse(a.CreatedAt ?? '') - Date.parse(b.CreatedAt ?? '') ||
      a.Name.localeCompare(b.Name),
  )) {
    if (v.Name === name && v.UsageData!.Size <= volumeLimit(v)) continue;
    if (
      v.Name !== name &&
      bytes <= poolBytes &&
      (standardBytes <= projectCacheLimits.volumeBytes || !standard(v)) &&
      count <= projectCacheLimits.volumeFiles &&
      v.UsageData!.Size <= volumeLimit(v)
    )
      continue;
    if (v.UsageData!.RefCount > 0) continue;
    const live = await api.json<Volume>('GET', `/volumes/${v.Name}`);
    if (
      live.Name !== v.Name ||
      live.Driver !== 'local' ||
      Object.keys(live.Options ?? {}).length ||
      live.Labels?.['xyz.bplabs.allrice.project.cache'] !==
        v.Labels?.['xyz.bplabs.allrice.project.cache'] ||
      live.Labels?.['xyz.bplabs.allrice.project.profile'] !==
        v.Labels?.['xyz.bplabs.allrice.project.profile']
    )
      throw new LocalCommandError('PROJECT_CACHE_UNSAFE');
    await api.json('DELETE', `/volumes/${v.Name}`);
    if (v.Name !== name) {
      bytes -= charge(v);
      if (standard(v)) standardBytes -= charge(v);
      count--;
    } else {
      bytes += requestedBytes - charge(v);
      if (standard(v)) standardBytes += requestedBytes - charge(v);
    }
  }
  if (
    bytes > poolBytes ||
    standardBytes > projectCacheLimits.volumeBytes ||
    count > projectCacheLimits.volumeFiles
  )
    throw new LocalCommandError('PROJECT_CACHE_LIMIT');
}
