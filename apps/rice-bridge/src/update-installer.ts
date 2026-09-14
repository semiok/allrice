import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { BridgeInstanceLock } from './instance-lock.js';
import {
  verifyUpdateMetadata,
  verifyUpdatePackage,
  type UpdateEnvironment,
  type UpdateTrust,
  type VerifiedUpdate,
} from './trusted-update.js';

const exec = promisify(execFile);
const appName = 'Rice Bridge.app';
function error(code: string): never {
  throw Error(code);
}
const exists = async (path: string) =>
  lstat(path).then(
    () => true,
    (e: NodeJS.ErrnoException) =>
      e.code === 'ENOENT' ? false : Promise.reject(e),
  );

/** Our package format deliberately excludes ZIP64, symlinks and exotic names.
 * Preflight BOTH local and central names before invoking the system extractor. */
export function inspectUpdateZip(bytes: Buffer) {
  const extras = (start: number, length: number) => {
    let cursor = start;
    while (cursor < start + length) {
      if (cursor + 4 > start + length) error('UPDATE_ARCHIVE_INVALID');
      const kind = bytes.readUInt16LE(cursor),
        size = bytes.readUInt16LE(cursor + 2);
      // Only timestamps and UID/GID hints; never alternate Unicode paths,
      // symlink payloads, ZIP64 or platform-specific extraction instructions.
      if (![0x5455, 0x7875, 0x7855, 0x5855].includes(kind))
        error('UPDATE_ARCHIVE_INVALID');
      cursor += 4 + size;
      if (cursor > start + length) error('UPDATE_ARCHIVE_INVALID');
    }
  };
  const minimum = Math.max(0, bytes.length - 65557);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= minimum; offset--)
    if (
      bytes.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      end = offset;
      break;
    }
  if (end < 0) error('UPDATE_ARCHIVE_INVALID');
  const count = bytes.readUInt16LE(end + 10),
    centralSize = bytes.readUInt32LE(end + 12),
    start = bytes.readUInt32LE(end + 16);
  if (
    !count ||
    count > 20000 ||
    bytes.readUInt16LE(end + 4) ||
    bytes.readUInt16LE(end + 6) ||
    bytes.readUInt16LE(end + 8) !== count ||
    start + centralSize !== end
  )
    error('UPDATE_ARCHIVE_INVALID');
  let offset = start,
    inflated = 0;
  const names = new Set<string>(),
    filesystemNames = new Set<string>(),
    spans: [number, number][] = [];
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
      error('UPDATE_ARCHIVE_INVALID');
    const flags = bytes.readUInt16LE(offset + 8),
      method = bytes.readUInt16LE(offset + 10);
    const packed = bytes.readUInt32LE(offset + 20),
      unpacked = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28),
      extra = bytes.readUInt16LE(offset + 30),
      comment = bytes.readUInt16LE(offset + 32);
    const mode = bytes.readUInt32LE(offset + 38) >>> 16,
      local = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extra + comment;
    if (
      next > end ||
      flags & ~0x808 ||
      ![0, 8].includes(method) ||
      bytes.readUInt16LE(offset + 34) ||
      ![0, 0x4000, 0x8000].includes(mode & 0xf000)
    )
      error('UPDATE_ARCHIVE_INVALID');
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength),
      name = nameBytes.toString('utf8');
    extras(offset + 46 + nameLength, extra);
    if (
      !/^[A-Za-z0-9_. /@+-]+$/.test(name) ||
      !name.startsWith(`${appName}/`) ||
      name.split('/').some((part) => part === '.' || part === '..') ||
      name.includes('//') ||
      names.has(name) ||
      filesystemNames.has(name.replace(/\/$/, '').toLowerCase())
    )
      error('UPDATE_ARCHIVE_PATH_INVALID');
    names.add(name);
    filesystemNames.add(name.replace(/\/$/, '').toLowerCase());
    if (
      local + 30 > start ||
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method
    )
      error('UPDATE_ARCHIVE_INVALID');
    const localName = bytes.readUInt16LE(local + 26),
      localExtra = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + localName + localExtra,
      dataEnd = dataStart + packed;
    if (
      dataEnd > start ||
      !bytes.subarray(local + 30, local + 30 + localName).equals(nameBytes)
    )
      error('UPDATE_ARCHIVE_PATH_INVALID');
    extras(local + 30 + localName, localExtra);
    spans.push([local, dataEnd]);
    inflated += unpacked;
    if (inflated > 1024 * 1024 * 1024) error('UPDATE_ARCHIVE_LIMIT');
    offset = next;
  }
  spans.sort((a, b) => a[0] - b[0]);
  if (
    offset !== end ||
    spans.some((span, i) => i > 0 && span[0] < spans[i - 1]![1])
  )
    error('UPDATE_ARCHIVE_INVALID');
  if (
    !names.has(`${appName}/Contents/Info.plist`) ||
    !names.has(`${appName}/Contents/Resources/RiceBridgeCore`)
  )
    error('UPDATE_ARCHIVE_INVALID');
}

