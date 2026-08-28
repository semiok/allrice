#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { arch, hostname, platform } from 'node:os';
import { basename } from 'node:path';

import {
  BridgeCapabilities,
  BridgeCommandSchema,
  PairBridgeDeviceResponseSchema,
  type BridgeCommand,
  type BridgeDevice,
  type BridgeFolderGrant,
} from '@allrice/contracts';

import { bridgeRequest } from './client.js';
import {
  deleteDeviceToken,
  readConfig,
  readDeviceToken,
  storeDeviceToken,
  writeConfig,
  type BridgeConfig,
} from './config.js';
import { LocalExecutionError, executeLocalCommand } from './executor.js';

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

async function credentials(config: BridgeConfig) {
  return {
    config,
    token: await readDeviceToken(config.deviceId),
  };
}

async function pair(args: string[]) {
  if (platform() !== 'darwin' || arch() !== 'arm64') {
    throw new Error('Rice Bridge v0.1 supports Apple Silicon macOS only');
  }
  const server = normalizedServer(
    option(args, '--server') ?? 'https://allrice-snow.bplabs.xyz',
  );
  const code = option(args, '--code');
  if (!code) throw new Error('pair requires --code XXXX-XXXX');
  const name = option(args, '--name') ?? `${hostname()} · Snow Mac`;
  const response = PairBridgeDeviceResponseSchema.parse(
    await bridgeRequest({
      server,
      path: '/api/v1/bridge/device/pair',
      method: 'POST',
      body: {
        code,
        name,
        platform: 'macos-arm64',
        protocolVersion: 1,
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

async function grant(args: string[]) {
  const path = args[0];
  if (!path) throw new Error('grant requires a folder path');
  const rootPath = await realpath(path);
  const label = option(args, '--name') ?? basename(rootPath);
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

async function start() {
  let { config, token } = await credentials(await readConfig());
  let stopping = false;
  process.once('SIGINT', () => {
    stopping = true;
  });
  process.once('SIGTERM', () => {
    stopping = true;
  });
  console.info(`Rice Bridge 正在运行：${config.deviceName}`);
  let lastHeartbeatAt = 0;
  let reconnectDelayMs = 1_000;
  while (!stopping) {
    try {
      if (Date.now() - lastHeartbeatAt >= 30_000) {
        await bridgeRequest({
          server: config.server,
          path: '/api/v1/bridge/device/heartbeat',
          method: 'POST',
          token,
        });
        lastHeartbeatAt = Date.now();
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
        await new Promise((resolve) => setTimeout(resolve, 750));
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
  console.info('Rice Bridge 已停止');
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
  console.info('Rice Bridge 设备授权已撤销');
}

function help() {
  console.info(
    `Rice Bridge v0.1\n\nCommands:\n  pair --server URL --code XXXX-XXXX [--name NAME]\n  grant PATH [--name NAME]\n  start\n  status\n  revoke`,
  );
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'pair') await pair(args);
  else if (command === 'grant') await grant(args);
  else if (command === 'start') await start();
  else if (command === 'status') await status();
  else if (command === 'revoke') await revoke();
  else help();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
