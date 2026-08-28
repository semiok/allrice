import { execFile } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
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

export async function readConfig() {
  return JSON.parse(await readFile(configPath(), 'utf8')) as BridgeConfig;
}

export async function writeConfig(config: BridgeConfig) {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function storeDeviceToken(deviceId: string, token: string) {
  if (platform() === 'darwin') {
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
  }
  await writeFile(fallbackTokenPath(), token, { mode: 0o600 });
}

export async function readDeviceToken(deviceId: string) {
  const environmentToken = process.env.ALLRICE_BRIDGE_DEVICE_TOKEN;
  if (environmentToken) return environmentToken;
  if (platform() === 'darwin') {
    const result = await execFileAsync('/usr/bin/security', [
      'find-generic-password',
      '-s',
      keychainService,
      '-a',
      deviceId,
      '-w',
    ]);
    return result.stdout.trim();
  }
  return (await readFile(fallbackTokenPath(), 'utf8')).trim();
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
    return;
  }
  await unlink(fallbackTokenPath()).catch(() => undefined);
}
