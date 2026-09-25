import {
  BridgeSettingsCommandSchema,
  type BridgeSettingsCommand,
  type BridgeSettings,
} from '@allrice/contracts';
import { configPath, type BridgeConfig } from './config.js';
import {
  readCredentialRecordFile,
  writeCredentialRecordFile,
} from './credential-files.js';
import {
  localBrowserOptIn,
  saveLocalBrowserOptIn,
} from './local-browser-settings.js';
import { sandboxOptIn, saveSandboxOptIn } from './sandbox-settings.js';

async function recorded(config: BridgeConfig) {
  const text = await readCredentialRecordFile(
    `${configPath()}.capability-settings`,
    'settings.json',
  );
  if (text === null) return null;
  const value = JSON.parse(text);
  if (value.deviceId !== config.deviceId || value.server !== config.server)
    return null;
  return BridgeSettingsCommandSchema.parse(value.command);
}

export async function localCapabilitySettings(
  config: BridgeConfig,
): Promise<{ revision: number; settings: BridgeSettings }> {
  const saved = await recorded(config);
  return {
    revision: saved?.revision ?? 0,
    settings: {
      localBrowser: await localBrowserOptIn(config),
      localCommand: await sandboxOptIn(config),
      development: saved?.settings.development ?? true,
    },
  };
}

/** Called only after the current runtime has released its work. The revision
 * is acknowledged last, so interrupted application is retried on reconnect. */
export async function applyCapabilitySettings(
  config: BridgeConfig,
  input: BridgeSettingsCommand,
) {
  const command = BridgeSettingsCommandSchema.parse(input);
  const old = await recorded(config);
  if (old && old.revision >= command.revision) return;
  await saveLocalBrowserOptIn(config, command.settings.localBrowser);
  await saveSandboxOptIn(config, command.settings.localCommand);
  await writeCredentialRecordFile(
    `${configPath()}.capability-settings`,
    'settings.json',
    JSON.stringify({
      deviceId: config.deviceId,
      server: config.server,
      command,
    }),
  );
}
