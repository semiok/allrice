import { afterEach, expect, it, vi } from 'vitest';
import { DesktopShutdown, desktopShutdownWaitMs } from './desktop-shutdown.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('bounds observation without treating a hung effect as stopped or renewing on progress/retry', () => {
  vi.useFakeTimers();
  const changed = vi.fn();
  const shutdown = new DesktopShutdown(changed);
  shutdown.begin();
  vi.advanceTimersByTime(30_000);
  shutdown.enter('sandbox');
  shutdown.begin();
  vi.advanceTimersByTime(desktopShutdownWaitMs - 30_000);
  expect(shutdown.snapshot()).toMatchObject({
    status: 'overdue',
    phase: 'sandbox',
    elapsedMs: 60_000,
  });
  expect(changed).toHaveBeenCalledTimes(3);
  // Continued observation is read-only; only the actual cleanup owner can
  // confirm completion after the UI has offered recovery.
  shutdown.enter('receipts');
  expect(shutdown.snapshot()?.status).toBe('overdue');
  shutdown.finish(true);
  expect(shutdown.snapshot()?.status).toBe('completed');
});

it('does not report pause preparation as quit, keeps bounded history and cancels its timer on failure', () => {
  vi.useFakeTimers();
  const changed = vi.fn();
  const shutdown = new DesktopShutdown(changed);
  shutdown.enter('browser');
  expect(shutdown.snapshot()).toBeNull();
  shutdown.begin();
  for (let i = 0; i < 30; i++) shutdown.enter(i % 2 ? 'browser' : 'heartbeat');
  expect(shutdown.snapshot()?.history).toHaveLength(16);
  shutdown.finish(false);
  vi.advanceTimersByTime(desktopShutdownWaitMs);
  expect(shutdown.snapshot()?.status).toBe('failed');
  expect(vi.getTimerCount()).toBe(0);
});

it('retains concurrent preparation waits already in flight when quit begins', () => {
  let now = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const shutdown = new DesktopShutdown(() => {});
  shutdown.observePreparation({
    component: 'vm',
    step: 'vm_start',
    state: 'started',
  });
  now = 1100;
  shutdown.observePreparation({
    component: 'python',
    step: 'engine_info',
    state: 'started',
  });
  expect(shutdown.snapshot()).toBeNull();
  shutdown.begin();
  shutdown.enter('preparation');
  now = 1600;
  expect(shutdown.snapshot()?.preparation.active).toEqual([
    { component: 'vm', step: 'vm_start', elapsedMs: 1500 },
    { component: 'python', step: 'engine_info', elapsedMs: 500 },
  ]);
  shutdown.observePreparation({
    component: 'python',
    step: 'engine_info',
    state: 'failed',
  });
  expect(shutdown.snapshot()?.preparation.active).toHaveLength(1);
  expect(shutdown.snapshot()?.preparation.history).toEqual([
    {
      component: 'python',
      step: 'engine_info',
      state: 'failed',
      elapsedMs: 500,
    },
  ]);
  // A diagnostic failure is not a safety confirmation or a renewed deadline.
  expect(shutdown.snapshot()?.status).toBe('waiting');
  shutdown.dispose();
});

it('exports only known preparation identifiers and bounded history', () => {
  const shutdown = new DesktopShutdown(() => {});
  shutdown.begin();
  shutdown.observePreparation({
    component: 'python',
    step: '/private/token',
    state: 'started',
  } as never);
  for (let i = 0; i < 30; i++) {
    shutdown.observePreparation({
      component: 'python',
      step: 'probe_cleanup',
      state: 'started',
      token: 'secret',
    } as never);
    shutdown.observePreparation({
      component: 'python',
      step: 'probe_cleanup',
      state: 'completed',
    });
  }
  expect(shutdown.snapshot()?.preparation.active).toEqual([]);
  expect(shutdown.snapshot()?.preparation.history).toHaveLength(16);
  expect(JSON.stringify(shutdown.snapshot())).not.toMatch(/secret|private/);
  shutdown.dispose();
});
