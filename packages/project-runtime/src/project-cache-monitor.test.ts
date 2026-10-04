import {
  mkdtemp,
  writeFile,
  readdir,
  lstat,
  rename,
  mkdir,
  rm,
  open,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { nodeProjectSupervisor } from './project-supervisor.ts';

type Read = typeof readdir;
/** Execute the exact embedded PID-1 cache validation, with real installer I/O. */
function checker(root: string, read: Read = readdir, stat = lstat) {
  const start = nodeProjectSupervisor.indexOf('async function checkCache()');
  const end = nodeProjectSupervisor.indexOf('\nconst cacheTimer=', start);
  const source = nodeProjectSupervisor
    .slice(start, end)
    .replaceAll("'/cache'", JSON.stringify(root));
  return runInNewContext(
    `(async (readdir,lstat)=>{${source};return checkCache();})`,
  )(read, stat) as Promise<void>;
}
async function fixture(test: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'allrice-cache-monitor-'));
  try {
    await test(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
it('installer atomic file publication does not terminate project preparation', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'temporary'), 'verified package');
    const read = (async (
      path: Parameters<Read>[0],
      options: Parameters<Read>[1],
    ) => {
      const entries = await readdir(path, options);
      await rename(join(root, 'temporary'), join(root, 'published'));
      return entries;
    }) as Read;
    await expect(checker(root, read)).resolves.toBeUndefined();
    await expect(checker(root)).resolves.toBeUndefined();
  });
});
it('installer removal of a listed temporary directory is benign', async () => {
  await fixture(async (root) => {
    await mkdir(join(root, 'temporary'));
    const read = (async (
      path: Parameters<Read>[0],
      options: Parameters<Read>[1],
    ) => {
      const entries = await readdir(path, options);
      if (path === root) await rm(join(root, 'temporary'), { recursive: true });
      return entries;
    }) as Read;
    await expect(checker(root, read)).resolves.toBeUndefined();
  });
});
it('the original cache byte ceiling still rejects an oversized package', async () => {
  await fixture(async (root) => {
    const file = await open(join(root, 'large'), 'w');
    try {
      await file.truncate(128_000_001);
    } finally {
      await file.close();
    }
    await expect(checker(root)).rejects.toThrow('cache limit');
  });
});
it('loss of the cache mount fails closed', async () => {
  await fixture(async (root) => {
    await rm(root, { recursive: true });
    await expect(checker(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
it('cache mount loss after listing cannot be mistaken for disappearing temporary files', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'file'), 'package');
    const read = (async (
      path: Parameters<Read>[0],
      options: Parameters<Read>[1],
    ) => {
      const entries = await readdir(path, options);
      await rm(root, { recursive: true });
      return entries;
    }) as Read;
    await expect(checker(root, read)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
it('permission and other cache I/O errors still fail closed', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'file'), 'package');
    const stat = (async () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    }) as typeof lstat;
    await expect(checker(root, readdir, stat)).rejects.toMatchObject({
      code: 'EACCES',
    });
  });
});
