import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { PersonVmError } from './contract.ts';
import { hostEnvironment, runCommand, type CommandRunner } from './process.ts';

export type PersonDisk = Readonly<{ vmId: string; tier: 'warm' | 'cold' }>;
export type PersonVmDiskInspection =
  | Readonly<{ state: 'absent' | 'unknown' }>
  | Readonly<{ state: 'ready'; disk: PersonDisk }>;
export interface PersonVmDiskPort {
  /** Host-only non-destructive reconciliation of this vmId's two storage locations. */
  inspect(vmId: string, signal: AbortSignal): Promise<PersonVmDiskInspection>;
  create(disk: PersonDisk, signal: AbortSignal): Promise<void>;
  attach(disk: PersonDisk, signal: AbortSignal): Promise<string>;
  detach(disk: PersonDisk, signal: AbortSignal): Promise<void>;
  move(
    disk: PersonDisk,
    tier: PersonDisk['tier'],
    signal: AbortSignal,
  ): Promise<PersonDisk>;
  delete(disk: PersonDisk, signal: AbortSignal): Promise<void>;
}
export interface PersonVmKeyStore {
  readOrCreate(vmId: string): Promise<Buffer>;
  read(vmId: string): Promise<Buffer>;
  delete(vmId: string): Promise<void>;
}

function checkedId(vmId: string) {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      vmId,
    )
  ) {
    throw new PersonVmError('PROVIDER_FAILED');
  }
  return vmId;
}
export async function privateDirectory(path: string) {
  if (!isAbsolute(path)) throw new PersonVmError('PROVIDER_FAILED');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new PersonVmError('PROVIDER_FAILED');
  await chmod(path, 0o700);
}

