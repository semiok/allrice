#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { arch, hostname, platform } from 'node:os';
import { basename } from 'node:path';
import { promisify } from 'node:util';

import {
  BridgeCapabilities,
  BridgeProtocolVersion,
  BridgeCommandSchema,
  BridgeWorkspaceSelectionRequestSchema,
  PairBridgeDeviceResponseSchema,
  type BridgeCommand,
  type BridgeDevice,
  type BridgeFolderGrant,
  type BridgeWorkspaceSelectionRequest,
} from '@allrice/contracts';

import { bridgeRequest } from './client.js';
import { BridgeDualTransport } from './dual-transport.js';
import {
  deleteConfig,
  deleteDeviceToken,
  configPath,
  readConfig,
  readDeviceToken,
  storeDeviceToken,
  writeConfig,
  type BridgeConfig,
} from './config.js';
import { LocalExecutionError, executeLocalCommand } from './executor.js';

const execFileAsync = promisify(execFile);
const defaultBridgeServer =
  process.env.ALLRICE_BRIDGE_DEFAULT_SERVER ?? 'https://allrice-dsh.bplabs.xyz';

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function normalizedServer(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Bridge server must use HTTP or HTTPS');
  }
  return `${url.origin}/`;
}

function normalizedPairingCode(value: string) {
  const compact = value.trim().replaceAll('-', '').toUpperCase();
  if (!/^[A-F0-9]{8}$/.test(compact)) {
    throw new Error('配对码格式不正确，请输入网页显示的 8 位配对码');
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

async function credentials(config: BridgeConfig) {
  return {
    config,
    token: await readDeviceToken(config.deviceId),
  };
}

async function pair(args: string[]) {
  const currentArch = arch();
  if (
    platform() !== 'darwin' ||
    (currentArch !== 'arm64' && currentArch !== 'x64')
  ) {
    throw new Error(
      'Rice Bridge supports Apple Silicon and Intel 64-bit macOS only',
    );
  }
  const serverInput = option(args, '--server');
  if (!serverInput) throw new Error('pair requires --server https://...');
  const server = normalizedServer(serverInput);
  const codeInput = option(args, '--code');
  const code = codeInput ? normalizedPairingCode(codeInput) : undefined;
  if (!code) throw new Error('pair requires --code XXXX-XXXX');
  const name = option(args, '--name') ?? `${hostname()} · Rice Bridge`;
  const response = PairBridgeDeviceResponseSchema.parse(
    await bridgeRequest({
      server,
      path: '/api/v1/bridge/device/pair',
      method: 'POST',
      body: {
        code,
        name,
        platform: currentArch === 'arm64' ? 'macos-arm64' : 'macos-x64',
        protocolVersion: BridgeProtocolVersion,
        capabilities: BridgeCapabilities,
      },
    }),
  );
  await storeDeviceToken(response.device.id, response.deviceToken);
  await writeConfig({
    server,
    deviceId: response.device.id,
    deviceName: response.device.name,
    grants: [],
  });
  console.info(`Rice Bridge 已连接：${response.device.name}`);
}

async function createFolderGrant(path: string, name?: string) {
  const rootPath = await realpath(path);
  const label = name ?? basename(rootPath);
  const rootFingerprint = createHash('sha256').update(rootPath).digest('hex');
  const { config, token } = await credentials(await readConfig());
  const response = await bridgeRequest<{ grant: BridgeFolderGrant }>({
    server: config.server,
    path: '/api/v1/bridge/device/grants',
    method: 'POST',
    token,
    body: { label, rootFingerprint },
  });
  const next: BridgeConfig = {
    ...config,
    grants: [
      ...config.grants.filter(
        (candidate) => candidate.id !== response.grant.id,
      ),
      { ...response.grant, rootPath },
    ],
  };
  await writeConfig(next);
  console.info(`已授权文件夹：${label}`);
  return response.grant;
}

async function grant(args: string[]) {
  const path = args[0];
  if (!path) throw new Error('grant requires a folder path');
  await createFolderGrant(path, option(args, '--name'));
}

async function status() {
  const { config, token } = await credentials(await readConfig());
  const response = await bridgeRequest<{
    device: BridgeDevice;
    grants: BridgeFolderGrant[];
  }>({
    server: config.server,
    path: '/api/v1/bridge/device/status',
    token,
  });
  console.info(JSON.stringify(response, null, 2));
}

async function complete(
  config: BridgeConfig,
  token: string,
  command: BridgeCommand,
) {
  const grant = config.grants.find(
    (candidate) => candidate.id === command.folderGrantId,
  );
  if (!grant) {
    throw new LocalExecutionError(
      'GRANT_NOT_FOUND',
      'The command references a folder that is not authorized on this Mac',
    );
  }
  try {
    const result = await executeLocalCommand(grant.rootPath, command.payload);
    await bridgeRequest({
      server: config.server,
      path: `/api/v1/bridge/device/commands/${command.id}/complete`,
      method: 'POST',
      token,
      body: {
        leaseToken: command.leaseToken,
        status: 'succeeded',
        output: result.output,
        summary: result.summary,
      },
    });
  } catch (error) {
    const code =
      error instanceof LocalExecutionError
        ? error.code
        : 'LOCAL_EXECUTION_FAILED';
    await bridgeRequest({
      server: config.server,
      path: `/api/v1/bridge/device/commands/${command.id}/complete`,
      method: 'POST',
      token,
      body: {
        leaseToken: command.leaseToken,
        status: 'failed',
        summary: error instanceof Error ? error.message.slice(0, 500) : code,
        errorCode: code,
      },
    });
  }
}

async function chooseWorkspaceFolder() {
  if (platform() !== 'darwin') {
    throw new Error('Native workspace selection requires macOS');
  }
  const result = await execFileAsync('/usr/bin/osascript', [
    '-e',
    'POSIX path of (choose folder with prompt "选择 Rice 的本地工作区")',
  ]);
  return result.stdout.trim();
}

async function completeWorkspaceSelection(
  config: BridgeConfig,
  token: string,
  request: BridgeWorkspaceSelectionRequest,
) {
  try {
    const rootPath = await chooseWorkspaceFolder();
    const grant = await createFolderGrant(rootPath);
    await bridgeRequest({
      server: config.server,
      path: `/api/v1/bridge/device/workspace-selections/${request.id}/complete`,
      method: 'POST',
      token,
      body: {
        leaseToken: request.leaseToken,
        status: 'succeeded',
        grantId: grant.id,
      },
    });
    console.info(`✓ 本地工作区已切换为：${grant.label}`);
  } catch {
    await bridgeRequest({
      server: config.server,
      path: `/api/v1/bridge/device/workspace-selections/${request.id}/complete`,
      method: 'POST',
      token,
      body: {
        leaseToken: request.leaseToken,
        status: 'failed',
        errorCode: 'NATIVE_PICKER_CANCELED',
      },
    }).catch(() => undefined);
    console.info('未选择新的本地工作区。');
  }
}

async function start() {
  let { config, token } = await credentials(await readConfig());
  const operationLedgerEnabled =
    process.env.ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED === '1';
  const operationModule = operationLedgerEnabled
    ? await import('./operation-client.js')
    : null;
  let transport: BridgeDualTransport | null = null;
  let transportIdentity = '';
  const currentTransport = () => {
    if (
      !operationLedgerEnabled ||
      process.env.ALLRICE_BRIDGE_WSS_ENABLED !== '1'
    )
      return null;
    // Credential/config changes close the old connection instead of borrowing it
    // across devices or tenants. The identity string is never logged/persisted.
    const identity = JSON.stringify([config.server, config.deviceId, token]);
    if (identity !== transportIdentity) {
      transport?.close();
      transport = new BridgeDualTransport({
        server: config.server,
        deviceId: config.deviceId,
        token,
      });
      transportIdentity = identity;
    }
    return transport;
  };
  const journal = operationLedgerEnabled
    ? await (
        await import('./journal.js')
      ).BridgeJournal.open({
        directory: `${configPath()}.operation-journal`,
        server: config.server,
        deviceId: config.deviceId,
      })
    : null;
  let stopping = false;
  const commandAbort = new AbortController();
  const runner =
    operationLedgerEnabled &&
    process.env.ALLRICE_LOCAL_COMMAND_ENABLED === '1' &&
    process.platform === 'darwin' &&
    process.arch === 'x64' &&
    process.env.ALLRICE_LOCAL_DOCKER_SOCKET &&
    process.env.ALLRICE_LOCAL_COMMAND_IMAGE
      ? new (await import('./local-command-runner.js')).LocalCommandRunner({
          socketPath: process.env.ALLRICE_LOCAL_DOCKER_SOCKET,
          imageDigest: process.env.ALLRICE_LOCAL_COMMAND_IMAGE,
        })
      : undefined;
  let runnerAvailable = false;
  process.once('SIGINT', () => {
    stopping = true;
    commandAbort.abort();
  });
  process.once('SIGTERM', () => {
    stopping = true;
    commandAbort.abort();
  });
  console.info(`Rice Bridge 正在运行：${config.deviceName}`);
  let lastHeartbeatAt = 0;
  let heartbeatInFlight: Promise<void> | null = null;
  const heartbeat = () => {
    heartbeatInFlight ??= (async () => {
      await bridgeRequest({
        server: config.server,
        path: '/api/v1/bridge/device/heartbeat',
        method: 'POST',
        token,
        body: {
          protocolVersion: BridgeProtocolVersion,
          capabilities: BridgeCapabilities,
        },
        timeoutMs: 5000,
      });
      lastHeartbeatAt = Date.now();
      if (runner) {
        runnerAvailable = false;
        try {
          const profile = await runner.preflight();
          await bridgeRequest({
            server: config.server,
            path: '/api/v1/bridge/device/runtime-profile',
            method: 'POST',
            token,
            body: { contractVersion: 1, ...profile, available: true },
            maximumResponseBytes: 4096,
            timeoutMs: 5000,
          });
          runnerAvailable = true;
        } catch {
          /* Existing filesystem capabilities stay available; no implicit execution fallback. */
        }
      }
    })().finally(() => {
      heartbeatInFlight = null;
    });
    return heartbeatInFlight;
  };
  // Long commands must not make the device look offline. Operation permission
  // renewal is a separate, shorter loop inside the supervised runner.
  const heartbeatTimer = setInterval(() => {
    if (!stopping)
      void heartbeat().catch(() => {
        runnerAvailable = false;
      });
  }, 20_000);
  let reconnectDelayMs = 1_000;
  try {
    while (!stopping) {
      try {
        if (Date.now() - lastHeartbeatAt >= 30_000) {
          await heartbeat();
        }
        const selection = await bridgeRequest<{ request: unknown }>({
          server: config.server,
          path: '/api/v1/bridge/device/workspace-selections/next',
          method: 'POST',
          token,
        });
        if (selection.request) {
          await completeWorkspaceSelection(
            config,
            token,
            BridgeWorkspaceSelectionRequestSchema.parse(selection.request),
          );
          ({ config, token } = await credentials(await readConfig()));
          reconnectDelayMs = 1_000;
          continue;
        }
        if (operationModule && journal) {
          ({ config, token } = await credentials(await readConfig()));
          const worked = await new operationModule.RuntimeBridgeOperationClient(
            {
              config,
              token,
              journal,
              runner: runnerAvailable ? runner : undefined,
              signal: commandAbort.signal,
              request: currentTransport()?.request,
            },
          ).pollOnce();
          reconnectDelayMs = 1_000;
          if (worked) continue;
          // Existing file/git tools still use the legacy queue in P05. Keep
          // draining it when the opt-in operation queue is idle; the legacy
          // schema can never authorize the new process capability.
        }
        const response = await bridgeRequest<{ command: unknown }>({
          server: config.server,
          path: '/api/v1/bridge/device/commands/next',
          method: 'POST',
          token,
        });
        if (response.command) {
          // A folder granted from another terminal should become available
          // without requiring the long-running Bridge process to restart.
          ({ config, token } = await credentials(await readConfig()));
          await complete(
            config,
            token,
            BridgeCommandSchema.parse(response.command),
          );
        } else {
          const channel = currentTransport();
          if (channel) await channel.waitForWork(750);
          else await new Promise((resolve) => setTimeout(resolve, 750));
        }
        reconnectDelayMs = 1_000;
      } catch (error) {
        if (stopping) break;
        console.error(
          `Bridge 暂时断开，${Math.ceil(reconnectDelayMs / 1_000)} 秒后重试：${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
        await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs));
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
        lastHeartbeatAt = 0;
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
    transport?.close();
    await (heartbeatInFlight as Promise<void> | null)?.catch(() => undefined);
    if (journal)
      await (
        await import('./local-process-manager.js')
      ).stopLocalProcesses(journal);
    await journal?.close();
  }
  console.info('Rice Bridge 已停止');
}

async function hasStoredPairing() {
  try {
    const config = await readConfig();
    await readDeviceToken(config.deviceId);
    return true;
  } catch {
    return false;
  }
}

async function promptPairingCode(message: string) {
  if (platform() !== 'darwin') {
    throw new Error('Rice Bridge 首次配对仅支持 macOS');
  }
  try {
    const result = await execFileAsync('/usr/bin/osascript', [
      '-e',
      'on run argv',
      '-e',
      'set dialogResult to display dialog (item 1 of argv) default answer "" with title "Rice Bridge 首次配对" buttons {"取消", "配对并启动"} default button "配对并启动" cancel button "取消"',
      '-e',
      'return text returned of dialogResult',
      '-e',
      'end run',
      message,
    ]);
    return result.stdout.trim();
  } catch {
    return null;
  }
}

async function launch() {
  if (!(await hasStoredPairing())) {
    let message =
      '这是第一次打开 Rice Bridge。\n\n请在 AllRice 页面生成配对码，并在下方输入。配对成功后，本机会安全保存授权，以后直接打开即可自动连接。';
    while (true) {
      const input = await promptPairingCode(message);
      if (input === null) {
        console.info('已取消 Rice Bridge 配对');
        return;
      }
      try {
        const code = normalizedPairingCode(input);
        await pair(['--server', defaultBridgeServer, '--code', code]);
        break;
      } catch (error) {
        message = `配对失败：${
          error instanceof Error ? error.message : '未知错误'
        }\n\n请确认配对码仍在 10 分钟有效期内，然后重新输入。`;
      }
    }
  }
  await start();
}

async function revoke() {
  const { config, token } = await credentials(await readConfig());
  await bridgeRequest({
    server: config.server,
    path: '/api/v1/bridge/device/revoke',
    method: 'POST',
    token,
  });
  await deleteDeviceToken(config.deviceId);
  await deleteConfig();
  console.info('Rice Bridge 设备授权已撤销');
}

function help() {
  console.info(
    `Rice Bridge v0.2\n\n直接打开 RiceBridge：首次输入配对码，之后自动连接。\n\nCommands:\n  pair --server URL --code XXXX-XXXX [--name NAME]\n  grant PATH [--name NAME]\n  start\n  status\n  revoke`,
  );
}

async function main() {
  const [requestedCommand, ...args] = process.argv.slice(2);
  const command = requestedCommand ?? 'launch';
  if (command === 'launch') await launch();
  else if (command === 'pair') await pair(args);
  else if (command === 'grant') await grant(args);
  else if (command === 'start') await start();
  else if (command === 'status') await status();
  else if (command === 'revoke') await revoke();
  else help();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