async function safeTree(path: string, count = { n: 0 }) {
  if (++count.n > 20000) error('UPDATE_ARCHIVE_LIMIT');
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o022 ||
    (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))
  )
    error('UPDATE_INSTALL_PATH_UNSAFE');
  if (info.isDirectory())
    for (const item of await readdir(path))
      await safeTree(join(path, item), count);
}

/** Signature validity alone does not identify our publisher. Require Apple
 * Developer ID class, pinned Team ID, exact bundle ID, ticket and Gatekeeper. */
export async function verifyAppleUpdateBundle(
  app: string,
  update: VerifiedUpdate,
) {
  if (process.platform !== 'darwin') error('UPDATE_PLATFORM_UNSUPPORTED');
  await safeTree(app);
  if (!/^[A-Z0-9]{10}$/.test(update.release.teamId))
    error('UPDATE_TRUST_INVALID');
  const requirement = `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${update.release.teamId}" and identifier "xyz.bplabs.rice-bridge"`;
  const run = async (program: string, args: string[]) => {
    try {
      return await exec(program, args, {
        timeout: 30000,
        maxBuffer: 65536,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      });
    } catch {
      return error('UPDATE_APPLE_VERIFICATION_FAILED');
    }
  };
  await run('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '-R',
    requirement,
    app,
  ]);
  await run('/usr/bin/xcrun', ['stapler', 'validate', app]);
  await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', app]);
  const architecture = await run('/usr/bin/lipo', [
    '-archs',
    join(app, 'Contents/Resources/RiceBridgeCore'),
  ]);
  if (
    architecture.stdout.trim() !==
    (update.artifact.arch === 'arm64' ? 'arm64' : 'x86_64')
  )
    error('UPDATE_ARCHITECTURE_INVALID');
  // The candidate is authenticated before even its read-only version code runs.
  const result = await run(join(app, 'Contents/Resources/RiceBridgeCore'), [
    '--version',
  ]);
  if (result.stdout.trim() !== update.release.version)
    error('UPDATE_VERSION_MISMATCH');
}

type Transaction = {
  v: 1;
  id: string;
  version: string;
  sequence: number;
  previous: boolean;
  phase:
    | 'prepared'
    | 'pending-health'
    | 'ready-health'
    | 'healthy'
    | 'recovering'
    | 'rolled-back';
};
export interface UpdateInstallPorts {
  // Caller must hold the Bridge owner lock and keep acquisition drained until
  // restart. A snapshot of zero active counts is NOT sufficient authorization.
  assertQuiescent: () => Promise<void>;
  verifyBundle: typeof verifyAppleUpdateBundle;
  extract: (zip: string, destination: string) => Promise<void>;
}
export const nativeUpdateInstallPorts = (
  assertQuiescent: () => Promise<void>,
): UpdateInstallPorts => ({
  assertQuiescent,
  verifyBundle: verifyAppleUpdateBundle,
  extract: async (zip, destination) => {
    try {
      await exec('/usr/bin/ditto', ['-x', '-k', zip, destination], {
        timeout: 60000,
        maxBuffer: 65536,
      });
    } catch {
      error('UPDATE_EXTRACTION_FAILED');
    }
  },
});

/** Explicit per-user managed install directory; never /Applications, a config
 * directory, or an arbitrary existing App. No credential/config APIs, deletes,
 * elevation, chmod-repair, xattr removal, shell, daemon or Keychain operations. */
export class BridgeUpdateInstaller {
  private busy = false;
  constructor(
    private readonly directory: string,
    private readonly trust: UpdateTrust,
    private readonly ports: UpdateInstallPorts,
  ) {}

