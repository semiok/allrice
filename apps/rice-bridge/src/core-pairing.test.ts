import { beforeEach, expect, it, vi } from 'vitest';
import { BridgeCapabilities, BridgeProtocolVersion } from '@allrice/contracts';
import type * as Client from './client.js';
import type * as Config from './config.js';

const ports = vi.hoisted(() => ({
  request: vi.fn(),
  token: vi.fn(),
  config: vi.fn(),
  calls: [] as string[],
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
beforeEach(() => {
  ports.calls.length = 0;
  vi.clearAllMocks();
  ports.token.mockImplementation(async () => {
    ports.calls.push('token');
  });
  ports.config.mockImplementation(async () => {
    ports.calls.push('config');
  });
  ports.request.mockResolvedValue({
    device: {
      id: deviceId,
      organizationId: deviceId,
      workspaceId: deviceId,
      ownerId: deviceId,
      name: 'Synthetic fresh pairing',
      platform: process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64',
      protocolVersion: BridgeProtocolVersion,
      capabilities: BridgeCapabilities,
      status: 'online',
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      revokedAt: null,
    },
    deviceToken: 'synthetic-token-that-is-at-least-32-characters',
  });
});
it.each(['ABCDEF12', 'abcd-ef12'])(
  'normalizes %s and binds a new journal namespace after credential persistence (ports only)',
  async (code) => {
    await pair(['--server', 'https://tenant.example/', '--code', code]);
    expect(ports.request.mock.calls[0]?.[0].body.code).toBe('ABCD-EF12');
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
  ).rejects.toThrow();
  expect(ports.request).not.toHaveBeenCalled();
  ports.request.mockRejectedValueOnce(Error('PAIRING_EXPIRED'));
  await expect(
    pair(['--server', 'https://tenant.example/', '--code', 'ABCDEF12']),
  ).rejects.toThrow();
  expect(ports.token).not.toHaveBeenCalled();
  expect(ports.config).not.toHaveBeenCalled();
});
it('does not replace configuration when credential persistence fails', async () => {
  ports.token.mockRejectedValueOnce(Error('KEYCHAIN_AND_FALLBACK_FAILED'));
  await expect(
    pair(['--server', 'https://tenant.example/', '--code', 'ABCDEF12']),
  ).rejects.toThrow();
  expect(ports.config).not.toHaveBeenCalled();
});
