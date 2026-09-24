import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  localPreviewOptIn,
  saveLocalPreviewOptIn,
} from './local-preview-settings.js';
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'allrice-p23-optin-'));
  roots.push(root);
  const path = join(root, 'config.json');
  vi.stubEnv('ALLRICE_BRIDGE_CONFIG_PATH', path);
  return {
    root,
    file: join(`${path}.preview-settings`, 'opt-in.json'),
    config: {
      server: 'https://saas.example',
      deviceId: randomUUID(),
      deviceName: 'Synthetic preview',
      grants: [],
    },
  };
}
describe('local preview consent', () => {
  it('starts on, survives reopen, is device/server-bound and can be disabled independently', async () => {
    const { config } = await fixture();
    expect(await localPreviewOptIn(config)).toBe(true);
    await saveLocalPreviewOptIn(config, true);
    expect(await localPreviewOptIn({ ...config })).toBe(true);
    expect(await localPreviewOptIn({ ...config, deviceId: randomUUID() })).toBe(
      false,
    );
    expect(
      await localPreviewOptIn({ ...config, server: 'https://other.example' }),
    ).toBe(false);
    await saveLocalPreviewOptIn(config, false);
    expect(await localPreviewOptIn(config)).toBe(false);
  });
  it('does not repair or overwrite an unsafe or malformed settings file', async () => {
    const { config, file } = await fixture();
    await saveLocalPreviewOptIn(config, true);
    await chmod(file, 0o644);
    await expect(saveLocalPreviewOptIn(config, false)).rejects.toThrow(
      'LOCAL_PREVIEW_SETTINGS_UNSAFE',
    );
    await chmod(file, 0o600);
    await writeFile(
      file,
      JSON.stringify({
        ...JSON.parse(await readFile(file, 'utf8')),
        arbitraryPort: 5432,
      }),
    );
    await expect(localPreviewOptIn(config)).rejects.toThrow(
      'LOCAL_PREVIEW_SETTINGS_UNSAFE',
    );
  });
  it('rejects a symlink without modifying its target', async () => {
    const { root, config, file } = await fixture();
    await saveLocalPreviewOptIn(config, true);
    const other = join(root, 'unrelated.txt');
    await writeFile(other, 'keep', { mode: 0o600 });
    await unlink(file);
    await symlink(other, file);
    await expect(saveLocalPreviewOptIn(config, false)).rejects.toThrow(
      'LOCAL_PREVIEW_SETTINGS_UNSAFE',
    );
    expect(await readFile(other, 'utf8')).toBe('keep');
  });
});
