import { configPath, type BridgeConfig } from './config.js';
import {
  readCredentialRecordFile,
  writeCredentialRecordFile,
} from './credential-files.js';

/** Separate local consent: neither enabling Chrome nor enabling the VM grants preview access. */
export async function localPreviewOptIn(
  config: BridgeConfig,
): Promise<boolean> {
  try {
    const text = await readCredentialRecordFile(
      `${configPath()}.preview-settings`,
      'opt-in.json',
    );
    if (text === null) return false;
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw Error();
    const data = value as Record<string, unknown>;
    if (
      data.version !== 1 ||
      typeof data.enabled !== 'boolean' ||
      typeof data.deviceId !== 'string' ||
      typeof data.server !== 'string' ||
      Object.keys(data).some(
        (key) => !['version', 'enabled', 'deviceId', 'server'].includes(key),
      )
    )
      throw Error();
    return (
      data.enabled &&
      data.deviceId === config.deviceId &&
      data.server === config.server
    );
  } catch {
    throw Error('LOCAL_PREVIEW_SETTINGS_UNSAFE');
  }
}

export async function saveLocalPreviewOptIn(
  config: BridgeConfig,
  enabled: boolean,
) {
  await localPreviewOptIn(config);
  await writeCredentialRecordFile(
    `${configPath()}.preview-settings`,
    'opt-in.json',
    JSON.stringify({
      version: 1,
      enabled,
      deviceId: config.deviceId,
      server: config.server,
    }),
  );
}
