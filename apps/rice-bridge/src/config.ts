import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import {
  deleteCredentialRecordFile,
  deletePrivateCredentialFile,
  prepareCredentialDirectory,
  readCredentialRecordFile,
  readPrivateCredentialFile,
  writeCredentialRecordFile,
} from './credential-files.js';
import {
  deleteKeychainToken,
  KeychainUnavailableError,
  readKeychainToken,
  storeKeychainToken,
  type KeychainUnavailableReason,
} from './keychain.js';

export interface LocalGrant {
  id: string;
  label: string;
  rootPath: string;
  rootFingerprint: string;
}

export interface BridgeConfig {
  server: string;
  deviceId: string;
  deviceName: string;
  grants: LocalGrant[];
  /** New pairings get an independent journal; existing configs keep their path. */
  journalNamespace?: string;
}

export function configPath() {
  return (
    process.env.ALLRICE_BRIDGE_CONFIG_PATH ??
    join(
      homedir(),
      'Library',
      'Application Support',
      'Rice Bridge',
      'config.json',
    )
  );
}

function fallbackTokenPath() {
  return `${configPath()}.token`;
}

function credentialDirectory() {
  return `${configPath()}.credentials`;
}

function credentialFilename(deviceId: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) {
    throw Error('BRIDGE_CREDENTIAL_DEVICE_INVALID');
  }
  return `${deviceId}.json`;
}

type CredentialRecord =
  | { version: 1; deviceId: string; storage: 'keychain'; tokenSha256: string }
  | {
      version: 1;
      deviceId: string;
      storage: 'private-file';
      token: string;
      keychainUnavailableReason: KeychainUnavailableReason;
    };

function validToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 8192 &&
    !/\s/.test(value) &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    })
  );
}

function validReason(value: unknown): value is KeychainUnavailableReason {
  return (
    value === 'interaction-not-allowed' ||
    value === 'item-not-found' ||
    value === 'timed-out' ||
    value === 'unavailable'
  );
}

async function readCredentialRecord(deviceId: string) {
  const content = await readCredentialRecordFile(
    credentialDirectory(),
    credentialFilename(deviceId),
  );
  if (content === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw Error('BRIDGE_CREDENTIAL_RECORD_INVALID');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Error('BRIDGE_CREDENTIAL_RECORD_INVALID');
  }
  const record = value as Record<string, unknown>;
  const allowed =
    record.storage === 'keychain'
      ? ['version', 'deviceId', 'storage', 'tokenSha256']
      : [
          'version',
          'deviceId',
          'storage',
          'token',
          'keychainUnavailableReason',
        ];
  if (
    record.version !== 1 ||
    record.deviceId !== deviceId ||
    Object.keys(record).some((key) => !allowed.includes(key)) ||
    !(
      (record.storage === 'keychain' &&
        typeof record.tokenSha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(record.tokenSha256)) ||
      (record.storage === 'private-file' &&
        validToken(record.token) &&
        validReason(record.keychainUnavailableReason))
    )
  ) {
    throw Error('BRIDGE_CREDENTIAL_RECORD_INVALID');
  }
  return record as CredentialRecord;
}

