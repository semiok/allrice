import { chmod, lstat, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BridgeInstanceLock } from './instance-lock.js';

const roots: string[] = [];
const locks: BridgeInstanceLock[] = [];
afterEach(async () => {
  for (const lock of locks.splice(0)) lock.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-p13-lock-')),
  );
  roots.push(root);
  return { root, config: join(root, 'config.json') };
}
it('owns a private OS lock until close without deleting the lock database', async () => {
  const f = await fixture();
  const lock = await BridgeInstanceLock.acquire(f.config);
  locks.push(lock);
  await expect(BridgeInstanceLock.acquire(f.config)).rejects.toThrow(
    'BRIDGE_ALREADY_RUNNING',
  );
  expect((await lstat(f.config + '.runtime-owner')).mode & 0o777).toBe(0o700);
  expect(
    (await lstat(f.config + '.runtime-owner/owner.sqlite')).mode & 0o777,
  ).toBe(0o600);
  lock.close();
  locks.push(await BridgeInstanceLock.acquire(f.config));
});
it('refuses symlinked/unsafe owner paths', async () => {
  const f = await fixture();
  await symlink(f.root, f.config + '.runtime-owner');
  await expect(BridgeInstanceLock.acquire(f.config)).rejects.toThrow(
    'BRIDGE_INSTANCE_PATH_UNSAFE',
  );
  const g = await fixture();
  const lock = await BridgeInstanceLock.acquire(g.config);
  lock.close();
  await chmod(g.config + '.runtime-owner/owner.sqlite', 0o644);
  await expect(BridgeInstanceLock.acquire(g.config)).rejects.toThrow(
    'BRIDGE_INSTANCE_PATH_UNSAFE',
  );
});
