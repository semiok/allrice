import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Files from 'node:fs/promises';

const ports = vi.hoisted(() => ({
  failRename: false,
  failDeletePath: '',
  foreignOwnerPath: '',
  mutateReadPath: '',
  mutateAfterRead: null as (() => Promise<void>) | null,
  opens: [] as { path: string; flags: unknown }[],
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof Files>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (ports.failRename) throw Error('synthetic secret must not escape');
      return actual.rename(...args);
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (String(args[0]) === ports.failDeletePath)
        throw Object.assign(Error('synthetic private path'), {
          code: 'EACCES',
        });
      return actual.unlink(...args);
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const result = await actual.lstat(...args);
      if (String(args[0]) === ports.foreignOwnerPath)
        result.uid =
          typeof result.uid === 'bigint' ? result.uid + 1n : result.uid + 1;
      return result;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      ports.opens.push({ path: String(args[0]), flags: args[1] });
      if (String(args[0]) === ports.foreignOwnerPath) {
        const stat = handle.stat.bind(handle);
        handle.stat = vi.fn(async () => {
          const metadata = await stat();
          metadata.uid++;
          return metadata;
        }) as unknown as typeof handle.stat;
      }
      if (String(args[0]) === ports.mutateReadPath) {
        const read = handle.read.bind(handle);
        handle.read = vi.fn(
          async (...parameters: Parameters<typeof handle.read>) => {
            const result = await read(...parameters);
            const mutate = ports.mutateAfterRead;
            ports.mutateAfterRead = null;
            await mutate?.();
            return result;
          },
        ) as typeof handle.read;
      }
      return handle;
    },
  };
});

import {
  prepareCredentialDirectory,
  readPrivateCredentialFile,
  deletePrivateCredentialFile,
  readCredentialRecordFile,
  writeCredentialRecordFile,
  deleteCredentialRecordFile,
} from './credential-files.js';