/** Dedicated host directory only. Never use a DSH plugin storageDir or guest path. */
export class FilePersonVmKeyStore implements PersonVmKeyStore {
  constructor(private readonly root: string) {}
  private path(id: string) {
    return join(this.root, `${checkedId(id)}.key`);
  }
  async readOrCreate(id: string) {
    await privateDirectory(this.root);
    const value = randomBytes(48).toString('hex');
    try {
      const file = await open(
        this.path(id),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(value);
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return this.read(id);
  }
  async read(id: string) {
    const file = await open(
      this.path(id),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size !== 96)
        throw new PersonVmError('PROVIDER_FAILED');
      return Buffer.from(await file.readFile());
    } finally {
      await file.close();
    }
  }
  async delete(id: string) {
    await rm(this.path(id), { force: true });
  }
}

/** AES-256 APFS sparse images. All MSB writable state lives inside this image. */
export class ApfsPersonVmDisk implements PersonVmDiskPort {
  private readonly run: CommandRunner;
  constructor(
    private readonly options: {
      root: string;
      keys: PersonVmKeyStore;
      capacityGiB: number;
      runner?: CommandRunner;
    },
  ) {
    this.run = options.runner ?? runCommand;
    if (!Number.isInteger(options.capacityGiB) || options.capacityGiB <= 0)
      throw new PersonVmError('PROVIDER_FAILED');
  }
  private image(disk: PersonDisk) {
    return join(
      this.options.root,
      disk.tier,
      `${checkedId(disk.vmId)}.sparseimage`,
    );
  }
  private mount(disk: PersonDisk) {
    return join(this.options.root, 'mounts', checkedId(disk.vmId));
  }
  private manifest(vmId: string) {
    return join(this.options.root, 'manifests', `${checkedId(vmId)}.json`);
  }
  private async command(
    args: string[],
    signal: AbortSignal,
    input?: Uint8Array,
  ) {
    return this.run({
      executable: '/usr/bin/hdiutil',
      args,
      env: hostEnvironment(this.options.root),
      signal,
      ...(input ? { input } : {}),
    });
  }
  private async info(signal: AbortSignal): Promise<{
    images?: {
      'image-path': string;
      'system-entities'?: { 'mount-point'?: string }[];
    }[];
  }> {
    const plist = await this.command(['info', '-plist'], signal);
    const json = await this.run({
      executable: '/usr/bin/plutil',
      args: ['-convert', 'json', '-o', '-', '-'],
      env: hostEnvironment(this.options.root),
      signal,
      input: Buffer.from(plist),
    });
    return JSON.parse(json);
  }
  private async isAttached(disk: PersonDisk, signal: AbortSignal) {
    const image = (await this.info(signal)).images?.find(
      (item) => item['image-path'] === this.image(disk),
    );
    if (
      image &&
      !image['system-entities']?.some(
        (item) => item['mount-point'] === this.mount(disk),
      )
    )
      throw new PersonVmError('CLEANUP_INCOMPLETE');
    return Boolean(image);
  }
  private async withKey<T>(
    disk: PersonDisk,
    create: boolean,
    fn: (key: Buffer) => Promise<T>,
  ) {
    const key = await (create
      ? this.options.keys.readOrCreate(disk.vmId)
      : this.options.keys.read(disk.vmId));
    const input = Buffer.concat([key, Buffer.from([0])]);
    try {
      return await fn(input);
    } finally {
      key.fill(0);
      input.fill(0);
    }
  }
  async inspect(
    vmId: string,
    signal: AbortSignal,
  ): Promise<PersonVmDiskInspection> {
    signal.throwIfAborted();
    for (const directory of ['', 'warm', 'cold', 'manifests'])
      await privateDirectory(join(this.options.root, directory));
    const found: { disk: PersonDisk; device: string; inode: string }[] = [];
    for (const tier of ['warm', 'cold'] as const) {
      const disk = { vmId, tier };
      try {
        const stat = await lstat(this.image(disk), { bigint: true });
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          (stat.mode & 0o777n) !== 0o600n
        )
          return { state: 'unknown' };
        found.push({ disk, device: String(stat.dev), inode: String(stat.ino) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    let manifest: unknown;
    try {
      const file = await open(
        this.manifest(vmId),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 1024)
          return { state: 'unknown' };
        manifest = JSON.parse(await file.readFile('utf8'));
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { state: found.length === 0 ? 'absent' : 'unknown' };
      if (signal.aborted) throw error;
      return { state: 'unknown' };
    }
    if (found.length !== 1 || !manifest || typeof manifest !== 'object')
      return { state: 'unknown' };
    const actual = found[0]!,
      receipt = manifest as Record<string, unknown>;
    if (
      receipt.version !== 1 ||
      receipt.vmId !== vmId ||
      receipt.device !== actual.device ||
      receipt.inode !== actual.inode
    )
      return { state: 'unknown' };
    try {
      // Recognize/decrypt the completed container through the public command.
      // This does not mount, repair, reformat, or claim filesystem health.
      await this.withKey(actual.disk, false, (key) =>
        this.command(
          ['imageinfo', this.image(actual.disk), '-stdinpass', '-plist'],
          signal,
          key,
        ),
      );
    } catch (error) {
      if (signal.aborted) throw error;
      return { state: 'unknown' };
    }
    return { state: 'ready', disk: actual.disk };
  }
  async create(disk: PersonDisk, signal: AbortSignal) {
    await privateDirectory(this.options.root);
    await privateDirectory(join(this.options.root, disk.tier));
    const existing = await this.inspect(disk.vmId, signal);
    if (existing.state === 'ready') return;
    if (existing.state !== 'absent') throw new PersonVmError('PROVIDER_FAILED');
    await this.withKey(disk, true, (key) =>
      this.command(
        [
          'create',
          '-size',
          `${this.options.capacityGiB}g`,
          '-fs',
          'APFS',
          '-volname',
          `AllRice-${disk.vmId}`,
          '-type',
          'SPARSE',
          '-encryption',
          'AES-256',
          '-stdinpass',
          this.image(disk),
        ],
        signal,
        key,
      ),
    );
    await chmod(this.image(disk), 0o600);
    const stat = await lstat(this.image(disk), { bigint: true });
    const receipt = await open(
      this.manifest(disk.vmId),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await receipt.writeFile(
        JSON.stringify({
          version: 1,
          vmId: disk.vmId,
          device: String(stat.dev),
          inode: String(stat.ino),
        }),
      );
      await receipt.sync();
    } finally {
      await receipt.close();
    }
  }
  async attach(disk: PersonDisk, signal: AbortSignal) {
    const inspected = await this.inspect(disk.vmId, signal);
    if (inspected.state !== 'ready' || inspected.disk.tier !== disk.tier)
      throw new PersonVmError('PROVIDER_FAILED');
    await privateDirectory(this.mount(disk));
    const stat = await lstat(this.image(disk));
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new PersonVmError('PROVIDER_FAILED');
    if (!(await this.isAttached(disk, signal))) {
      await this.withKey(disk, false, (key) =>
        this.command(
          [
            'attach',
            this.image(disk),
            '-stdinpass',
            '-nobrowse',
            '-mountpoint',
            this.mount(disk),
          ],
          signal,
          key,
        ),
      );
    }
    if (!(await this.isAttached(disk, signal)))
      throw new PersonVmError('PROVIDER_FAILED');
    return this.mount(disk);
  }
  async detach(disk: PersonDisk, signal: AbortSignal) {
    if (await this.isAttached(disk, signal))
      await this.command(['detach', this.mount(disk)], signal);
    if (await this.isAttached(disk, signal))
      throw new PersonVmError('CLEANUP_INCOMPLETE');
  }
  async move(disk: PersonDisk, tier: PersonDisk['tier'], signal: AbortSignal) {
    signal.throwIfAborted();
    const inspected = await this.inspect(disk.vmId, signal);
    if (inspected.state !== 'ready') throw new PersonVmError('PROVIDER_FAILED');
    const actual = inspected.disk;
    if (await this.isAttached(actual, signal))
      throw new PersonVmError('CLEANUP_INCOMPLETE');
    const next = { vmId: disk.vmId, tier };
    if (tier !== actual.tier) {
      await privateDirectory(join(this.options.root, tier));
      try {
        await lstat(this.image(next));
        throw new PersonVmError('PROVIDER_FAILED');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await rename(this.image(actual), this.image(next));
    }
    return next;
  }
  async delete(disk: PersonDisk, signal: AbortSignal) {
    const inspected = await this.inspect(disk.vmId, signal);
    if (inspected.state === 'unknown')
      throw new PersonVmError('PROVIDER_FAILED');
    const actual = inspected.state === 'ready' ? inspected.disk : disk;
    if (await this.isAttached(actual, signal))
      throw new PersonVmError('CLEANUP_INCOMPLETE');
    await rm(this.image(actual), { force: true });
    // Never erase the completion receipt/key while either owned image remains,
    // including when the caller's persisted tier lagged a committed rename.
    for (const tier of ['warm', 'cold'] as const) {
      try {
        await lstat(this.image({ vmId: disk.vmId, tier }));
        throw new PersonVmError('CLEANUP_INCOMPLETE');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await rm(this.manifest(disk.vmId), { force: true });
    await this.options.keys.delete(disk.vmId);
  }
}
