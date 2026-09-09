import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const ports = vi.hoisted(() => ({ run: vi.fn() }));
// No security command or system credential is accessed by this suite.
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: ports.run,
  }),
}));
import {
  deleteKeychainToken,
  KeychainUnavailableError,
  readKeychainToken,
  storeKeychainToken,
} from './keychain.js';

const device = '00000000-0000-4000-8000-000000000088';
const token = 'synthetic-device-token-not-a-real-credential';
const service = 'ai.traditionow.allrice.rice-bridge';
const options = {
  encoding: 'utf8',
  timeout: 5000,
  maxBuffer: 65536,
  killSignal: 'SIGKILL',
};
beforeEach(() => {
  ports.run.mockReset();
  ports.run.mockResolvedValue({ stdout: '', stderr: '' });
});
afterEach(() => vi.restoreAllMocks());

it('reads the exact service/account with a bounded child and trims its token', async () => {
  ports.run.mockResolvedValue({ stdout: `${token}\n`, stderr: '' });
  await expect(readKeychainToken(device)).resolves.toBe(token);
  expect(ports.run).toHaveBeenCalledExactlyOnceWith(
    '/usr/bin/security',
    ['find-generic-password', '-s', service, '-a', device, '-w'],
    options,
  );
});

it('keeps the exact existing store command without retry or implicit access-policy flags', async () => {
  await expect(storeKeychainToken(device, token)).resolves.toBeUndefined();
  expect(ports.run).toHaveBeenCalledExactlyOnceWith(
    '/usr/bin/security',
    ['add-generic-password', '-U', '-s', service, '-a', device, '-w', token],
    options,
  );
});

it('deletes only the exact service/account using the same bounded options', async () => {
  await expect(deleteKeychainToken(device)).resolves.toBeUndefined();
  expect(ports.run).toHaveBeenCalledExactlyOnceWith(
    '/usr/bin/security',
    ['delete-generic-password', '-s', service, '-a', device],
    options,
  );
});

it.each([
  [
    {
      code: 36,
      stderr:
        'security: SecKeychainItemCreateFromContent (<default>): User interaction is not allowed.\n',
    },
    'interaction-not-allowed',
  ],
  [
    {
      code: 44,
      stderr:
        'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n',
    },
    'item-not-found',
  ],
  [{ killed: true, signal: 'SIGKILL' }, 'timed-out'],
  [{ code: 36 }, 'unavailable'],
  [{ code: 44 }, 'unavailable'],
  [{ code: 44, stderr: 'User interaction is not allowed.' }, 'unavailable'],
  [
    {
      code: 36,
      stderr: 'The specified item could not be found in the keychain.',
    },
    'unavailable',
  ],
  [{ code: '36', stderr: 'User interaction is not allowed.' }, 'unavailable'],
  [{ code: 36, message: 'User interaction is not allowed.' }, 'unavailable'],
  [{ killed: true, signal: 'SIGTERM' }, 'unavailable'],
  [{ killed: false, signal: 'SIGKILL' }, 'unavailable'],
  [{ code: 'ENOENT' }, 'unavailable'],
  [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'unavailable'],
  [
    {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      killed: true,
      signal: 'SIGKILL',
    },
    'unavailable',
  ],
  [null, 'unavailable'],
  ['arbitrary subprocess failure', 'unavailable'],
])(
  'classifies only the allowed failure pair %j as %s',
  async (failure, reason) => {
    ports.run.mockRejectedValue(failure);
    await expect(readKeychainToken(device)).rejects.toMatchObject({
      name: 'KeychainUnavailableError',
      message: 'KEYCHAIN_UNAVAILABLE',
      reason,
    });
    expect(ports.run).toHaveBeenCalledTimes(1);
  },
);

it.each(['', ' \n\t '])(
  'rejects an empty successful read (%j)',
  async (stdout) => {
    ports.run.mockResolvedValue({ stdout });
    await expect(readKeychainToken(device)).rejects.toMatchObject({
      message: 'KEYCHAIN_UNAVAILABLE',
      reason: 'unavailable',
    });
    expect(ports.run).toHaveBeenCalledTimes(1);
  },
);

it.each(['read', 'store', 'delete'] as const)(
  'sanitizes %s failures without retaining stderr, argv, token, paths or cause',
  async (operation) => {
    const secretPath = '/private/synthetic-keychain-sensitive-path';
    const failure = Object.assign(
      new Error(`Command failed: ${secretPath} -w ${token}`),
      {
        code: 36,
        stderr: `${secretPath} ${token}: User interaction is not allowed.`,
        stdout: token,
        cmd: `${secretPath} -w ${token}`,
        spawnargs: ['-w', token],
      },
    );
    ports.run.mockRejectedValue(failure);
    const logs = ['log', 'info', 'warn', 'error'].map((method) =>
      vi
        .spyOn(console, method as 'log' | 'info' | 'warn' | 'error')
        .mockImplementation(() => undefined),
    );
    const result = await (
      operation === 'read'
        ? readKeychainToken(device)
        : operation === 'store'
          ? storeKeychainToken(device, token)
          : deleteKeychainToken(device)
    ).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(KeychainUnavailableError);
    expect(result).toMatchObject({
      message: 'KEYCHAIN_UNAVAILABLE',
      reason: 'interaction-not-allowed',
    });
    expect(result).not.toHaveProperty('cause');
    expect(result).not.toHaveProperty('stderr');
    expect(result).not.toHaveProperty('stdout');
    expect(result).not.toHaveProperty('cmd');
    expect(result).not.toHaveProperty('spawnargs');
    const exported = `${String(result)}\n${JSON.stringify(result)}\n${(result as Error).stack}`;
    expect(exported).not.toContain(token);
    expect(exported).not.toContain(secretPath);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    expect(ports.run).toHaveBeenCalledTimes(1);
  },
);
