import { basename, dirname, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { configPath, readConfig, type BridgeConfig } from './config.js';
import {
  readCredentialRecordFile,
  writeCredentialRecordFile,
} from './credential-files.js';
import { sandboxOptIn, nativeSandboxConfig } from './sandbox-settings.js';
import { LocalCommandRunner } from './local-command-runner.js';
import { LocalMcpError } from './local-mcp-protocol.js';

function scope(config: Pick<BridgeConfig, 'server' | 'deviceId'>) {
  const url = new URL(config.server);
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      config.deviceId,
    ) ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['127.0.0.1', '[::1]'].includes(url.hostname)
      )) ||
    url.username ||
    url.password
  )
    throw new LocalMcpError('LOCAL_MCP_SETTINGS_UNAVAILABLE');
  return { server: url.origin, deviceId: config.deviceId };
}
async function directory() {
  return join(
    await realpath(dirname(configPath())),
    `${basename(configPath())}.mcp-settings`,
  );
}
/** null means no local choice yet; a saved false or different pairing is
 * authoritative and cannot be bypassed by a leftover development env flag. */
export async function readLocalMcpOptIn(
  config: Pick<BridgeConfig, 'server' | 'deviceId'>,
): Promise<boolean | null> {
  try {
    const expected = scope(config),
      text = await readCredentialRecordFile(await directory(), 'opt-in.json');
    if (text === null) return null;
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      !value ||
      value.version !== 1 ||
      typeof value.enabled !== 'boolean' ||
      Object.keys(value).sort().join(',') !== 'deviceId,enabled,server,version'
    )
      throw Error();
    return (
      value.server === expected.server &&
      value.deviceId === expected.deviceId &&
      value.enabled
    );
  } catch {
    throw new LocalMcpError('LOCAL_MCP_SETTINGS_UNAVAILABLE');
  }
}
export async function saveLocalMcpOptIn(
  config: Pick<BridgeConfig, 'server' | 'deviceId'>,
  enabled: boolean,
) {
  try {
    const expected = scope(config);
    await readLocalMcpOptIn(config);
    await writeCredentialRecordFile(
      await directory(),
      'opt-in.json',
      JSON.stringify({ version: 1, ...expected, enabled }),
    );
    if ((await readLocalMcpOptIn(config)) !== enabled) throw Error();
  } catch {
    throw new LocalMcpError('LOCAL_MCP_SETTINGS_UNAVAILABLE');
  }
}
/** Checked per profile refresh and every running MCP lease. Re-pairing,
 * clearing config, disabling the sandbox, corrupt settings or local opt-out
 * all stop the old instance. Normal Finder launch requires no inherited env. */
export async function localMcpEnabledForBinding(
  config: Pick<BridgeConfig, 'server' | 'deviceId'>,
): Promise<boolean> {
  try {
    const expected = scope(config),
      current = await readConfig(),
      actual = scope(current);
    if (
      expected.deviceId !== actual.deviceId ||
      expected.server !== actual.server ||
      !(await sandboxOptIn(current))
    )
      return false;
    if (process.env.ALLRICE_LOCAL_MCP_ENABLED === '0') return false;
    const saved = await readLocalMcpOptIn(current);
    return saved === null
      ? process.env.ALLRICE_LOCAL_MCP_ENABLED === '1'
      : saved;
  } catch {
    return false;
  }
}
export async function localMcpSettingsCli(args: string[]) {
  try {
    const [action, ...extra] = args;
    if (!['status', 'enable', 'disable'].includes(action ?? '') || extra.length)
      throw new LocalMcpError('LOCAL_MCP_SETTINGS_UNAVAILABLE');
    const config = await readConfig();
    scope(config);
    if (action === 'enable') {
      if (!(await sandboxOptIn(config)))
        throw new LocalMcpError('LOCAL_MCP_SANDBOX_REQUIRED');
      await new LocalCommandRunner(nativeSandboxConfig()).preflight();
      await saveLocalMcpOptIn(config, true);
    } else if (action === 'disable') await saveLocalMcpOptIn(config, false);
    console.info(
      JSON.stringify({
        localMcpEnabled: await localMcpEnabledForBinding(config),
        sandboxEnabled: await sandboxOptIn(config),
        serverAuthorization: 'not_checked',
        note: '本机选择不等于服务端授权；启用不安装沙箱。正常重开 App 生效，云端发现和调用仍须分别审批。',
      }),
    );
  } catch (error) {
    if (error instanceof LocalMcpError) throw error;
    throw new LocalMcpError('LOCAL_MCP_SETTINGS_UNAVAILABLE');
  }
}
