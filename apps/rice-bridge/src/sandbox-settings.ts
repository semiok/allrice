import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { localCommandToolchainForPlatform } from '@allrice/contracts';
import { configPath, type BridgeConfig } from './config.js';

// Pairing enables preparation; saved pauses remain bound to their device/server.
export async function sandboxOptIn(config: BridgeConfig) {
  const path = `${configPath()}.sandbox.json`;
  try {
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 4096 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      throw Error('UNSAFE_SANDBOX_SETTINGS');
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (
      !value ||
      value.version !== 1 ||
      typeof value.enabled !== 'boolean' ||
      typeof value.deviceId !== 'string' ||
      typeof value.server !== 'string'
    )
      throw Error('INVALID_SANDBOX_SETTINGS');
    return (
      value.version === 1 &&
      value.enabled === true &&
      value.deviceId === config.deviceId &&
      value.server === config.server
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw Error('INVALID_SANDBOX_SETTINGS');
  }
}

export async function saveSandboxOptIn(config: BridgeConfig, enabled: boolean) {
  const path = `${configPath()}.sandbox.json`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Validate existing settings rather than overwriting an unsafe target.
  await sandboxOptIn(config);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({
      version: 1,
      enabled,
      deviceId: config.deviceId,
      server: config.server,
    }) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  await rename(temporary, path);
}

export function nativeSandboxConfig() {
  const toolchain = localCommandToolchainForPlatform(
    process.platform === 'darwin' ? `macos-${process.arch}` : process.platform,
  );
  if (!toolchain) throw Error('UNSUPPORTED_NATIVE_PLATFORM');
  return {
    socketPath: join(homedir(), '.colima/allrice-b2/docker.sock'),
    imageDigest: toolchain.imageDigest,
  };
}
