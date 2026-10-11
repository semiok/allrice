import { describe, expect, it, vi } from 'vitest';
import {
  cloudServiceStopCause,
  inFlightHeartbeat,
} from './service-diagnostics.js';
describe('cloud preview stop diagnostics', () => {
  it.each([
    ['CLOUD_SERVICE_GUARD_LOST', 'guard_lost'],
    ['CLOUD_SERVICE_GUARD_TIMEOUT', 'guard_lost'],
    ['CLOUD_SERVICE_CONTROL_TIMEOUT', 'control_timeout'],
    ['CLOUD_SERVICE_MISSING_EXIT', 'connection_lost'],
    ['CLOUD_SERVICE_WORKER_SHUTDOWN', 'worker_shutdown'],
    ['CLOUD_EXECUTION_REVOKED', 'authority_changed'],
    ['secret token or an arbitrary network exception', 'unknown'],
  ])(
    'classifies ordinary Error %s without exposing exception text',
    (code, cause) => {
      expect(cloudServiceStopCause(new Error(code))).toBe(cause);
    },
  );
  it('shares only a pending exchange, with no cached authorization', async () => {
    let resolve!: (v: number) => void;
    const exchange = vi.fn(
      () =>
        new Promise<number>((r) => {
          resolve = r;
        }),
    );
    const beat = inFlightHeartbeat(exchange),
      first = beat(),
      second = beat();
    expect(first).toBe(second);
    expect(exchange).toHaveBeenCalledTimes(1);
    resolve(1);
    await first;
    const next = beat();
    expect(exchange).toHaveBeenCalledTimes(2);
    resolve(2);
    expect(await next).toBe(2);
  });
  it('clears a rejected exchange so the next request rechecks authority', async () => {
    const exchange = vi
      .fn()
      .mockRejectedValueOnce(Error('temporary'))
      .mockResolvedValue(false);
    const beat = inFlightHeartbeat(exchange);
    await expect(beat()).rejects.toThrow('temporary');
    expect(await beat()).toBe(false);
    expect(exchange).toHaveBeenCalledTimes(2);
  });
});