let root: string, directory: string;
const filename = 'synthetic-device_123.json';
const failure = 'BRIDGE_CREDENTIAL_FILE_UNSAFE';
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-credential-files-')),
  );
  directory = join(root, 'config.json.credentials');
  ports.failRename = false;
  ports.failDeletePath = '';
  ports.foreignOwnerPath = '';
  ports.mutateReadPath = '';
  ports.mutateAfterRead = null;
  ports.opens.length = 0;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it('missing records and legacy files read as null and delete without creating directories', async () => {
  expect(await readCredentialRecordFile(directory, filename)).toBeNull();
  await deleteCredentialRecordFile(directory, filename);
  expect(
    await readPrivateCredentialFile(join(root, 'legacy.token')),
  ).toBeNull();
  await deletePrivateCredentialFile(join(root, 'legacy.token'));
  expect(await readdir(root)).toEqual([]);
});
it('creates only its leaf, atomically replaces a safe record, and retains exact private modes', async () => {
  await chmod(root, 0o755);
  await prepareCredentialDirectory(directory);
  const path = join(directory, filename);
  await writeCredentialRecordFile(
    directory,
    filename,
    'first synthetic credential',
  );
  const previous = await lstat(path);
  await writeCredentialRecordFile(
    directory,
    filename,
    'second synthetic credential',
  );
  expect(await readCredentialRecordFile(directory, filename)).toBe(
    'second synthetic credential',
  );
  expect((await lstat(root)).mode & 0o777).toBe(0o755);
  expect((await lstat(directory)).mode & 0o777).toBe(0o700);
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  expect((await lstat(path)).ino).not.toBe(previous.ino);
  expect(await readdir(directory)).toEqual([filename]);
  await deleteCredentialRecordFile(directory, filename);
  expect(await readdir(directory)).toEqual([]);
});
it('prepare does not recursively create parents or repair existing insecure directories', async () => {
  await expect(
    prepareCredentialDirectory(join(root, 'absent', 'child')),
  ).rejects.toThrow(failure);
  expect(await readdir(root)).toEqual([]);
  await mkdir(directory, { mode: 0o755 });
  await expect(prepareCredentialDirectory(directory)).rejects.toThrow(failure);
  expect((await lstat(directory)).mode & 0o777).toBe(0o755);
});
it.each([
  '../escape.json',
  '.',
  '..',
  '/absolute.json',
  'a/b.json',
  'a\\b.json',
  'a%2Fb.json',
  'x.json.tmp',
])(
  'rejects unsafe record basename %s before filesystem mutation',
  async (name) => {
    await expect(readCredentialRecordFile(directory, name)).rejects.toThrow(
      failure,
    );
    await expect(
      writeCredentialRecordFile(directory, name, 'synthetic'),
    ).rejects.toThrow(failure);
    await expect(deleteCredentialRecordFile(directory, name)).rejects.toThrow(
      failure,
    );
    expect(await readdir(root)).toEqual([]);
  },
);
it.each(['symlink', 'permissions', 'owner'])(
  'all record operations reject a %s directory',
  async (kind) => {
    const target = join(root, 'target');
    await mkdir(target, { mode: 0o700 });
    if (kind === 'symlink') await symlink(target, directory);
    else {
      await mkdir(directory, { mode: kind === 'permissions' ? 0o755 : 0o700 });
      if (kind === 'owner') ports.foreignOwnerPath = directory;
    }
    await expect(readCredentialRecordFile(directory, filename)).rejects.toThrow(
      failure,
    );
    await expect(
      writeCredentialRecordFile(directory, filename, 'synthetic'),
    ).rejects.toThrow(failure);
    await expect(
      deleteCredentialRecordFile(directory, filename),
    ).rejects.toThrow(failure);
    expect(await readdir(target)).toEqual([]);
  },
);
it.each(['symlink', 'permissions', 'owner', 'directory', 'hardlink'])(
  'refuses a %s target without replacing or deleting it',
  async (kind) => {
    await prepareCredentialDirectory(directory);
    const path = join(directory, filename),
      original = join(root, 'original');
    await writeFile(original, 'synthetic original bytes', { mode: 0o600 });
    if (kind === 'symlink') await symlink(original, path);
    else if (kind === 'hardlink') await link(original, path);
    else if (kind === 'directory') await mkdir(path, { mode: 0o700 });
    else {
      await writeFile(path, 'synthetic original bytes', {
        mode: kind === 'permissions' ? 0o644 : 0o600,
      });
      if (kind === 'owner') ports.foreignOwnerPath = path;
    }
    const inode = (await lstat(path)).ino;
    await expect(readCredentialRecordFile(directory, filename)).rejects.toThrow(
      failure,
    );
    await expect(
      writeCredentialRecordFile(directory, filename, 'replacement'),
    ).rejects.toThrow(failure);
    await expect(
      deleteCredentialRecordFile(directory, filename),
    ).rejects.toThrow(failure);
    expect((await lstat(path)).ino).toBe(inode);
    expect(await readFile(original, 'utf8')).toBe('synthetic original bytes');
    expect(await readdir(directory)).toEqual([filename]);
  },
);
it('legacy reads are bounded, strict UTF-8, and require exact 0600', async () => {
  const path = join(root, 'legacy.token');
  await writeFile(path, 'four', { mode: 0o600 });
  expect(await readPrivateCredentialFile(path, { maxBytes: 4 })).toBe('four');
  await expect(
    readPrivateCredentialFile(path, { maxBytes: 3 }),
  ).rejects.toThrow(failure);
  await chmod(path, 0o644);
  await expect(readPrivateCredentialFile(path)).rejects.toThrow(failure);
  await expect(deletePrivateCredentialFile(path)).rejects.toThrow(failure);
  await chmod(path, 0o600);
  await writeFile(path, Buffer.from([0xff]));
  await expect(readPrivateCredentialFile(path)).rejects.toThrow(failure);
});
it('rejects oversize records before writing and oversize existing files before reading or replacing', async () => {
  await expect(
    writeCredentialRecordFile(directory, filename, 'x'.repeat(16 * 1024 + 1)),
  ).rejects.toThrow(failure);
  expect(await readdir(root)).toEqual([]);
  await prepareCredentialDirectory(directory);
  const path = join(directory, filename);
  await writeFile(path, 'x'.repeat(16 * 1024 + 1), { mode: 0o600 });
  await expect(readCredentialRecordFile(directory, filename)).rejects.toThrow(
    failure,
  );
  await expect(
    writeCredentialRecordFile(directory, filename, 'small'),
  ).rejects.toThrow(failure);
  expect((await lstat(path)).size).toBe(16 * 1024 + 1);
});
it("failed rename retains the old bytes and removes only this call's temporary file", async () => {
  await writeCredentialRecordFile(directory, filename, 'old synthetic bytes');
  const other = join(directory, '.other-unrelated.tmp');
  await writeFile(other, 'leave me', { mode: 0o600 });
  ports.failRename = true;
  await expect(
    writeCredentialRecordFile(directory, filename, 'new synthetic secret'),
  ).rejects.toThrow(failure);
  expect(await readCredentialRecordFile(directory, filename)).toBe(
    'old synthetic bytes',
  );
  expect((await readdir(directory)).sort()).toEqual(
    ['.other-unrelated.tmp', filename].sort(),
  );
});
it('deletion errors are not mistaken for missing files or successful cleanup', async () => {
  await writeCredentialRecordFile(directory, filename, 'synthetic retained');
  ports.failDeletePath = join(directory, filename);
  await expect(deleteCredentialRecordFile(directory, filename)).rejects.toThrow(
    failure,
  );
  expect(await readCredentialRecordFile(directory, filename)).toBe(
    'synthetic retained',
  );
});
it('rechecks the opened inode after reading and refuses a same-size concurrent change', async () => {
  const path = join(root, 'legacy.token');
  await writeFile(path, 'old', { mode: 0o600 });
  ports.mutateReadPath = path;
  ports.mutateAfterRead = async () => {
    await writeFile(path, 'new', { mode: 0o600 });
    await utimes(path, new Date(0), new Date(0));
  };
  await expect(readPrivateCredentialFile(path)).rejects.toThrow(failure);
  expect(ports.opens.filter((item) => item.path === path)).toHaveLength(1);
});
it.runIf(process.platform === 'darwin' || process.platform === 'linux')(
  'opens a real synthetic FIFO nonblocking and rejects it before reading',
  async () => {
    const path = join(root, 'synthetic-fifo');
    // This command creates only this test's named pipe; never invokes security.
    await promisify(execFile)('/usr/bin/mkfifo', [path], { timeout: 1000 });
    await expect(readPrivateCredentialFile(path)).rejects.toThrow(failure);
    const flags = ports.opens.find((item) => item.path === path)
      ?.flags as number;
    expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
  },
  2000,
);