  private async checkRoot() {
    const path = resolve(this.directory);
    const info = await lstat(path);
    if (
      (await realpath(path)) !== path ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o700
    )
      error('UPDATE_INSTALL_PATH_UNSAFE');
    return path;
  }
  private async save(value: Transaction) {
    const root = await this.checkRoot(),
      target = join(root, 'update-state.json');
    if (await exists(target)) {
      const info = await lstat(target);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o777) !== 0o600
      )
        error('UPDATE_STATE_UNSAFE');
    }
    const temporary = join(root, `state-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target);
    const directory = await open(root, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async state(): Promise<Transaction | null> {
    const root = await this.checkRoot(),
      path = join(root, 'update-state.json');
    if (!(await exists(path))) return null;
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > 1024
    )
      error('UPDATE_STATE_UNSAFE');
    const row = JSON.parse(await readFile(path, 'utf8')) as Transaction;
    if (
      Object.keys(row).sort().join(',') !==
        'id,phase,previous,sequence,v,version' ||
      row.v !== 1 ||
      !/^[a-f0-9-]{36}$/.test(row.id) ||
      !/^\d+\.\d+\.\d+(?:-dev\.\d+)?$/.test(row.version) ||
      !Number.isSafeInteger(row.sequence) ||
      row.sequence < 1 ||
      typeof row.previous !== 'boolean' ||
      ![
        'prepared',
        'pending-health',
        'ready-health',
        'healthy',
        'recovering',
        'rolled-back',
      ].includes(row.phase)
    )
      error('UPDATE_STATE_UNSAFE');
    return row;
  }
  async install(
    metadata: Uint8Array,
    archive: Buffer,
    environment: UpdateEnvironment,
  ) {
    if (this.busy) error('UPDATE_BUSY');
    this.busy = true;
    let lock: BridgeInstanceLock | undefined;
    try {
      const root = await this.checkRoot();
      lock = await BridgeInstanceLock.acquire(join(root, 'update'));
      const prior = await this.state();
      if (prior && !['healthy', 'rolled-back'].includes(prior.phase))
        error('UPDATE_RECOVERY_REQUIRED');
      const update = verifyUpdateMetadata(metadata, this.trust, {
        ...environment,
        sequence: Math.max(environment.sequence, prior?.sequence ?? 0),
      });
      verifyUpdatePackage(archive, update);
      inspectUpdateZip(archive);
      await this.ports.assertQuiescent();
      const id = randomUUID(),
        staging = join(root, `stage-${id}`),
        app = join(root, appName);
      // First adoption of an unmanaged App is deliberately unsupported.
      if (!prior && (await exists(app))) error('UPDATE_UNMANAGED_INSTALL');
      await mkdir(staging, { mode: 0o700 });
      const zip = join(staging, 'package.zip'),
        file = await open(zip, 'wx', 0o600);
      try {
        await file.writeFile(archive);
        await file.sync();
      } finally {
        await file.close();
      }
      await this.ports.extract(zip, staging);
      const candidate = join(staging, appName);
      await safeTree(candidate);
      await this.ports.verifyBundle(candidate, update);
      await this.ports.assertQuiescent();
      const transaction: Transaction = {
        v: 1,
        id,
        version: update.release.version,
        sequence: update.release.sequence,
        previous: await exists(app),
        phase: 'prepared',
      };
      if (transaction.previous) await safeTree(app);
      await this.save(transaction);
      if (transaction.previous)
        await rename(app, join(root, `rollback-${id}.app`));
      await rename(candidate, app);
      await this.save({ ...transaction, phase: 'pending-health' });
      return { version: transaction.version, phase: 'pending-health' as const };
    } finally {
      lock?.close();
      this.busy = false;
    }
  }
  /** On interrupted replacement/failed launch, recover before executing a new
   * candidate. Keep failed bytes and previous app; never silently retry install. */
  async recover() {
    if (this.busy) error('UPDATE_BUSY');
    this.busy = true;
    let lock: BridgeInstanceLock | undefined;
    try {
      const root = await this.checkRoot();
      lock = await BridgeInstanceLock.acquire(join(root, 'update'));
      const state = await this.state();
      if (!state || ['healthy', 'rolled-back'].includes(state.phase))
        return state;
      await this.ports.assertQuiescent();
      const app = join(root, appName),
        backup = join(root, `rollback-${state.id}.app`),
        failed = join(root, `failed-${state.id}.app`);
      const backupExists = await exists(backup);
      if (state.previous && !backupExists) {
        // Original app before replacement, or recovery already restored it.
        if (
          !(await exists(app)) ||
          !(
            (state.phase === 'prepared' && !(await exists(failed))) ||
            (state.phase === 'recovering' && (await exists(failed)))
          )
        )
          error('UPDATE_RECOVERY_UNCONFIRMED');
      } else {
        await this.save({ ...state, phase: 'recovering' });
        if (await exists(app)) {
          if (await exists(failed)) error('UPDATE_RECOVERY_UNCONFIRMED');
          await safeTree(app);
          await rename(app, failed);
        }
        if (backupExists) {
          await safeTree(backup);
          await rename(backup, app);
        }
      }
      const recovered = { ...state, phase: 'rolled-back' as const };
      await this.save(recovered);
      return recovered;
    } finally {
      lock?.close();
      this.busy = false;
    }
  }
  /** Only after the new native host/Core has started, read existing credentials
   * successfully, acquired its owner lock and reported the exact version. */
  async reportReady(version: string, id: string) {
    const root = await this.checkRoot();
    const lock = await BridgeInstanceLock.acquire(join(root, 'update'));
    try {
      const state = await this.state();
      if (
        !state ||
        state.phase !== 'pending-health' ||
        state.version !== version ||
        state.id !== id
      )
        error('UPDATE_HEALTH_MISMATCH');
      await this.save({ ...state, phase: 'ready-health' });
    } finally {
      lock.close();
    }
  }

  /** Only the monitor commits after observing ready. New Core waits for this
   * commit before it is allowed to acquire browser or foreground work. */
  async confirmHealthy(version: string, id: string) {
    if (this.busy) error('UPDATE_BUSY');
    this.busy = true;
    let lock: BridgeInstanceLock | undefined;
    try {
      const root = await this.checkRoot();
      lock = await BridgeInstanceLock.acquire(join(root, 'update'));
      const state = await this.state();
      if (
        !state ||
        state.phase !== 'ready-health' ||
        state.version !== version ||
        state.id !== id
      )
        error('UPDATE_HEALTH_MISMATCH');
      await this.save({ ...state, phase: 'healthy' });
    } finally {
      lock?.close();
      this.busy = false;
    }
  }
}
