import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const keychainService = 'ai.traditionow.allrice.rice-bridge';

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

async function writeFallbackToken(token: string) {
  const path = fallbackTokenPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, token, { mode: 0o600 });
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
  await unlink(configPath()).catch(() => undefined);
}

export async function storeDeviceToken(deviceId: string, token: string) {
  if (platform() === 'darwin') {
    try {
      await execFileAsync('/usr/bin/security', [
        'add-generic-password',
        '-U',
        '-s',
        keychainService,
        '-a',
        deviceId,
        '-w',
        token,
      ]);
      return;
    } catch {
      // A locked Keychain or a non-interactive launch context must not leave
      // a consumed pairing code without durable local credentials.
    }
  }
  await writeFallbackToken(token);
}

export interface DeviceCredentials {
  token: string;
  storage: 'environment' | 'keychain' | 'private-file';
  privateFileSecure?: boolean;
}

/** Read-only source metadata; does not migrate credentials or unlock Keychain. */
export async function readDeviceCredentials(
  deviceId: string,
): Promise<DeviceCredentials> {
  const environmentToken = process.env.ALLRICE_BRIDGE_DEVICE_TOKEN;
  if (environmentToken)
    return { token: environmentToken, storage: 'environment' };
  if (platform() === 'darwin') {
    try {
      const result = await execFileAsync('/usr/bin/security', [
        'find-generic-password',
        '-s',
        keychainService,
        '-a',
        deviceId,
        '-w',
      ]);
      return { token: result.stdout.trim(), storage: 'keychain' };
    } catch {
      // Fall through to the private local token written when Keychain access
      // was unavailable during first launch.
    }
  }
  const token = (await readFile(fallbackTokenPath(), 'utf8')).trim();
  const metadata = await lstat(fallbackTokenPath()).catch(() => null);
  return {
    token,
    storage: 'private-file',
    privateFileSecure: Boolean(
      metadata?.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.uid === process.getuid?.() &&
      (metadata.mode & 0o777) === 0o600,
    ),
  };
}

export async function readDeviceToken(deviceId: string) {
  return (await readDeviceCredentials(deviceId)).token;
}

export async function deleteDeviceToken(deviceId: string) {
  if (platform() === 'darwin') {
    await execFileAsync('/usr/bin/security', [
      'delete-generic-password',
      '-s',
      keychainService,
      '-a',
      deviceId,
    ]).catch(() => undefined);
  }
  await unlink(fallbackTokenPath()).catch(() => undefined);
}
