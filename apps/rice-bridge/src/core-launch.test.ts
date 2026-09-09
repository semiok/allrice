import { beforeEach, expect, it, vi } from 'vitest';
import type * as Config from './config.js';

const ports = vi.hoisted(() => ({ config: vi.fn(), token: vi.fn() }));
vi.mock('./config.js', async (original) => ({
  ...(await original<typeof Config>()),
  readConfig: ports.config,
  readDeviceToken: ports.token,
}));
import { hasStoredPairing } from './core.js';

beforeEach(() => {
  vi.resetAllMocks();
  ports.config.mockResolvedValue({ deviceId: 'synthetic-device' });
  ports.token.mockResolvedValue('synthetic-token');
});

it('enters first pairing only when the configuration itself is missing', async () => {
  ports.config.mockRejectedValue(
    Object.assign(Error('synthetic missing'), { code: 'ENOENT' }),
  );
  expect(await hasStoredPairing()).toBe(false);
  expect(ports.token).not.toHaveBeenCalled();
});

it('keeps an existing readable identity without consuming another pairing code', async () => {
  expect(await hasStoredPairing()).toBe(true);
  expect(ports.token).toHaveBeenCalledExactlyOnceWith('synthetic-device');
});

it.each(['ENOENT', 'EACCES', 'KEYCHAIN_UNAVAILABLE'])(
  'does not treat credential %s as an unpaired installation',
  async (code) => {
    ports.token.mockRejectedValue(
      Object.assign(Error('synthetic secret must not be shown'), { code }),
    );
    await expect(hasStoredPairing()).rejects.toThrow(
      '本机已有配对，但凭证暂不可读',
    );
    await expect(hasStoredPairing()).rejects.not.toThrow('synthetic secret');
  },
);

it.each([null, {}, { deviceId: '' }, { deviceId: 42 }])(
  'does not turn malformed existing configuration into first pairing',
  async (config) => {
    ports.config.mockResolvedValue(config);
    await expect(hasStoredPairing()).rejects.toThrow('本机配对配置无效');
    expect(ports.token).not.toHaveBeenCalled();
  },
);

it.each([
  new SyntaxError('synthetic config body'),
  Object.assign(Error('synthetic path'), { code: 'EACCES' }),
])(
  'preserves an existing unreadable configuration and reports only a safe diagnostic',
  async (error) => {
    ports.config.mockRejectedValue(error);
    await expect(hasStoredPairing()).rejects.toThrow('本机配对配置无法读取');
    await expect(hasStoredPairing()).rejects.not.toThrow('synthetic');
    expect(ports.token).not.toHaveBeenCalled();
  },
);
