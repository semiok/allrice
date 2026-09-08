import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { configPath } from './config.js';

const owned = new Set<string>();
function safe(stat: Stats, directory: boolean) {
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.isSymbolicLink() ||
    (!directory && stat.nlink !== 1) ||
    stat.mode & 0o077 ||
    stat.uid !== process.getuid?.()
  )
    throw Error('BRIDGE_INSTANCE_PATH_UNSAFE');
}

/** An OS-backed lock, not a PID claim. Survives commits and releases on crash.
 * Kept separate from the execution journal so diagnostics never open its fd. */
export class BridgeInstanceLock {
  private closed = false;
  private constructor(
    private database: DatabaseSync,
    private path: string,
  ) {}
  static async acquire(configuration = configPath()) {
    const absolute = resolve(configuration);
    await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
    const parent = await realpath(dirname(absolute));
    const root = join(parent, `${basename(absolute)}.runtime-owner`);
    if (owned.has(root)) throw Error('BRIDGE_ALREADY_RUNNING');
    owned.add(root);
    let database: DatabaseSync | undefined;
    try {
      await mkdir(root, { mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        },
      );
      safe(await lstat(root), true);
      if ((await realpath(root)) !== root)
        throw Error('BRIDGE_INSTANCE_PATH_UNSAFE');
      const path = join(root, 'owner.sqlite');
      const handle = await open(
        path,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      let inode: Stats;
      try {
        inode = await handle.stat();
        safe(inode, false);
        await handle.sync();
      } finally {
        await handle.close();
      }
      for (const suffix of ['-journal', '-wal', '-shm']) {
        const stat = await lstat(path + suffix).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          },
        );
        if (stat) safe(stat, false);
      }
      const { DatabaseSync } = await import('node:sqlite');
      database = new DatabaseSync(path);
      const current = await lstat(path);
      safe(current, false);
      if (current.ino !== inode!.ino || current.dev !== inode!.dev)
        throw Error('BRIDGE_INSTANCE_PATH_UNSAFE');
      database.exec(
        'PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1)); INSERT OR IGNORE INTO owner VALUES(1); COMMIT;',
      );
      return new BridgeInstanceLock(database, root);
    } catch (error) {
      database?.close();
      owned.delete(root);
      if (error instanceof Error && /(?:locked|busy)/i.test(error.message))
        throw Error('BRIDGE_ALREADY_RUNNING');
      throw error;
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
    owned.delete(this.path);
  }
}
