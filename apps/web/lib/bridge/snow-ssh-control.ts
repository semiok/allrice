import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type SnowBridgeControlAction = 'start' | 'stop' | 'status';

function configuration() {
  const host = process.env.ALLRICE_SNOW_BRIDGE_SSH_HOST;
  const user = process.env.ALLRICE_SNOW_BRIDGE_SSH_USER;
  const identityFile = process.env.ALLRICE_SNOW_BRIDGE_SSH_KEY;
  if (!host || !user || !identityFile) {
    throw new Error('Snow Bridge SSH control is not configured');
  }
  if (!/^[a-zA-Z0-9.-]+$/.test(host) || !/^[a-zA-Z0-9._-]+$/.test(user)) {
    throw new Error('Snow Bridge SSH target is invalid');
  }
  return { host, user, identityFile };
}

export async function controlSnowBridge(action: SnowBridgeControlAction) {
  const config = configuration();
  const result = await execFileAsync(
    '/usr/bin/ssh',
    [
      '-i',
      config.identityFile,
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      '-o',
      'StrictHostKeyChecking=yes',
      `${config.user}@${config.host}`,
      action,
    ],
    { timeout: 12_000, maxBuffer: 16 * 1024 },
  );
  const output = result.stdout.trim();
  return {
    action,
    state:
      output === 'running' ||
      output === 'already_running' ||
      output === 'started'
        ? 'running'
        : 'stopped',
    result: output,
  } as const;
}
