import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as ChildProcess from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcess>()),
  execFile: Object.assign(() => undefined, {
    [Symbol.for('nodejs.util.promisify.custom')]: probe,
  }),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  probe.mockReset();
});
it('twenty callers share a bounded retry of a transient watchdog probe before admission', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  probe.mockRejectedValueOnce(Error('heartbeat stale')).mockResolvedValue({
    stdout: JSON.stringify({
      ready: true,
      capacity: { version: 2, slots: 1, backendId: 'fixture' },
      availableBytes: 1024 ** 3,
    }),
  });
  const { CloudRunnerBackend } = await import('./backend.js');
  const results = await Promise.all(
    Array.from({ length: 20 }, () => new CloudRunnerBackend().capacity()),
  );
  expect(probe).toHaveBeenCalledTimes(2);
  expect(results.every((r) => r.slots === 1)).toBe(true);
});
it('does not admit work on persistently unavailable watchdog evidence', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  probe.mockRejectedValue(Error('watchdog unavailable'));
  const { CloudRunnerBackend } = await import('./backend.js');
  await expect(new CloudRunnerBackend().capacity()).rejects.toThrow(
    'CLOUD_WATCHDOG_UNAVAILABLE',
  );
  expect(probe).toHaveBeenCalledTimes(3);
});

it.each([
  undefined,
  {
    profileId: 'web-development',
    maximumTimeoutMs: 60000,
    maximumMemoryMiB: 512,
  },
])(
  'refuses web preparation before execution when the running guard lacks its budget',
  async (budget) => {
    const root = await mkdtemp(join(tmpdir(), 'allrice-web-preflight-'));
    const server = createServer(),
      socket = join(root, 'docker.sock');
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const { CloudRunnerBackend } = await import('./backend.js');
      const { cloudToolchainImageV1 } = await import('@allrice/contracts');
      vi.stubEnv('ALLRICE_CLOUD_DOCKER_SOCKET', socket);
      const backend = new CloudRunnerBackend(socket);
      vi.spyOn(backend, 'json').mockImplementation(async (_method, path) =>
        path === '/info'
          ? {
              OSType: 'linux',
              Architecture: 'amd64',
              CgroupVersion: '2',
              MemoryLimit: true,
              SwapLimit: true,
              PidsLimit: true,
              CpuCfsQuota: true,
              SecurityOptions: ['name=seccomp'],
              Runtimes: { runsc: { path: '/usr/local/bin/runsc' } },
            }
          : { Id: cloudToolchainImageV1, Os: 'linux', Architecture: 'amd64' },
      );
      probe.mockResolvedValue({
        stdout: JSON.stringify({
          ready: true,
          projectServices: true,
          watchdog: 'met166-service-v1',
          runtimeChecksum:
            '1a4995a70b3c8b7d36f55d7d2dc6d15185ebe420de653b1a330b42d36c0e6b4a',
          projectWebDevelopment: budget,
        }),
      });
      await expect(backend.preflight(undefined, true, true)).rejects.toThrow(
        'CLOUD_PROJECT_WEB_PROFILE_UNAVAILABLE',
      );
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
