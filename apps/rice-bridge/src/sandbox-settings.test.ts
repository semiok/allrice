import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  chmod,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { sandboxOptIn, saveSandboxOptIn } from './sandbox-settings.js';
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const config = {
  deviceId: 'synthetic',
  server: 'https://tenant.example/',
  deviceName: 'fixture',
  grants: [],
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'allrice-sandbox-settings-'));
  roots.push(root);
  const path = join(root, 'config.json');
  vi.stubEnv('ALLRICE_BRIDGE_CONFIG_PATH', path);
  await writeFile(path, JSON.stringify(config));
  return path;
}
it('defaults on, persists private opt-in, binds pairing and preserves existing config', async () => {
  const path = await fixture(),
    before = await readFile(path, 'utf8');
  expect(await sandboxOptIn(config)).toBe(true);
  await saveSandboxOptIn(config, true);
  expect(await sandboxOptIn(config)).toBe(true);
  expect((await stat(`${path}.sandbox.json`)).mode & 0o777).toBe(0o600);
  expect(await sandboxOptIn({ ...config, deviceId: 'new-device' })).toBe(false);
  expect(
    await sandboxOptIn({ ...config, server: 'https://other.example/' }),
  ).toBe(false);
  await saveSandboxOptIn(config, false);
  expect(await sandboxOptIn(config)).toBe(false);
  expect(await readFile(path, 'utf8')).toBe(before);
});
it.each(['invalid', 'permissions', 'symlink'])(
  'rejects unsafe saved settings: %s',
  async (kind) => {
    const path = await fixture(),
      target = `${path}.sandbox.json`;
    if (kind === 'symlink') await symlink(path, target);
    else {
      await writeFile(target, kind === 'invalid' ? '{' : '{}', { mode: 0o600 });
      if (kind === 'permissions') await chmod(target, 0o644);
    }
    await expect(sandboxOptIn(config)).rejects.toThrow(
      'INVALID_SANDBOX_SETTINGS',
    );
    await expect(saveSandboxOptIn(config, true)).rejects.toThrow();
  },
);
