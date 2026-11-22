import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readlink, realpath, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { PersonVmError, type PersonVmBinding } from './contract.ts';

/** Trusted host release configuration, never a guest or HTTP parameter. */
export type ReadonlyDshDirectory = Readonly<{
  descriptorPath: string;
  hostDirectory: string;
  guestDirectory: string;
  artifactSha256: string;
  manifestSha256: string;
}>;
const BASE =
  'docker.io/library/node@sha256:af0bb4bf5b7318e3269417a7684a9e116c3c22eaf05382578b0d0d33de597ad2';
// Bounds come from this pinned release, not an untrusted descriptor's size claim.
const MANIFEST_BYTES = 16832328;
const BINS =
  'anthropic-ai-sdk cordis crc32 dsh dsoffice is-docker is-inside-container js-yaml node-which pi-ai playwright playwright-core semver which-command xlsx yaml'.split(
    ' ',
  );
const hash = (v: Uint8Array) => createHash('sha256').update(v).digest('hex');
const digest = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function invalid(): never {
  throw new PersonVmError('PROVIDER_FAILED');
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) invalid();
  return v as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0'))
    invalid();
}
function stamp(s: BigIntStats) {
  return [String(s.dev), String(s.ino), String(s.ctimeNs)];
}
function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function owned(s: BigIntStats) {
  if (!process.getuid || s.uid !== BigInt(process.getuid())) invalid();
}
function mode(s: BigIntStats) {
  return Number(s.mode & 0o7777n);
}
function safePath(p: unknown): p is string {
  return (
    typeof p === 'string' &&
    !!p &&
    !p.includes('\0') &&
    !p.includes('\\') &&
    !posix.isAbsolute(p) &&
    p.split('/').every((v) => v && v !== '.' && v !== '..')
  );
}

export function checkedReadonlyDshDirectory(
  value: ReadonlyDshDirectory,
): ReadonlyDshDirectory {
  if (
    !value ||
    !digest(value.artifactSha256) ||
    !digest(value.manifestSha256) ||
    ![value.hostDirectory, value.descriptorPath, value.guestDirectory].every(
      (p) =>
        typeof p === 'string' &&
        isAbsolute(p) &&
        resolve(p) === p &&
        !p.includes(':') &&
        !p.includes('\0'),
    ) ||
    basename(value.hostDirectory) !== 'public' ||
    basename(dirname(value.hostDirectory)) !== value.artifactSha256 ||
    value.descriptorPath !==
      join(dirname(value.hostDirectory), 'descriptor.json') ||
    value.guestDirectory !== `/opt/allrice/dsh/${value.artifactSha256}`
  )
    invalid();
  return Object.freeze({
    descriptorPath: value.descriptorPath,
    hostDirectory: value.hostDirectory,
    guestDirectory: value.guestDirectory,
    artifactSha256: value.artifactSha256,
    manifestSha256: value.manifestSha256,
  });
}
async function canonicalDirectory(path: string) {
  if ((await realpath(path)) !== path) invalid();
  let current = path;
  while (true) {
    const s = await lstat(current, { bigint: true });
    if (
      !s.isDirectory() ||
      (s.uid !== 0n &&
        (!process.getuid || s.uid !== BigInt(process.getuid()))) ||
      ((mode(s) & 0o022) !== 0 && !(s.uid === 0n && mode(s) & 0o1000))
    )
      invalid();
    if (dirname(current) === current) break;
    current = dirname(current);
  }
}
async function metadataFile(path: string, limit: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await fd.stat({ bigint: true });
    owned(before);
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      mode(before) !== 0o600 ||
      before.size <= 0 ||
      before.size > BigInt(limit)
    )
      invalid();
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(65536);
    let size = 0;
    while (true) {
      signal.throwIfAborted();
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) invalid();
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    if (
      BigInt(size) !== before.size ||
      !same(stamp(before), stamp(await fd.stat({ bigint: true })))
    )
      invalid();
    return Buffer.concat(chunks);
  } finally {
    await fd.close();
  }
}

type Entry = {
  path: string;
  kind: 'file' | 'directory' | 'symlink';
  mode: number;
  bytes?: number;
  sha256?: string;
  target?: string;
};
/** Every call reads/hashes the full actual tree. No manifest-name or mtime cache.
 * Seals additionally detect chmod/ACL/inode changes since trusted publication.
 * The host publisher/admin is trusted; guest root only gets a readonly bind. */
