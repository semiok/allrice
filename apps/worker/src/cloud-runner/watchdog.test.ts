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
