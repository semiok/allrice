import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type * as Os from 'node:os';
import { join } from 'node:path';
import { BridgeCapabilities, BridgeProtocolVersion } from '@allrice/contracts';
import type * as Client from './client.js';
import type * as Config from './config.js';

const ports = vi.hoisted(() => ({
  request: vi.fn(),
  token: vi.fn(),
  config: vi.fn(),
  platform: vi.fn(),
  arch: vi.fn(),
  calls: [] as string[],
}));
// This suite exercises macOS pairing through mocked network/storage ports. It
// does not make Linux a supported Bridge platform or contact a real device.
vi.mock('node:os', async (original) => ({
  ...(await original<typeof Os>()),
  platform: ports.platform,
  arch: ports.arch,
  hostname: () => 'synthetic-host',
}));
vi.mock('./client.js', async (original) => ({
  ...(await original<typeof Client>()),
  bridgeRequest: ports.request,
}));
vi.mock('./config.js', async (original) => ({
  ...(await original<typeof Config>()),
  storeDeviceToken: ports.token,
  writeConfig: ports.config,
}));
import { pair } from './core.js';
const deviceId = '00000000-0000-4000-8000-000000000099';
const roots: string[] = [];
beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'allrice-p13-pairing-'));
  roots.push(root);
  vi.stubEnv('ALLRICE_BRIDGE_CONFIG_PATH', join(root, 'config.json'));
  ports.calls.length = 0;
  vi.clearAllMocks();
  ports.platform.mockReturnValue('darwin');
  ports.arch.mockReturnValue('x64');
  ports.token.mockImplementation(async () => {
    ports.calls.push('token');
  });
  ports.config.mockImplementation(async () => {
    ports.calls.push('config');
  });
  ports.request.mockImplementation(async () => ({
    device: {
      id: deviceId,
      organizationId: deviceId,
      workspaceId: deviceId,
      ownerId: deviceId,
      name: 'Synthetic fresh pairing',
      platform: ports.arch() === 'arm64' ? 'macos-arm64' : 'macos-x64',
      protocolVersion: BridgeProtocolVersion,
      capabilities: BridgeCapabilities,
      status: 'online',
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      revokedAt: null,
    },
    deviceToken: 'synthetic-token-that-is-at-least-32-characters',
  }));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});
it.each([
  ['x64', 'ABCDEF12'],
  ['x64', 'abcd-ef12'],
  ['arm64', 'ABCDEF12'],
  ['arm64', 'abcd-ef12'],
])(
  'normalizes macOS %s %s and binds a new journal namespace after credential persistence (ports only)',
  async (arch, code) => {
    ports.arch.mockReturnValue(arch);
    await pair(['--server', 'https://tenant.example/', '--code', code]);
    expect(ports.request.mock.calls[0]?.[0].body.code).toBe('ABCD-EF12');
    expect(ports.request.mock.calls[0]?.[0].body.platform).toBe(
      `macos-${arch}`,
    );
    expect(ports.config).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId,
        journalNamespace: deviceId,
        grants: [],
      }),
    );
    expect(ports.calls).toEqual(['token', 'config']);
  },
);
it('does not consume invalid code or persist rejected pairing', async () => {
  await expect(
    pair(['--server', 'https://tenant.example/', '--code', 'bad code']),
  ).rejects.toThrow('配对码格式不正确');
  expect(ports.request).not.toHaveBeenCalled();
  ports.request.mockRejectedValueOnce(Error('PAIRING_EXPIRED'));
  await expect(
    pair(['--server', 'https://tenant.example/', '--code', 'ABCDEF12']),
  ).rejects.toThrow('PAIRING_EXPIRED');
  expect(ports.request).toHaveBeenCalledTimes(1);
  expect(ports.token).not.toHaveBeenCalled();
  expect(ports.config).not.toHaveBeenCalled();
});
it('does not replace configuration when credential persistence fails', async () => {
  ports.token.mockRejectedValueOnce(Error('KEYCHAIN_AND_FALLBACK_FAILED'));
  await expect(
    pair(['--server', 'https://tenant.example/', '--code', 'ABCDEF12']),
  ).rejects.toThrow('KEYCHAIN_AND_FALLBACK_FAILED');
  expect(ports.token).toHaveBeenCalledTimes(1);
  expect(ports.config).not.toHaveBeenCalled();
});
it.each([
  ['linux', 'x64'],
  ['win32', 'x64'],
  ['darwin', 'ia32'],
])(
  'rejects unsupported %s/%s before consuming a pairing code',
  async (platform, arch) => {
    ports.platform.mockReturnValue(platform);
    ports.arch.mockReturnValue(arch);
    await expect(
      pair(['--server', 'https://tenant.example/', '--code', 'ABCDEF12']),
    ).rejects.toThrow('supports Apple Silicon and Intel 64-bit macOS only');
    expect(ports.request).not.toHaveBeenCalled();
    expect(ports.token).not.toHaveBeenCalled();
    expect(ports.config).not.toHaveBeenCalled();
  },
);
