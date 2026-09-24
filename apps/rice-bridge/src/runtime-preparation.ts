import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  BrowserProfileSchema,
  type BridgeEnvironment,
} from '@allrice/contracts';
import { configPath, type BridgeConfig } from './config.js';
import { localBrowserOptIn } from './local-browser-settings.js';
import { localPreviewOptIn } from './local-preview-settings.js';
import { nativeSandboxConfig } from './sandbox-settings.js';
import { LocalCommandError } from './local-command-inputs.js';
import type { LocalCommandRunner } from './local-command-runner.js';
import { bridgeVersion } from './version.js';

export function initialBridgeEnvironment(paused = false): BridgeEnvironment {
  return {
    version: 1,
    clientVersion: bridgeVersion,
    paused,
    browser: paused ? 'paused' : 'preparing',
    sandbox: paused ? 'paused' : 'preparing',
    preview: paused ? 'paused' : 'preparing',
  };
}

/** Reuse the actual native launcher, private proxy and renderer. A blank-page
 * probe never opens a tenant website, reads personal cookies or needs a grant. */
export async function probeLocalBrowser(
  config: BridgeConfig,
  signal: AbortSignal,
) {
  const { startLocalBrowserDriver } = await import('./local-browser-driver.js');
  const { LocalBrowserProfiles } = await import('./local-browser-profiles.js');
  signal.throwIfAborted();
  // This probe owns only a blank page. Finish the bounded native launch before
  // closing, so cancellation cannot interrupt the launcher's stop receipt.
  const assertAlive = async () => {};
  const driver = await startLocalBrowserDriver({
    binding: {
      version: 1,
      scope: {
        organizationId: randomUUID(),
        workspaceId: randomUUID(),
        projectId: null,
      },
      ownerId: randomUUID(),
      deviceId: config.deviceId,
      grantId: randomUUID(),
      grantRevision: 1,
      logicalProfileId: randomUUID(),
      persistLogin: false,
    },
    profiles: new LocalBrowserProfiles(configPath(), config.server),
    assertAlive,
    leaseExpiresAt: () => Date.now() + 4500,
    options: {
      profileId: randomUUID(),
      profile: BrowserProfileSchema.parse({
        version: 1,
        network: 'public_https',
        origins: [],
      }),
      assertCurrent: assertAlive,
      requestStarted: () => () => {},
      requestSent: () => {},
      requestApproval: async () => {
        throw Error('PROBE_WRITE_DENIED');
      },
    },
  });
  try {
    signal.throwIfAborted();
    await driver.observe(1);
  } finally {
    await driver.close('completed');
  }
}

/** Resume only the existing dedicated VM. Missing installations are reported
 * truthfully so the employee can use cloud execution for compatible work. */
export async function resumeExistingSandbox(
  runner: LocalCommandRunner,
  signal: AbortSignal,
) {
  if (runner.config.socketPath !== nativeSandboxConfig().socketPath) return;
  const directory = join(homedir(), '.colima/allrice-b2');
  const state = await lstat(join(directory, 'colima.yaml'));
  if (
    !state.isFile() ||
    state.isSymbolicLink() ||
    state.uid !== process.getuid?.()
  )
    throw Error('SANDBOX_PREPARATION_UNAVAILABLE');
  for (const binary of ['/opt/homebrew/bin/colima', '/usr/local/bin/colima']) {
    let path: string;
    try {
      path = await realpath(binary);
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.mode & 0o022 ||
        (stat.uid !== 0 && stat.uid !== process.getuid?.())
      )
        continue;
    } catch {
      continue;
    }
    signal.throwIfAborted();
    await promisify(execFile)(path, ['start', '--profile', 'allrice-b2'], {
      timeout: 60_000,
      maxBuffer: 256_000,
      signal,
    });
    return;
  }
  throw Error('SANDBOX_PREPARATION_UNAVAILABLE');
}

export async function prepareBridgeBrowser(
  config: BridgeConfig,
  signal: AbortSignal,
) {
  if (!(await localBrowserOptIn(config))) return 'paused' as const;
  await probeLocalBrowser(config, signal);
  return 'ready' as const;
}

export async function bridgePreviewState(
  config: BridgeConfig,
  environment: BridgeEnvironment,
) {
  if (!(await localPreviewOptIn(config))) return 'paused' as const;
  if (environment.browser === 'ready' && environment.sandbox === 'ready')
    return 'ready' as const;
  if (
    environment.browser === 'preparing' ||
    environment.sandbox === 'preparing'
  )
    return 'preparing' as const;
  return 'unavailable' as const;
}

/** Preflight remains the authority after preparation; neither a resumed VM nor
 * a completed download alone is advertised as ready. */
export async function prepareLocalSandbox(
  runner: LocalCommandRunner,
  signal: AbortSignal,
) {
  try {
    return await runner.preflight();
  } catch (error) {
    if (!(
      error instanceof LocalCommandError && error.code === 'DAEMON_HTTP_404'
    ))
      await resumeExistingSandbox(runner, signal);
    signal.throwIfAborted();
    try {
      return await runner.preflight();
    } catch (next) {
      if (
        !(next instanceof LocalCommandError) ||
        next.code !== 'DAEMON_HTTP_404'
      )
        throw next;
      await runner.api.prepareToolchain(signal);
      return runner.preflight();
    }
  }
}