export async function verifyReadonlyDshDirectory(
  input: ReadonlyDshDirectory,
  image: string,
  signal: AbortSignal,
) {
  try {
    const c = checkedReadonlyDshDirectory(input);
    await canonicalDirectory(dirname(c.hostDirectory));
    const descriptorIdentity = stamp(
      await lstat(c.descriptorPath, { bigint: true }),
    );
    const descriptorBytes = await metadataFile(
      c.descriptorPath,
      MANIFEST_BYTES * 3,
      signal,
    );
    const descriptor = object(JSON.parse(descriptorBytes.toString('utf8')));
    if (
      image !== BASE ||
      descriptor.kind !== 'allrice-dsh-readonly-directory-v1' ||
      descriptor.baseImage !== image ||
      descriptor.hostDirectory !== c.hostDirectory ||
      descriptor.guestDirectory !== c.guestDirectory ||
      descriptor.artifactSha256 !== c.artifactSha256 ||
      descriptor.manifestSha256 !== c.manifestSha256 ||
      descriptor.dshVersion !== '0.2.1-rc.2' ||
      descriptor.nodeVersion !== '22.23.2' ||
      !digest(descriptor.publisherSha256) ||
      !digest(descriptor.gateSha256) ||
      !Number.isSafeInteger(descriptor.manifestBytes) ||
      Number(descriptor.manifestBytes) <= 0 ||
      Number(descriptor.manifestBytes) > MANIFEST_BYTES ||
      !Number.isSafeInteger(descriptor.archiveBytes) ||
      Number(descriptor.archiveBytes) <= 0
    )
      invalid();
    const bytes = await metadataFile(
      join(dirname(c.hostDirectory), 'manifest.json'),
      Number(descriptor.manifestBytes),
      signal,
    );
    if (
      bytes.length !== descriptor.manifestBytes ||
      hash(bytes) !== c.manifestSha256
    )
      invalid();
    const manifest = object(JSON.parse(bytes.toString('utf8'))),
      archive = object(manifest.archive);
    if (
      manifest.platform !== 'linux-arm64-gnu' ||
      manifest.containsAuthFiles !== false ||
      archive.sha256 !== c.artifactSha256 ||
      archive.bytes !== descriptor.archiveBytes ||
      !Array.isArray(manifest.files)
    )
      invalid();
    const entries = new Map<string, Entry>();
    for (const raw of manifest.files) {
      const e = object(raw) as Entry;
      if (
        !safePath(e.path) ||
        entries.has(e.path) ||
        !['file', 'directory', 'symlink'].includes(e.kind) ||
        !Number.isInteger(e.mode) ||
        e.mode < 0 ||
        e.mode > 0o777 ||
        (e.kind === 'file' &&
          (!digest(e.sha256) ||
            !Number.isSafeInteger(e.bytes) ||
            Number(e.bytes) < 0))
      )
        invalid();
      entries.set(e.path, e);
    }
    const links = [...entries.values()].filter((e) => e.kind === 'symlink');
    if (
      links.length !== BINS.length ||
      BINS.some(
        (n) =>
          !entries.has(`node_modules/.bin/${n}`) ||
          entries.get(`node_modules/.bin/${n}`)!.kind !== 'symlink',
      )
    )
      invalid();
    for (const e of entries.values()) {
      let parent = posix.dirname(e.path);
      while (parent !== '.') {
        if (entries.get(parent)?.kind !== 'directory') invalid();
        parent = posix.dirname(parent);
      }
      if (e.kind === 'symlink') {
        if (
          typeof e.target !== 'string' ||
          !e.target ||
          e.target.includes('\0') ||
          e.target.includes('\\') ||
          posix.isAbsolute(e.target)
        )
          invalid();
        const target = posix.normalize(
          posix.join(posix.dirname(e.path), e.target),
        );
        if (target.startsWith('../') || entries.get(target)?.kind !== 'file')
          invalid();
      }
    }
    const seals = object(descriptor.seals);
    keys(seals, ['.', ...entries.keys()]);
    for (const seal of Object.values(seals))
      if (
        !Array.isArray(seal) ||
        seal.length !== 3 ||
        seal.some((v) => typeof v !== 'string' || !/^\d+$/.test(v))
      )
        invalid();
    const found = new Set<string>();
    async function walk(path: string, relative = '.') {
      signal.throwIfAborted();
      const before = await lstat(path, { bigint: true });
      owned(before);
      if (
        !before.isDirectory() ||
        mode(before) !==
          (relative === '.' ? 0o555 : entries.get(relative)!.mode & ~0o222) ||
        !same(stamp(before), seals[relative])
      )
        invalid();
      for (const name of await readdir(path)) {
        signal.throwIfAborted();
        const rel = relative === '.' ? name : `${relative}/${name}`,
          e = entries.get(rel),
          full = join(path, name);
        if (!e || found.has(rel)) invalid();
        found.add(rel);
        const s = await lstat(full, { bigint: true });
        owned(s);
        if (!same(stamp(s), seals[rel])) invalid();
        if (e.kind === 'directory') await walk(full, rel);
        else if (e.kind === 'symlink') {
          if (!s.isSymbolicLink() || (await readlink(full)) !== e.target)
            invalid();
        } else {
          if (
            !s.isFile() ||
            s.nlink !== 1n ||
            s.size !== BigInt(e.bytes!) ||
            mode(s) !== (e.mode & ~0o222)
          )
            invalid();
          const fd = await open(
            full,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            if (!same(stamp(await fd.stat({ bigint: true })), seals[rel]))
              invalid();
            const h = createHash('sha256'),
              buffer = Buffer.allocUnsafe(65536);
            let size = 0;
            while (true) {
              signal.throwIfAborted();
              const { bytesRead } = await fd.read(
                buffer,
                0,
                buffer.length,
                null,
              );
              if (!bytesRead) break;
              size += bytesRead;
              if (size > e.bytes!) invalid();
              h.update(buffer.subarray(0, bytesRead));
            }
            if (
              size !== e.bytes ||
              h.digest('hex') !== e.sha256 ||
              !same(stamp(await fd.stat({ bigint: true })), seals[rel])
            )
              invalid();
          } finally {
            await fd.close();
          }
        }
      }
      if (!same(stamp(await lstat(path, { bigint: true })), seals[relative]))
        invalid();
    }
    await canonicalDirectory(c.hostDirectory);
    await walk(c.hostDirectory);
    if (
      found.size !== entries.size ||
      !same(
        stamp(await lstat(c.descriptorPath, { bigint: true })),
        descriptorIdentity,
      )
    )
      invalid();
    signal.throwIfAborted();
    return hash(descriptorBytes);
  } catch {
    invalid();
  }
}

