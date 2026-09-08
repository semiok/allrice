import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ports = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: ports.run,
  }),
}));
import { readDeviceCredentials, readDeviceToken } from './config.js';
const roots: string[] = [];
beforeEach(() => {
  vi.stubEnv('ALLRICE_BRIDGE_DEVICE_TOKEN', undefined);
  ports.run.mockReset();
  ports.run.mockRejectedValue(Error('synthetic Keychain unavailable'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});
it('identifies environment credentials without querying Keychain (source projection only)', async () => {
  vi.stubEnv('ALLRICE_BRIDGE_DEVICE_TOKEN', 'synthetic-env');
  expect(await readDeviceCredentials('synthetic')).toEqual({
    token: 'synthetic-env',
    storage: 'environment',
  });
  expect(ports.run).not.toHaveBeenCalled();
});
it('projects a successful Keychain read without changing the legacy string API (mocked port)', async () => {
  ports.run.mockResolvedValue({ stdout: 'synthetic-keychain\n' });
  expect(await readDeviceCredentials('synthetic')).toEqual({
    token: 'synthetic-keychain',
    storage: 'keychain',
  });
  expect(await readDeviceToken('synthetic')).toBe('synthetic-keychain');
});
it('projects actual fallback permissions read-only and never pretends an unsafe file is 0600', async () => {
  const root = await mkdtemp(join(tmpdir(), 'allrice-p13-credential-'));
  roots.push(root);
  const config = join(root, 'config.json');
  vi.stubEnv('ALLRICE_BRIDGE_CONFIG_PATH', config);
  await writeFile(`${config}.token`, 'synthetic-file\n', { mode: 0o600 });
  expect(await readDeviceCredentials('synthetic')).toEqual({
    token: 'synthetic-file',
    storage: 'private-file',
    privateFileSecure: true,
  });
  await chmod(`${config}.token`, 0o644);
  expect(await readDeviceCredentials('synthetic')).toMatchObject({
    storage: 'private-file',
    privateFileSecure: false,
  });
  expect(await readFile(`${config}.token`, 'utf8')).toBe('synthetic-file\n');
});
