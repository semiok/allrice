import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type * as Os from 'node:os';
import type * as CredentialFiles from './credential-files.js';
import { join } from 'node:path';

const ports = vi.hoisted(() => ({
  read: vi.fn(),
  store: vi.fn(),
  remove: vi.fn(),
  platform: vi.fn(),
  writeRecord: vi.fn(),
  writeRecordEnabled: false,
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof Os>()),
  platform: ports.platform,
}));
// No real security process can be called from this persistence/selection suite.
vi.mock('./keychain.js', () => ({
  KeychainUnavailableError: class extends Error {
    constructor(public readonly reason: string) {
      super('KEYCHAIN_UNAVAILABLE');
      this.name = 'KeychainUnavailableError';
    }
  },
  readKeychainToken: ports.read,
  storeKeychainToken: ports.store,
  deleteKeychainToken: ports.remove,
}));
vi.mock('./credential-files.js', async (original) => {
  const actual = await original<typeof CredentialFiles>();
  return {
    ...actual,
    writeCredentialRecordFile: (
      ...args: Parameters<typeof actual.writeCredentialRecordFile>
    ) =>
      ports.writeRecordEnabled
        ? ports.writeRecord(...args)
        : actual.writeCredentialRecordFile(...args),
  };
});
import { KeychainUnavailableError } from './keychain.js';
import {
  configPath,
  deleteConfig,
  deleteDeviceToken,
  readDeviceCredentials,
  readDeviceToken,
  storeDeviceToken,
  writeConfig,
} from './config.js';
let root: string;
const deviceA = '00000000-0000-4000-8000-000000000001';
const deviceB = '00000000-0000-4000-8000-000000000002';
const hash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
const recordDirectory = () => `${configPath()}.credentials`;
const recordPath = (id = deviceA) => join(recordDirectory(), `${id}.json`);
const keychainRecord = (token = 'synthetic-keychain', id = deviceA) => ({
  version: 1,
  deviceId: id,
  storage: 'keychain',
  tokenSha256: hash(token),
});
async function existingConfig(id = deviceA) {
  await writeConfig({
    deviceId: id,
    deviceName: 'Synthetic fixture',
    server: 'https://tenant.example/',
    grants: [],
  });
}
async function legacyToken(value = 'synthetic-legacy', id = deviceA) {
  await existingConfig(id);
  await writeFile(`${configPath()}.token`, `${value}\n`, { mode: 0o600 });
}
async function record(value: unknown, id = deviceA) {
  await mkdir(recordDirectory(), { mode: 0o700 });
  await writeFile(recordPath(id), JSON.stringify(value), { mode: 0o600 });
}
const unavailable = () =>
  new KeychainUnavailableError('interaction-not-allowed');
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'allrice-device-credentials-'));
  vi.stubEnv('ALLRICE_BRIDGE_CONFIG_PATH', join(root, 'config.json'));
  vi.stubEnv('ALLRICE_BRIDGE_DEVICE_TOKEN', undefined);
  vi.stubEnv('ALLRICE_BRIDGE_STATIC_DEVICE_ID', undefined);
  vi.stubEnv('ALLRICE_BRIDGE_STATIC_SERVER', undefined);
  ports.platform.mockReset().mockReturnValue('darwin');
  ports.read.mockReset().mockRejectedValue(unavailable());
  ports.store.mockReset().mockRejectedValue(unavailable());
  ports.remove.mockReset().mockResolvedValue(undefined);
  ports.writeRecord.mockReset();
  ports.writeRecordEnabled = false;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true });
});