// Legacy token files have no device binding of their own. Only the actual
// persisted config can establish the old file's owner, never a static override.
async function legacyTokenBelongsTo(deviceId: string) {
  let content: string;
  try {
    content = await readFile(configPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw Error('BRIDGE_CREDENTIAL_CONFIG_UNAVAILABLE');
  }
  try {
    const config: unknown = JSON.parse(content);
    return (
      config !== null &&
      typeof config === 'object' &&
      !Array.isArray(config) &&
      'deviceId' in config &&
      config.deviceId === deviceId
    );
  } catch {
    throw Error('BRIDGE_CREDENTIAL_CONFIG_UNAVAILABLE');
  }
}

export async function readConfig() {
  const staticDeviceId = process.env.ALLRICE_BRIDGE_STATIC_DEVICE_ID;
  if (staticDeviceId) {
    const existing = await readFile(configPath(), 'utf8')
      .then((value) => JSON.parse(value) as BridgeConfig)
      .catch(() => null);
    return {
      server: process.env.ALLRICE_BRIDGE_STATIC_SERVER ?? '',
      deviceId: staticDeviceId,
      deviceName:
        process.env.ALLRICE_BRIDGE_STATIC_DEVICE_NAME ?? 'Rice Bridge Static',
      grants: existing?.deviceId === staticDeviceId ? existing.grants : [],
    };
  }
  return JSON.parse(await readFile(configPath(), 'utf8')) as BridgeConfig;
}

export async function writeConfig(config: BridgeConfig) {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function deleteConfig() {
  try {
    await unlink(configPath());
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export async function storeDeviceToken(deviceId: string, token: string) {
  const filename = credentialFilename(deviceId);
  if (!validToken(token)) throw Error('BRIDGE_CREDENTIAL_TOKEN_INVALID');
  const existing = await readCredentialRecord(deviceId);
  if (existing) {
    const sameToken =
      existing.storage === 'private-file'
        ? existing.token === token
        : existing.tokenSha256 ===
          createHash('sha256').update(token).digest('hex');
    if (!sameToken)
      throw Error('BRIDGE_CREDENTIAL_REPLACEMENT_REQUIRES_PAIRING');
    // Pairing creates a fresh device ID. This API does not implicitly rotate
    // or migrate an existing device between the two credential stores.
    return;
  }
  if (await legacyTokenBelongsTo(deviceId)) {
    throw Error('BRIDGE_CREDENTIAL_LEGACY_REPLACEMENT_REQUIRES_PAIRING');
  }
  await mkdir(dirname(configPath()), { recursive: true, mode: 0o700 });
  await prepareCredentialDirectory(credentialDirectory());
  // Reject unsafe/corrupt existing records before touching another credential
  // store. No automatic migration or repair of legacy files happens here.
  await readCredentialRecord(deviceId);
  let record: CredentialRecord;
  if (platform() === 'darwin') {
    try {
      await storeKeychainToken(deviceId, token);
      record = {
        version: 1,
        deviceId,
        storage: 'keychain',
        tokenSha256: createHash('sha256').update(token).digest('hex'),
      };
    } catch (error) {
      if (!(error instanceof KeychainUnavailableError)) throw error;
      record = {
        version: 1,
        deviceId,
        storage: 'private-file',
        token,
        keychainUnavailableReason: error.reason,
      };
    }
  } else {
    record = {
      version: 1,
      deviceId,
      storage: 'private-file',
      token,
      keychainUnavailableReason: 'unavailable',
    };
  }
  await writeCredentialRecordFile(
    credentialDirectory(),
    filename,
    `${JSON.stringify(record)}\n`,
  );
}

export interface DeviceCredentials {
  token: string;
  storage: 'environment' | 'keychain' | 'private-file';
  privateFileSecure?: boolean;
  keychainUnavailableReason?: KeychainUnavailableReason;
}

/** Read-only source metadata; does not migrate credentials or unlock Keychain. */
export async function readDeviceCredentials(
  deviceId: string,
): Promise<DeviceCredentials> {
  const environmentToken = process.env.ALLRICE_BRIDGE_DEVICE_TOKEN;
  if (environmentToken)
    return { token: environmentToken, storage: 'environment' };
  const record = await readCredentialRecord(deviceId);
  if (record?.storage === 'private-file') {
    return {
      token: record.token,
      storage: 'private-file',
      privateFileSecure: true,
      keychainUnavailableReason: record.keychainUnavailableReason,
    };
  }
  if (record?.storage === 'keychain') {
    if (platform() !== 'darwin')
      throw new KeychainUnavailableError('unavailable');
    // The committed source is authoritative. Never revive a stale legacy token
    // just because the Keychain is currently locked or unavailable.
    const token = await readKeychainToken(deviceId);
    if (
      createHash('sha256').update(token).digest('hex') !== record.tokenSha256
    ) {
      throw Error('BRIDGE_CREDENTIAL_KEYCHAIN_MISMATCH');
    }
    return { token, storage: 'keychain' };
  }
  let keychainUnavailableReason: KeychainUnavailableReason | undefined;
  if (platform() === 'darwin') {
    try {
      return { token: await readKeychainToken(deviceId), storage: 'keychain' };
    } catch (error) {
      if (!(error instanceof KeychainUnavailableError)) throw error;
      keychainUnavailableReason = error.reason;
    }
  }
  if (!(await legacyTokenBelongsTo(deviceId))) {
    throw Error('BRIDGE_CREDENTIAL_UNAVAILABLE');
  }
  const token = (await readPrivateCredentialFile(fallbackTokenPath()))?.trim();
  if (!validToken(token)) throw Error('BRIDGE_CREDENTIAL_UNAVAILABLE');
  return {
    token,
    storage: 'private-file',
    privateFileSecure: true,
    ...(keychainUnavailableReason ? { keychainUnavailableReason } : {}),
  };
}

export async function readDeviceToken(deviceId: string) {
  return (await readDeviceCredentials(deviceId)).token;
}

export interface DeviceCredentialCleanup {
  complete: boolean;
  keychainDeleted: boolean;
  localFilesDeleted: boolean;
  keychainUnavailableReason?: KeychainUnavailableReason;
}

export async function deleteDeviceToken(
  deviceId: string,
): Promise<DeviceCredentialCleanup> {
  const filename = credentialFilename(deviceId);
  let keychainDeleted = true;
  let localFilesDeleted = true;
  let keychainUnavailableReason: KeychainUnavailableReason | undefined;
  if (platform() === 'darwin') {
    try {
      await deleteKeychainToken(deviceId);
    } catch (error) {
      if (
        !(error instanceof KeychainUnavailableError) ||
        error.reason !== 'item-not-found'
      ) {
        keychainDeleted = false;
        keychainUnavailableReason =
          error instanceof KeychainUnavailableError
            ? error.reason
            : 'unavailable';
      }
    }
  }
  // Each exact target is cleaned independently. Unsafe paths are retained, and
  // an already completed server revocation must not be reported as a total
  // failure just because local Keychain cleanup requires later user action.
  try {
    await deleteCredentialRecordFile(credentialDirectory(), filename);
  } catch {
    localFilesDeleted = false;
  }
  try {
    if (await legacyTokenBelongsTo(deviceId)) {
      await deletePrivateCredentialFile(fallbackTokenPath());
    }
  } catch {
    localFilesDeleted = false;
  }
  return {
    complete: keychainDeleted && localFilesDeleted,
    keychainDeleted,
    localFilesDeleted,
    ...(keychainUnavailableReason ? { keychainUnavailableReason } : {}),
  };
}
