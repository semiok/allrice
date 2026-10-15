import { mkdtemp, readFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readConfig, writeConfig, type BridgeConfig } from './config.js';
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bridge-config-atomic-'));
  roots.push(root);
  const path = join(root, 'config.json');
  vi.stubEnv('ALLRICE_BRIDGE_CONFIG_PATH', path);
  const config: BridgeConfig = {
    server: 'https://synthetic.invalid',
    deviceId: 'synthetic',
    deviceName: 'fixture',
    grants: [],
  };
  await writeConfig(config);
  return { root, path, config };
}
it('readers only observe complete old or new configuration during replacements', async () => {
  const f = await fixture();
  await Promise.all([
    (async () => {
      for (let i = 0; i < 20; i++)
        await writeConfig({
          ...f.config,
          deviceName: `device-${i}`,
          grants: Array.from({ length: 16 }, (_, n) => ({
            id: `grant-${n}`,
            label: '授权目录',
            rootPath: `/fixture/${n}`,
            rootFingerprint: 'a'.repeat(64),
          })),
        });
    })(),
    (async () => {
      for (let i = 0; i < 200; i++)
        expect((await readConfig()).deviceId).toBe('synthetic');
    })(),
  ]);
  expect((await readConfig()).deviceName).toBe('device-19');
  expect((await stat(f.path)).mode & 0o777).toBe(0o600);
});
it('does not follow a configuration symlink or overwrite its target', async () => {
  const f = await fixture(),
    target = join(f.root, 'target.json');
  vi.stubEnv('ALLRICE_BRIDGE_CONFIG_PATH', target);
  await writeConfig(f.config);
  const original = await readFile(target, 'utf8');
  await rm(f.path);
  await symlink(target, f.path);
  vi.stubEnv('ALLRICE_BRIDGE_CONFIG_PATH', f.path);
  await expect(writeConfig({ ...f.config, grants: [] })).rejects.toThrow(
    'BRIDGE_CONFIG_FILE_UNSAFE',
  );
  expect(await readFile(target, 'utf8')).toBe(original);
});
