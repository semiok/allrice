import { beforeEach, expect, it, vi } from 'vitest';
import type * as Config from './config.js';
import type * as Client from './client.js';

const ports = vi.hoisted(() => ({
  request: vi.fn(),
  token: vi.fn(),
  deleteToken: vi.fn(),
  deleteConfig: vi.fn(),
}));
vi.mock('./config.js', async (original) => ({
  ...(await original<typeof Config>()),
  readConfig: async () => ({
    deviceId: 'synthetic-device',
    server: 'https://synthetic.example/',
  }),
  readDeviceToken: ports.token,
  deleteDeviceToken: ports.deleteToken,
  deleteConfig: ports.deleteConfig,
}));
vi.mock('./client.js', async (original) => ({
  ...(await original<typeof Client>()),
  bridgeRequest: ports.request,
}));
import { revoke } from './core.js';

beforeEach(() => {
  vi.resetAllMocks();
  ports.token.mockResolvedValue('synthetic-secret');
  ports.request.mockResolvedValue({});
  ports.deleteToken.mockResolvedValue({
    complete: true,
    keychainDeleted: true,
    localFilesDeleted: true,
  });
  ports.deleteConfig.mockResolvedValue(true);
});

it('does not remove local pairing before the server confirms revocation', async () => {
  ports.request.mockRejectedValue(Error('synthetic server offline'));
  await expect(revoke()).rejects.toThrow('synthetic server offline');
  expect(ports.deleteToken).not.toHaveBeenCalled();
  expect(ports.deleteConfig).not.toHaveBeenCalled();
});

it('reports completed remote revocation separately from incomplete Keychain cleanup', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    ports.deleteToken.mockResolvedValue({
      complete: false,
      keychainDeleted: false,
      localFilesDeleted: true,
      keychainUnavailableReason: 'interaction-not-allowed',
    });
    expect(await revoke()).toMatchObject({
      serverRevoked: true,
      cleanupComplete: false,
      configDeleted: true,
    });
    expect(ports.request).toHaveBeenCalledTimes(1);
    expect(ports.deleteConfig).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('服务端授权已撤销，但本机凭证清理未完成'),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-secret');
  } finally {
    warn.mockRestore();
  }
});

it('does not claim complete cleanup when the config file cannot be removed', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    ports.deleteConfig.mockResolvedValue(false);
    expect(await revoke()).toMatchObject({
      serverRevoked: true,
      cleanupComplete: false,
      configDeleted: false,
    });
    expect(ports.request).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

it('reports complete cleanup only when every local store and config has been removed', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    expect(await revoke()).toMatchObject({
      serverRevoked: true,
      cleanupComplete: true,
      configDeleted: true,
    });
    expect(ports.deleteToken).toHaveBeenCalledExactlyOnceWith(
      'synthetic-device',
    );
  } finally {
    info.mockRestore();
  }
});
