import { mkdtemp, mkdir, open, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalDockerApi } from './local-docker-api.js';
import {
  reserveProjectArchive,
  retainProjectArchives,
  reserveProjectVolume,
  projectCacheLimits,
} from './project-cache.js';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
it('evicts idle private archives, retaining another active preparation and enforcing actual byte capacity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'allrice-project-cache-test-'));
  roots.push(root);
  const dir = join(root, 'a'.repeat(64));
  await mkdir(dir, { mode: 0o700 });
  const first = join(dir, 'b'.repeat(64)),
    second = join(dir, 'c'.repeat(64)),
    next = join(dir, 'd'.repeat(64));
  for (const path of [first, second]) {
    const f = await open(path, 'wx', 0o600);
    await f.truncate(64_000_000);
    await f.close();
  }
  const release = retainProjectArchives([first]);
  try {
    await reserveProjectArchive(root, next, 10_000_000);
    expect(await lstat(first)).toBeDefined();
    await expect(lstat(second)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      reserveProjectArchive(root, next, projectCacheLimits.archiveBytes),
    ).rejects.toThrow('PROJECT_CACHE_LIMIT');
    expect(await lstat(first)).toBeDefined();
  } finally {
    release();
  }
});
function volumeFixture(active: number, idle: number) {
  const api = new LocalDockerApi('/synthetic/project-cache.sock');
  const volumes = Array.from({ length: active + idle }, (_, i) => {
    const key = (i + 1).toString(16).padStart(64, '0');
    return {
      Name: `allrice-project-cache-${key}`,
      Driver: 'local',
      Options: null,
      Labels: { 'xyz.bplabs.allrice.project.cache': `sha256:${key}` },
      CreatedAt: new Date(1000 + i).toISOString(),
      UsageData: { Size: 100_000_000, RefCount: i < active ? 1 : 0 },
    };
  });
  const removed: string[] = [];
  vi.spyOn(api, 'json').mockImplementation(async (method, path) => {
    if (path === '/system/df') return { Volumes: volumes };
    if (method === 'GET')
      return volumes.find((v) => path === `/volumes/${v.Name}`);
    if (method === 'DELETE') {
      removed.push(path.slice('/volumes/'.length));
      return undefined;
    }
    throw Error('Unexpected cache API');
  });
  return { api, removed, volumes };
}
it('measures VM cache bytes and evicts only volumes with no container references', async () => {
  const f = volumeFixture(3, 4);
  await reserveProjectVolume(f.api, `allrice-project-cache-${'f'.repeat(64)}`);
  expect(f.removed).toHaveLength(4);
  expect(
    f.removed.some((n) => f.volumes.slice(0, 3).some((v) => v.Name === n)),
  ).toBe(false);
});
it('fails before creating work when active VM caches consume capacity; unknown/referenced work is preserved', async () => {
  const f = volumeFixture(4, 0);
  await expect(
    reserveProjectVolume(f.api, `allrice-project-cache-${'f'.repeat(64)}`),
  ).rejects.toThrow('PROJECT_CACHE_LIMIT');
  expect(f.removed).toHaveLength(0);
});
it('charges actual oversized referenced caches without deleting them or granting new capacity', async () => {
  const f = volumeFixture(1, 0);
  f.volumes[0]!.UsageData.Size = 600_000_000;
  await expect(
    reserveProjectVolume(f.api, `allrice-project-cache-${'f'.repeat(64)}`),
  ).rejects.toThrow('PROJECT_CACHE_LIMIT');
  expect(f.removed).toHaveLength(0);
});
it('replaces an oversized idle requested cache with one bounded reservation', async () => {
  const f = volumeFixture(0, 1);
  f.volumes[0]!.UsageData.Size = 600_000_000;
  await reserveProjectVolume(f.api, f.volumes[0]!.Name);
  expect(f.removed).toEqual([f.volumes[0]!.Name]);
});
