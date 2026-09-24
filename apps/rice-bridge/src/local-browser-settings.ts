import { configPath, readConfig, type BridgeConfig } from './config.js';
import {
  readCredentialRecordFile,
  writeCredentialRecordFile,
} from './credential-files.js';

/** Pairing enables available capabilities; an explicit local pause survives upgrades. */
export async function localBrowserOptIn(
  config: BridgeConfig,
): Promise<boolean> {
  try {
    const text = await readCredentialRecordFile(
      `${configPath()}.browser-settings`,
      'opt-in.json',
    );
    if (text === null) return true;
    const value = JSON.parse(text);
    if (
      !value ||
      value.version !== 1 ||
      typeof value.enabled !== 'boolean' ||
      typeof value.deviceId !== 'string' ||
      typeof value.server !== 'string' ||
      Object.keys(value).some(
        (key) => !['version', 'enabled', 'deviceId', 'server'].includes(key),
      )
    )
      throw Error();
    return (
      value.enabled &&
      value.deviceId === config.deviceId &&
      value.server === config.server
    );
  } catch {
    throw Error('LOCAL_BROWSER_SETTINGS_UNSAFE');
  }
}
export async function saveLocalBrowserOptIn(
  config: BridgeConfig,
  enabled: boolean,
) {
  await localBrowserOptIn(config);
  await writeCredentialRecordFile(
    `${configPath()}.browser-settings`,
    'opt-in.json',
    JSON.stringify({
      version: 1,
      enabled,
      deviceId: config.deviceId,
      server: config.server,
    }),
  );
}
export async function localBrowserCli(args: string[]) {
  const operation = args[0] ?? 'status';
  if (args.length > 1 || !['status', 'enable', 'disable'].includes(operation))
    throw Error('browser status|enable|disable');
  const config = await readConfig();
  if (operation === 'enable') {
    // Preflight an existing fixed engine; never install Chrome, open a browser,
    // pair a device or change macOS permissions as a side effect of this choice.
    await (
      await import('./local-browser-driver.js')
    ).resolveLocalBrowserExecutable();
    await (
      await import('./local-browser-supervisor.js')
    ).resolveLocalBrowserLauncher();
    await saveLocalBrowserOptIn(config, true);
  } else if (operation === 'disable')
    await saveLocalBrowserOptIn(config, false);
  const enabled = await localBrowserOptIn(config);
  console.info(
    JSON.stringify({
      enabled,
      isolation: 'native-chromium-sandbox',
      personalChrome: false,
      loginStorage: 'private-unencrypted-opt-in',
      requiresManualServerGrant: false,
    }),
  );
}
