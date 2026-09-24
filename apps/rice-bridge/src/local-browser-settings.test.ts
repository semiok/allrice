import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  localBrowserOptIn,
  saveLocalBrowserOptIn,
} from './local-browser-settings.js';
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'allrice-p22-optin-'));
  roots.push(root);
  const configPath = join(root, 'config.json');
  vi.stubEnv('ALLRICE_BRIDGE_CONFIG_PATH', configPath);
  return {
    path: join(`${configPath}.browser-settings`, 'opt-in.json'),
    config: {
      server: 'https://saas.example',
      deviceId: randomUUID(),
      deviceName: 'synthetic',
      grants: [],
    },
  };
}
describe('P22 normal App persistent opt-in', () => {
  it('is default on, requires neither selected folder nor a VM, and is revocable while App runs', async () => {
    const { config, path } = await fixture();
    expect(await localBrowserOptIn(config)).toBe(true);
    await saveLocalBrowserOptIn(config, true);
    expect(await localBrowserOptIn(config)).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 1,
      enabled: true,
      deviceId: config.deviceId,
      server: config.server,
    });
    await saveLocalBrowserOptIn(config, false);
    expect(await localBrowserOptIn(config)).toBe(false);
  });
  it('changing server or device invalidates old opt-in; untrusted permissions fail closed without chmod', async () => {
    const { config, path } = await fixture();
    await saveLocalBrowserOptIn(config, true);
    expect(await localBrowserOptIn({ ...config, deviceId: randomUUID() })).toBe(
      false,
    );
    expect(
      await localBrowserOptIn({ ...config, server: 'https://other.example' }),
    ).toBe(false);
    await chmod(path, 0o644);
    await expect(localBrowserOptIn(config)).rejects.toThrow(
      'LOCAL_BROWSER_SETTINGS_UNSAFE',
    );
    await expect(saveLocalBrowserOptIn(config, false)).rejects.toThrow(
      'LOCAL_BROWSER_SETTINGS_UNSAFE',
    );
  });
});
