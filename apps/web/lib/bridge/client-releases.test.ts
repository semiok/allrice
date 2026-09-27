import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { bridgeClientReleases } from './client-releases';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bridge-release-'));
  roots.push(root);
  const archive = join(root, 'RiceBridge-M.zip');
  await writeFile(archive, 'synthetic archive');
  vi.stubEnv('ALLRICE_BRIDGE_MACOS_ARM64_PATH', archive);
  vi.stubEnv('ALLRICE_BRIDGE_MACOS_X64_PATH', '');
  const manifest = {
    platform: 'macos-arm64',
    version: '0.6.0-dev.7',
    zip: archive,
  };
  await writeFile(join(root, 'release.json'), JSON.stringify(manifest));
  return { root, archive, manifest };
}
it('uses the selected archive manifest instead of an application source version, and follows a download switch', async () => {
  const f = await fixture();
  expect(await bridgeClientReleases()).toEqual([
    { platform: 'macos-arm64', available: true, version: '0.6.0-dev.7' },
    { platform: 'macos-x64', available: false, version: null },
  ]);
  const next = join(f.root, 'next');
  await mkdir(next);
  const archive = join(next, 'RiceBridge-M.zip');
  await writeFile(archive, 'different archive');
  await writeFile(
    join(next, 'release.json'),
    JSON.stringify({ ...f.manifest, version: '0.6.0-dev.10', zip: archive }),
  );
  vi.stubEnv('ALLRICE_BRIDGE_MACOS_ARM64_PATH', archive);
  expect((await bridgeClientReleases())[0]?.version).toBe('0.6.0-dev.10');
});
it.each([
  { platform: 'macos-x64' },
  { zip: 'different.zip' },
  { version: 'unknown-build' },
])('does not label a mismatching manifest as latest: %j', async (change) => {
  const f = await fixture();
  await writeFile(
    join(f.root, 'release.json'),
    JSON.stringify({ ...f.manifest, ...change }),
  );
  expect((await bridgeClientReleases())[0]).toEqual({
    platform: 'macos-arm64',
    available: true,
    version: null,
  });
});
it('does not advertise a missing archive, and keeps legacy downloads available without invented versions', async () => {
  const f = await fixture();
  await rm(join(f.root, 'release.json'));
  expect((await bridgeClientReleases())[0]).toEqual({
    platform: 'macos-arm64',
    available: true,
    version: null,
  });
  await rm(f.archive);
  expect((await bridgeClientReleases())[0]).toEqual({
    platform: 'macos-arm64',
    available: false,
    version: null,
  });
});
