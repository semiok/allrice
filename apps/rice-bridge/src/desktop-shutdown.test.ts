import { afterEach, expect, it, vi } from 'vitest';
import { DesktopShutdown, desktopShutdownWaitMs } from './desktop-shutdown.js';

afterEach(() => vi.useRealTimers());

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
