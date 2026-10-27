import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundedP27Wait,
  maintainP27Lease,
  runP27WorkerSequence,
  workerFixtureCleanupConfirmed,
} from './p27-worker-preflight.ts';

afterEach(() => vi.useRealTimers());
describe('bounded two-task sequencing and lease lifetime', () => {
  it('missing/partial initialization cleanup proof cannot be marked cleaned', () => {
    expect(workerFixtureCleanupConfirmed()).toBe(false);
    const proof = {
      globalDatabaseClosed: true,
      databaseEnvironmentRestored: true,
      fixture: {
        schema: 'p25_synthetic',
        schemaRemoved: true,
        storageRoot: null,
        storageRemoved: true,
        databaseClosed: true,
        adminClosed: true,
      },
    };
    expect(workerFixtureCleanupConfirmed(proof)).toBe(true);
    expect(workerFixtureCleanupConfirmed({ ...proof, fixture: null })).toBe(
      false,
    );
    for (const key of [
      'globalDatabaseClosed',
      'databaseEnvironmentRestored',
    ] as const)
      expect(workerFixtureCleanupConfirmed({ ...proof, [key]: false })).toBe(
        false,
      );
    for (const key of [
      'schemaRemoved',
      'storageRemoved',
      'databaseClosed',
      'adminClosed',
    ] as const)
      expect(
        workerFixtureCleanupConfirmed({
          ...proof,
          fixture: { ...proof.fixture, [key]: false },
        }),
      ).toBe(false);
  });
  it('does not prepare ordinary after any first-run or verification failure', async () => {
    const assistant = vi.fn().mockRejectedValue(Error('first_unknown'));
    const ordinary = vi.fn();
    await expect(runP27WorkerSequence({ assistant, ordinary })).rejects.toThrow(
      'first_unknown',
    );
    expect(assistant).toHaveBeenCalledTimes(1);
    expect(ordinary).not.toHaveBeenCalled();
  });
  it('calls each at most once and never retries second-run failure', async () => {
    const assistant = vi.fn().mockResolvedValue('verified-first-id');
    const ordinary = vi.fn().mockRejectedValue(Error('ordinary_failure'));
    await expect(runP27WorkerSequence({ assistant, ordinary })).rejects.toThrow(
      'ordinary_failure',
    );
    expect(assistant).toHaveBeenCalledTimes(1);
    expect(ordinary).toHaveBeenCalledExactlyOnceWith('verified-first-id');
  });
  it.each(['inactive', 'rejected'])(
    'abort on %s heartbeat and clear timer',
    async (mode) => {
      vi.useFakeTimers();
      const abort = new AbortController();
      const heartbeat =
        mode === 'inactive'
          ? vi.fn().mockResolvedValue({ active: false })
          : vi.fn().mockRejectedValue(Error('private database text'));
      const lease = maintainP27Lease({ heartbeat, abort, intervalMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      expect(abort.signal.aborted).toBe(true);
      await expect(lease.stop()).resolves.toEqual({ healthy: false });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('does not overlap heartbeat calls and stop waits for its in-flight heartbeat', async () => {
    vi.useFakeTimers();
    let resolve!: (value: { active: boolean }) => void;
    const heartbeat = vi.fn(
      () =>
        new Promise<{ active: boolean }>((done) => {
          resolve = done;
        }),
    );
    const lease = maintainP27Lease({
      heartbeat,
      abort: new AbortController(),
      intervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(40);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    const stop = lease.stop();
    resolve({ active: true });
    await stop;
    await vi.advanceTimersByTimeAsync(40);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('deadline rejects without creating retries or retaining timer', async () => {
    vi.useFakeTimers();
    const promise = boundedP27Wait(new Promise(() => {}), 10);
    const assertion = expect(promise).rejects.toThrow('p27_worker_deadline');
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('lease is no longer renewed even when subsequent native cleanup times out', async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn().mockResolvedValue({ active: true });
    const lease = maintainP27Lease({
      heartbeat,
      abort: new AbortController(),
      intervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    await lease.stop();
    const stuckNative = boundedP27Wait(new Promise(() => {}), 50);
    const failure = expect(stuckNative).rejects.toThrow('p27_worker_deadline');
    await vi.advanceTimersByTimeAsync(100);
    await failure;
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
