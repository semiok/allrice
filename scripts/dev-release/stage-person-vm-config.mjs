import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/** Explicit private operator input for the original service seal, not an enable
 * flag or another configuration publisher. Never logs the input's contents. */
export async function stagePersonVmConfiguration(root, source) {
  try {
    if (!isAbsolute(source) || (await realpath(root)) !== root)
      throw Error('invalid');
    const file = await open(
      source,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let bytes;
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.uid !== process.getuid?.() ||
        stat.size > 64 * 1024 ** 2
      )
        throw Error('invalid');
      bytes = await file.readFile();
      if (bytes.length !== stat.size) throw Error('invalid');
    } finally {
      await file.close();
    }
    const local = join(root, '.local');
    const target = join(local, 'person-vm-host.json');
    const temp = target + '.tmp';
    try {
      await mkdir(local, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const checkLocal = async () => {
      const stat = await lstat(local);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        (await realpath(local)) !== local
      )
        throw Error('invalid');
    };
    const checkTarget = async () => {
      try {
        const stat = await lstat(target);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o777) !== 0o600
        )
          throw Error('invalid');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    };
    await checkLocal();
    await checkTarget();
    await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' });
    await checkLocal();
    await checkTarget();
    await rename(temp, target);
  } catch {
    throw Error('DEV_BUILD_PRIVATE_CONFIG_INVALID');
  }
}