describe('authoritative per-device credential records', () => {
  it('keeps environment precedence without querying Keychain or unsafe records', async () => {
    vi.stubEnv('ALLRICE_BRIDGE_DEVICE_TOKEN', 'synthetic-env');
    await symlink(root, recordDirectory());
    expect(await readDeviceCredentials(deviceA)).toEqual({
      token: 'synthetic-env',
      storage: 'environment',
    });
    expect(ports.read).not.toHaveBeenCalled();
  });
  it('uses newly committed fallback even when a stale Keychain token becomes readable', async () => {
    await storeDeviceToken(deviceA, 'synthetic-new');
    ports.read.mockResolvedValue('synthetic-stale-keychain');
    expect(await readDeviceCredentials(deviceA)).toEqual({
      token: 'synthetic-new',
      storage: 'private-file',
      privateFileSecure: true,
      keychainUnavailableReason: 'interaction-not-allowed',
    });
    expect(await readDeviceToken(deviceA)).toBe('synthetic-new');
    expect(ports.read).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(recordPath(), 'utf8'))).toEqual({
      version: 1,
      deviceId: deviceA,
      storage: 'private-file',
      token: 'synthetic-new',
      keychainUnavailableReason: 'interaction-not-allowed',
    });
    await expect(lstat(`${configPath()}.token`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('never revives legacy fallback after Keychain store, retaining only its token hash', async () => {
    await legacyToken('synthetic-legacy', deviceB);
    ports.store.mockResolvedValue(undefined);
    await storeDeviceToken(deviceA, 'synthetic-keychain-new');
    await existingConfig(deviceA);
    expect(JSON.parse(await readFile(recordPath(), 'utf8'))).toEqual(
      keychainRecord('synthetic-keychain-new'),
    );
    expect(await readFile(recordPath(), 'utf8')).not.toContain(
      'synthetic-keychain-new',
    );
    await expect(readDeviceCredentials(deviceA)).rejects.toMatchObject({
      reason: 'interaction-not-allowed',
    });
    expect(await readFile(`${configPath()}.token`, 'utf8')).toBe(
      'synthetic-legacy\n',
    );
    ports.read.mockResolvedValue('synthetic-keychain-new');
    expect(await readDeviceCredentials(deviceA)).toEqual({
      token: 'synthetic-keychain-new',
      storage: 'keychain',
    });
  });
  it('rejects a changed Keychain value instead of accepting it through an older source record', async () => {
    await record(keychainRecord('synthetic-before'));
    ports.read.mockResolvedValue('synthetic-after');
    await expect(readDeviceToken(deviceA)).rejects.toThrow(
      'BRIDGE_CREDENTIAL_KEYCHAIN_MISMATCH',
    );
  });
  it('preserves old device identity when a new device record cannot be persisted', async () => {
    await record(keychainRecord('synthetic-before'));
    const original = await readFile(recordPath(), 'utf8');
    ports.store.mockImplementation(async () => {
      ports.read.mockImplementation(async (id: string) =>
        id === deviceA ? 'synthetic-before' : 'synthetic-new-device',
      );
    });
    ports.writeRecord.mockRejectedValue(Error('BRIDGE_CREDENTIAL_FILE_UNSAFE'));
    ports.writeRecordEnabled = true;
    await expect(
      storeDeviceToken(deviceB, 'synthetic-new-device'),
    ).rejects.toThrow('BRIDGE_CREDENTIAL_FILE_UNSAFE');
    expect(await readFile(recordPath(), 'utf8')).toBe(original);
    expect(await readDeviceToken(deviceA)).toBe('synthetic-before');
    await expect(lstat(recordPath(deviceB))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('keeps devices distinct when the subsequent pairing config cannot be persisted', async () => {
    await legacyToken('synthetic-old-a');
    await storeDeviceToken(deviceB, 'synthetic-new-b');
    expect(await readDeviceToken(deviceA)).toBe('synthetic-old-a');
    expect(await readDeviceToken(deviceB)).toBe('synthetic-new-b');
    await expect(
      storeDeviceToken(deviceA, 'synthetic-record-a'),
    ).rejects.toThrow('BRIDGE_CREDENTIAL_LEGACY_REPLACEMENT_REQUIRES_PAIRING');
    expect(await readDeviceToken(deviceA)).toBe('synthetic-old-a');
    expect(await readDeviceToken(deviceB)).toBe('synthetic-new-b');
    expect(await readdir(recordDirectory())).toEqual([`${deviceB}.json`]);
  });
  it('creates a private atomic record and repeats the same token without any write', async () => {
    await storeDeviceToken(deviceA, 'synthetic-before');
    const before = await lstat(recordPath());
    await storeDeviceToken(deviceA, 'synthetic-before');
    const after = await lstat(recordPath());
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.mode & 0o777).toBe(0o600);
    expect((await lstat(recordDirectory())).mode & 0o777).toBe(0o700);
    expect(await readdir(recordDirectory())).toEqual([`${deviceA}.json`]);
    expect(await readDeviceToken(deviceA)).toBe('synthetic-before');
    expect(ports.store).toHaveBeenCalledTimes(1);
  });
  it.each(['keychain', 'private-file'])(
    'rejects implicit rotation of existing %s authority without changing either store',
    async (storage) => {
      if (storage === 'keychain') ports.store.mockResolvedValue(undefined);
      await storeDeviceToken(deviceA, 'synthetic-before');
      const before = await readFile(recordPath(), 'utf8');
      ports.store.mockClear();
      await expect(
        storeDeviceToken(deviceA, 'synthetic-after'),
      ).rejects.toThrow('BRIDGE_CREDENTIAL_REPLACEMENT_REQUIRES_PAIRING');
      expect(ports.store).not.toHaveBeenCalled();
      expect(await readFile(recordPath(), 'utf8')).toBe(before);
      await storeDeviceToken(deviceA, 'synthetic-before');
      expect(ports.store).not.toHaveBeenCalled();
    },
  );
  it.each(['timed-out', 'item-not-found', 'unavailable'] as const)(
    'retains sanitized %s reason in successful fallback',
    async (reason) => {
      ports.store.mockRejectedValue(new KeychainUnavailableError(reason));
      await storeDeviceToken(deviceA, 'synthetic-file');
      expect(await readDeviceCredentials(deviceA)).toMatchObject({
        keychainUnavailableReason: reason,
      });
    },
  );
  it('uses private records on non-macOS without invoking adapter', async () => {
    ports.platform.mockReturnValue('linux');
    await storeDeviceToken(deviceA, 'synthetic-linux');
    expect(await readDeviceCredentials(deviceA)).toEqual({
      token: 'synthetic-linux',
      storage: 'private-file',
      privateFileSecure: true,
      keychainUnavailableReason: 'unavailable',
    });
    expect(ports.store).not.toHaveBeenCalled();
    expect(ports.read).not.toHaveBeenCalled();
  });
  it('never silently changes committed Keychain source on a different platform', async () => {
    await record(keychainRecord());
    await legacyToken();
    ports.platform.mockReturnValue('linux');
    await expect(readDeviceCredentials(deviceA)).rejects.toMatchObject({
      reason: 'unavailable',
    });
    expect(ports.read).not.toHaveBeenCalled();
  });
});

describe('read-only legacy compatibility', () => {
  it('preserves legacy Keychain reads without creating files', async () => {
    ports.read.mockResolvedValue('synthetic-keychain');
    expect(await readDeviceCredentials(deviceA)).toEqual({
      token: 'synthetic-keychain',
      storage: 'keychain',
    });
    expect(await readdir(root)).toEqual([]);
    expect(ports.store).not.toHaveBeenCalled();
    expect(ports.remove).not.toHaveBeenCalled();
  });
  it.each(['darwin', 'linux'])(
    'reads secure %s legacy token for persisted device without migration',
    async (platform) => {
      ports.platform.mockReturnValue(platform);
      await legacyToken();
      const before = await lstat(`${configPath()}.token`);
      expect(await readDeviceCredentials(deviceA)).toEqual({
        token: 'synthetic-legacy',
        storage: 'private-file',
        privateFileSecure: true,
        ...(platform === 'darwin'
          ? { keychainUnavailableReason: 'interaction-not-allowed' }
          : {}),
      });
      expect((await lstat(`${configPath()}.token`)).mtimeMs).toBe(
        before.mtimeMs,
      );
      expect(await readdir(root)).toEqual(['config.json', 'config.json.token']);
      expect(ports.store).not.toHaveBeenCalled();
      expect(ports.remove).not.toHaveBeenCalled();
    },
  );
  it('rejects another device legacy reuse even with a static device override', async () => {
    await legacyToken();
    vi.stubEnv('ALLRICE_BRIDGE_STATIC_DEVICE_ID', deviceB);
    await expect(readDeviceCredentials(deviceB)).rejects.toThrow(
      'BRIDGE_CREDENTIAL_UNAVAILABLE',
    );
    expect(await readDeviceToken(deviceA)).toBe('synthetic-legacy');
  });
  it('rejects unbound legacy token without creating config or record', async () => {
    await writeFile(`${configPath()}.token`, 'synthetic-unbound', {
      mode: 0o600,
    });
    await expect(readDeviceCredentials(deviceA)).rejects.toThrow(
      'BRIDGE_CREDENTIAL_UNAVAILABLE',
    );
    expect(await readdir(root)).toEqual(['config.json.token']);
  });
  it('rejects 0644 legacy file instead of returning warning plus secret', async () => {
    await legacyToken();
    await chmod(`${configPath()}.token`, 0o644);
    await expect(readDeviceToken(deviceA)).rejects.toThrow(
      'BRIDGE_CREDENTIAL_FILE_UNSAFE',
    );
    expect((await lstat(`${configPath()}.token`)).mode & 0o777).toBe(0o644);
    expect(await readFile(`${configPath()}.token`, 'utf8')).toBe(
      'synthetic-legacy\n',
    );
  });
  it('never follows legacy symlink or changes its target', async () => {
    await existingConfig();
    const target = join(root, 'synthetic-target');
    await writeFile(target, 'synthetic-target', { mode: 0o600 });
    await symlink(target, `${configPath()}.token`);
    await expect(readDeviceToken(deviceA)).rejects.toThrow(
      'BRIDGE_CREDENTIAL_FILE_UNSAFE',
    );
    expect(await readFile(target, 'utf8')).toBe('synthetic-target');
    expect((await lstat(`${configPath()}.token`)).isSymbolicLink()).toBe(true);
  });
});

describe('fail-closed records', () => {
  it.each([
    { ...keychainRecord(), version: 2 },
    { ...keychainRecord(), deviceId: deviceB },
    { ...keychainRecord(), storage: 'unknown' },
    { ...keychainRecord(), token: 'synthetic-unwanted-copy' },
    { ...keychainRecord(), tokenSha256: undefined },
    { ...keychainRecord(), tokenSha256: 'f'.repeat(63) },
    { ...keychainRecord(), tokenSha256: 'F'.repeat(64) },
    {
      version: 1,
      deviceId: deviceA,
      storage: 'private-file',
      token: '',
      keychainUnavailableReason: 'unavailable',
    },
    {
      version: 1,
      deviceId: deviceA,
      storage: 'private-file',
      token: 'synthetic-valid',
      keychainUnavailableReason: 'unknown',
    },
  ])(
    'rejects malformed or mismatched record %# without fallback',
    async (value) => {
      await legacyToken();
      await record(value);
      ports.read.mockResolvedValue('synthetic-keychain');
      await expect(readDeviceToken(deviceA)).rejects.toThrow(
        'BRIDGE_CREDENTIAL_RECORD_INVALID',
      );
      expect(ports.read).not.toHaveBeenCalled();
    },
  );
  it('does not overwrite malformed JSON or touch Keychain first', async () => {
    await record(keychainRecord());
    await writeFile(recordPath(), '{broken', { mode: 0o600 });
    await expect(storeDeviceToken(deviceA, 'synthetic-new')).rejects.toThrow(
      'BRIDGE_CREDENTIAL_RECORD_INVALID',
    );
    expect(await readFile(recordPath(), 'utf8')).toBe('{broken');
    expect(ports.store).not.toHaveBeenCalled();
  });
  it.each(['file-mode', 'file-symlink', 'directory-mode', 'directory-symlink'])(
    'rejects unsafe %s before touching Keychain',
    async (kind) => {
      await storeDeviceToken(deviceA, 'synthetic-preserved');
      const original = await readFile(recordPath(), 'utf8');
      let target = recordPath();
      if (kind === 'file-mode') await chmod(recordPath(), 0o644);
      if (kind === 'file-symlink') {
        target = join(root, 'synthetic-record-target');
        await writeFile(target, original, { mode: 0o600 });
        await rm(recordPath());
        await symlink(target, recordPath());
      }
      if (kind === 'directory-mode') await chmod(recordDirectory(), 0o755);
      if (kind === 'directory-symlink') {
        const separate = join(root, 'synthetic-record-directory');
        await mkdir(separate, { mode: 0o700 });
        target = join(separate, `${deviceA}.json`);
        await writeFile(target, original, { mode: 0o600 });
        await rm(recordDirectory(), { recursive: true });
        await symlink(separate, recordDirectory());
      }
      ports.store.mockClear();
      await expect(
        storeDeviceToken(deviceA, 'synthetic-disallowed'),
      ).rejects.toThrow('BRIDGE_CREDENTIAL_FILE_UNSAFE');
      await expect(readDeviceToken(deviceA)).rejects.toThrow(
        'BRIDGE_CREDENTIAL_FILE_UNSAFE',
      );
      expect(ports.store).not.toHaveBeenCalled();
      expect(await readFile(target, 'utf8')).toBe(original);
    },
  );
  it.each(['', '../foreign', 'a/b', '.', 'x'.repeat(129)])(
    'rejects invalid device identifier %# before writes',
    async (id) => {
      await expect(storeDeviceToken(id, 'synthetic-token')).rejects.toThrow(
        'BRIDGE_CREDENTIAL_DEVICE_INVALID',
      );
      expect(ports.store).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
    },
  );
  it.each([
    '',
    'synthetic\nnewline',
    'synthetic token',
    'x'.repeat(8193),
    `synthetic${String.fromCharCode(0)}token`,
    `synthetic${String.fromCharCode(7)}token`,
    `synthetic${String.fromCharCode(127)}token`,
    `synthetic${String.fromCharCode(159)}token`,
  ])('rejects invalid token %# before writes', async (token) => {
    await expect(storeDeviceToken(deviceA, token)).rejects.toThrow(
      'BRIDGE_CREDENTIAL_TOKEN_INVALID',
    );
    expect(ports.store).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
});

describe('device-scoped deletion', () => {
  it('deletes only requested record/Keychain, never another device legacy file', async () => {
    await storeDeviceToken(deviceA, 'synthetic-record-a');
    await storeDeviceToken(deviceB, 'synthetic-record-b');
    await legacyToken('synthetic-legacy-a');
    await deleteDeviceToken(deviceB);
    expect(ports.remove).toHaveBeenCalledExactlyOnceWith(deviceB);
    expect(await readDeviceToken(deviceA)).toBe('synthetic-record-a');
    expect(await readFile(`${configPath()}.token`, 'utf8')).toBe(
      'synthetic-legacy-a\n',
    );
    await expect(lstat(recordPath(deviceB))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('accepts native item-not-found idempotently and deletes owned legacy/record only', async () => {
    await storeDeviceToken(deviceA, 'synthetic-new');
    await legacyToken();
    ports.remove.mockRejectedValue(
      new KeychainUnavailableError('item-not-found'),
    );
    expect(await deleteDeviceToken(deviceA)).toEqual({
      complete: true,
      keychainDeleted: true,
      localFilesDeleted: true,
    });
    await deleteDeviceToken(deviceA);
    await expect(lstat(recordPath())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(`${configPath()}.token`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(JSON.parse(await readFile(configPath(), 'utf8')).deviceId).toBe(
      deviceA,
    );
  });
  it('does not claim full cleanup when Keychain deletion is locked', async () => {
    await storeDeviceToken(deviceA, 'synthetic-new');
    await legacyToken();
    ports.remove.mockRejectedValue(unavailable());
    expect(await deleteDeviceToken(deviceA)).toEqual({
      complete: false,
      keychainDeleted: false,
      localFilesDeleted: true,
      keychainUnavailableReason: 'interaction-not-allowed',
    });
    await expect(lstat(recordPath())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(`${configPath()}.token`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('preserves unsafe legacy token and reports partial cleanup independently of safe targets', async () => {
    await storeDeviceToken(deviceA, 'synthetic-new');
    await legacyToken();
    await chmod(`${configPath()}.token`, 0o644);
    expect(await deleteDeviceToken(deviceA)).toEqual({
      complete: false,
      keychainDeleted: true,
      localFilesDeleted: false,
    });
    expect(ports.remove).toHaveBeenCalledExactlyOnceWith(deviceA);
    expect(await readFile(`${configPath()}.token`, 'utf8')).toBe(
      'synthetic-legacy\n',
    );
    await expect(lstat(recordPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('removes non-macOS private record without native calls', async () => {
    ports.platform.mockReturnValue('linux');
    await storeDeviceToken(deviceA, 'synthetic-linux');
    await deleteDeviceToken(deviceA);
    expect(ports.remove).not.toHaveBeenCalled();
    await expect(lstat(recordPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('sanitizes unknown native errors in partial-cleanup results', async () => {
    ports.remove.mockRejectedValue(Error('synthetic-secret-must-not-leak'));
    const result = await deleteDeviceToken(deviceA);
    expect(result).toEqual({
      complete: false,
      keychainDeleted: false,
      localFilesDeleted: true,
      keychainUnavailableReason: 'unavailable',
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  });
  it('reports config deletion failure honestly and treats missing config as already removed', async () => {
    expect(await deleteConfig()).toBe(true);
    await existingConfig();
    expect(await deleteConfig()).toBe(true);
    await mkdir(configPath());
    expect(await deleteConfig()).toBe(false);
    expect((await lstat(configPath())).isDirectory()).toBe(true);
  });
});
