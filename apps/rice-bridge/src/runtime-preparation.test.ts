import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import type { LocalCommandRunner } from './local-command-runner.js';
import { LocalCommandError } from './local-command-inputs.js';
import {
  prepareLocalSandbox,
  probeLocalBrowser,
  sandboxLaunchEnvironment,
} from './runtime-preparation.js';
import * as browserDriver from './local-browser-driver.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('finds sibling VM helpers from a desktop launch without importing the caller search path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rice-sandbox-launch-'));
  const installed = join(root, 'installed'),
    untrusted = join(root, 'untrusted');
  const execute = promisify(execFile);
  try {
    await mkdir(installed);
    await mkdir(untrusted);
    await writeFile(
      join(installed, 'limactl'),
      '#!/bin/sh\nprintf installed-helper',
      { mode: 0o700 },
    );
    await writeFile(
      join(untrusted, 'limactl'),
      '#!/bin/sh\nprintf wrong-helper',
      { mode: 0o700 },
    );
    const colima = join(installed, 'colima');
    await writeFile(colima, '#!/bin/sh\nexec limactl --version', {
      mode: 0o700,
    });
    const desktopPath = '/usr/bin:/bin:/usr/sbin:/sbin';
    // Reproduce the actual nested executable lookup, not just a PATH string.
    await expect(
      execute(colima, [], { env: { ...process.env, PATH: desktopPath } }),
    ).rejects.toThrow();
    vi.stubEnv('PATH', untrusted + ':' + desktopPath);
    const { stdout } = await execute(colima, [], {
      env: sandboxLaunchEnvironment(colima),
    });
    expect(stdout).toBe('installed-helper');
    // Preparation must not broaden core's own executable search path.
    expect(process.env.PATH).toBe(untrusted + ':' + desktopPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('pause during native startup still closes the owned blank-page probe before completing', async () => {
  let release!: () => void, entered!: () => void;
  const startup = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const close = vi.fn(async () => {}),
    observe = vi.fn();
  vi.spyOn(browserDriver, 'startLocalBrowserDriver').mockImplementation(
    async (input) => {
      await input.assertAlive();
      entered();
      await startup;
      // The startup lease remains valid until the owned process has a stop receipt.
      await input.assertAlive();
      return { close, observe } as unknown as browserDriver.LocalBrowserDriver;
    },
  );
  const abort = new AbortController();
  const probe = probeLocalBrowser(
    {
      deviceId: 'synthetic',
      server: 'https://synthetic.example',
      deviceName: 'Probe',
      grants: [],
    },
    abort.signal,
  );
  await started;
  abort.abort();
  release();
  await expect(probe).rejects.toThrow();
  expect(observe).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledWith('completed');
});
it('downloads only a missing pinned image, then requires a successful native preflight', async () => {
  const profile = { architecture: 'arm64', backend: 'local-vm-container-v1' };
  const preflight = vi
    .fn()
    .mockRejectedValueOnce(new LocalCommandError('DAEMON_HTTP_404'))
    .mockRejectedValueOnce(new LocalCommandError('DAEMON_HTTP_404'))
    .mockResolvedValue(profile);
  const prepareToolchain = vi.fn(async () => {});
  const runner = {
    preflight,
    api: { prepareToolchain },
  } as unknown as LocalCommandRunner;
  expect(
    await prepareLocalSandbox(runner, new AbortController().signal),
  ).toEqual(profile);
  expect(prepareToolchain).toHaveBeenCalledOnce();
  expect(preflight).toHaveBeenCalledTimes(3);
});
it('does not claim readiness when a prepared image fails verification', async () => {
  const preflight = vi
    .fn()
    .mockRejectedValueOnce(new LocalCommandError('DAEMON_HTTP_404'))
    .mockRejectedValueOnce(new LocalCommandError('DAEMON_HTTP_404'))
    .mockRejectedValue(new LocalCommandError('TOOLCHAIN_CHANGED'));
  const runner = {
    preflight,
    api: { prepareToolchain: vi.fn(async () => {}) },
  } as unknown as LocalCommandRunner;
  await expect(
    prepareLocalSandbox(runner, new AbortController().signal),
  ).rejects.toThrow('TOOLCHAIN_CHANGED');
});
it('cancellation stops preparation without downloading', async () => {
  const signal = AbortSignal.abort(),
    prepareToolchain = vi.fn();
  const runner = {
    preflight: vi
      .fn()
      .mockRejectedValue(new LocalCommandError('DAEMON_HTTP_404')),
    api: { prepareToolchain },
  } as unknown as LocalCommandRunner;
  await expect(prepareLocalSandbox(runner, signal)).rejects.toThrow();
  expect(prepareToolchain).not.toHaveBeenCalled();
});
