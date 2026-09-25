import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  applyCapabilitySettings,
  localCapabilitySettings,
} from './capability-settings.js';
import { saveLocalBrowserOptIn } from './local-browser-settings.js';
import { saveSandboxOptIn } from './sandbox-settings.js';
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const config = {
  deviceId: 'synthetic',
  server: 'https://tenant.example/',
  deviceName: 'test',
  grants: [],
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bridge-capabilities-'));
  roots.push(root);
  const path = join(root, 'config.json');
  vi.stubEnv('ALLRICE_BRIDGE_CONFIG_PATH', path);
  await writeFile(path, JSON.stringify(config));
  return path;
}
it('defaults all three on and retains existing local choices until an owner changes them', async () => {
  const path = await fixture();
  const before = await readFile(path, 'utf8');
  expect(await localCapabilitySettings(config)).toEqual({
    revision: 0,
    settings: { localCommand: true, localBrowser: true, development: true },
  });
  await saveLocalBrowserOptIn(config, false);
  await saveSandboxOptIn(config, false);
  expect((await localCapabilitySettings(config)).settings).toEqual({
    localCommand: false,
    localBrowser: false,
    development: true,
  });
  await applyCapabilitySettings(config, {
    revision: 1,
    settings: { localCommand: true, localBrowser: true, development: false },
  });
  expect(await localCapabilitySettings(config)).toEqual({
    revision: 1,
    settings: { localCommand: true, localBrowser: true, development: false },
  });
  expect(await readFile(path, 'utf8')).toBe(before);
});
it('does not replay acknowledged settings over a later local choice and keeps revisions bound to the pairing', async () => {
  await fixture();
  const first = {
    revision: 2,
    settings: { localCommand: true, localBrowser: true, development: true },
  };
  await applyCapabilitySettings(config, first);
  await saveLocalBrowserOptIn(config, false);
  await applyCapabilitySettings(config, first);
  await applyCapabilitySettings(config, { ...first, revision: 1 });
  expect((await localCapabilitySettings(config)).settings.localBrowser).toBe(
    false,
  );
  expect(
    (await localCapabilitySettings({ ...config, deviceId: 'other-device' }))
      .revision,
  ).toBe(0);
  await applyCapabilitySettings(config, { ...first, revision: 3 });
  expect((await localCapabilitySettings(config)).settings.localBrowser).toBe(
    true,
  );
});