/** Derived persistent VM reference, not an epoch/permission authority. */
export async function readonlyArtifactReference(
  home: string,
  binding: PersonVmBinding,
  c: ReadonlyDshDirectory,
  create: boolean,
  signal: AbortSignal,
  descriptorSha256: string,
) {
  signal.throwIfAborted();
  if (!digest(descriptorSha256)) invalid();
  const path = join(home, 'allrice-readonly-dsh.json');
  const value = {
    version: 1,
    vmId: binding.vmId,
    personId: binding.personId,
    ...c,
    descriptorSha256,
  };
  if (create) {
    let fd;
    try {
      fd = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') invalid();
    }
    if (fd) {
      try {
        await fd.writeFile(JSON.stringify(value));
        await fd.sync();
      } finally {
        await fd.close();
      }
      const directory = await open(
        home,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  }
  try {
    const raw = await metadataFile(path, MANIFEST_BYTES, signal),
      saved = object(JSON.parse(raw.toString('utf8')));
    keys(saved, Object.keys(value));
    for (const [key, expected] of Object.entries(value))
      if (saved[key] !== expected) invalid();
  } catch {
    invalid();
  }
}

/** v0.7.16 public VolumeMount::Bind serialization; missing/extra is unknown. */
export function assertReadonlyArtifactInspection(
  value: unknown,
  name: string,
  c: ReadonlyDshDirectory,
  running: boolean,
) {
  const inspection = object(value);
  if (
    inspection.name !== name ||
    (running
      ? inspection.status !== 'Running'
      : !['Stopped', 'Created', 'Crashed'].includes(
          String(inspection.status),
        )) ||
    !Array.isArray(inspection.pending_changes) ||
    inspection.pending_changes.length !== 0
  )
    invalid();
  function config(value: unknown) {
    const v = object(value);
    if (!Array.isArray(v.mounts) || v.mounts.length !== 1) invalid();
    const m = object(v.mounts[0]),
      options = object(m.options);
    keys(m, [
      'type',
      'host',
      'guest',
      'options',
      'stat_virtualization',
      'host_permissions',
      'follow_root_symlinks',
      'quota_mib',
    ]);
    keys(options, ['readonly', 'noexec', 'nosuid', 'nodev']);
    if (
      m.type !== 'Bind' ||
      m.host !== c.hostDirectory ||
      m.guest !== c.guestDirectory ||
      m.stat_virtualization !== 'strict' ||
      m.host_permissions !== 'private' ||
      m.follow_root_symlinks !== false ||
      m.quota_mib !== null ||
      options.readonly !== true ||
      options.noexec !== false ||
      options.nosuid !== false ||
      options.nodev !== false
    )
      invalid();
  }
  config(inspection.config);
  if (running || inspection.active_config !== null)
    config(inspection.active_config);
}
