/* global process */

import { spawn } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

export const DSH_WEBUI_PRIVATE_ENTRYPOINT = '@deepseek-ai/dsh/lib/bin.js';

export function resolveDshWebUiEntrypoint({
  commandOverride,
  moduleUrl = import.meta.url,
} = {}) {
  const override = commandOverride?.trim();
  if (override) return override;

  return fileURLToPath(
    new URL(`node_modules/${DSH_WEBUI_PRIVATE_ENTRYPOINT}`, moduleUrl),
  );
}

export function createDshWebUiInvocation({
  commandOverride,
  platformPatch,
  runtimePatch,
  upstreamPort,
  trustedHosts,
  adminHome,
  credentialsPath,
  inheritedEnvironment = process.env,
  nodeExecutable = process.execPath,
  moduleUrl = import.meta.url,
}) {
  return {
    executable: nodeExecutable,
    args: [
      // The native DSH WebUI HMR service explicitly requires this Node flag.
      // Launch its private JavaScript entry directly so the flag reaches DSH
      // instead of being swallowed by pnpm's generated shell wrapper.
      '--expose-internals',
      resolveDshWebUiEntrypoint({ commandOverride, moduleUrl }),
      '--profile',
      'web',
      '--patch',
      platformPatch,
      '--patch',
      runtimePatch,
      '--no-open',
      '--port',
      String(upstreamPort),
      '--trusted-host',
      ...trustedHosts,
    ],
    options: {
      // Private browser credentials travel over IPC; native launch URLs must
      // not be forwarded to the gateway's public stdout.
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      env: {
        ...inheritedEnvironment,
        DSH_HOME: adminHome,
        DSH_CREDENTIALS_PATH: credentialsPath,
      },
    },
  };
}

export function spawnDshWebUi(options, spawnImplementation = spawn) {
  const invocation = createDshWebUiInvocation(options);
  return spawnImplementation(
    invocation.executable,
    invocation.args,
    invocation.options,
  );
}
