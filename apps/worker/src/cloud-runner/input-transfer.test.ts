import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendCloudInput } from './input-transfer.js';

class StalledInput extends Duplex {
  override _read() {}
  override _write(
    data: Buffer,
    encoding: string,
    callback: (error?: Error) => void,
  ) {
    // Deliberately consume nothing and never acknowledge this write.
    void data;
    void encoding;
    void callback;
  }
}
afterEach(() => vi.useRealTimers());
describe('Docker input transmission under execution authority', () => {
  const options = () => ({
    deadline: Date.now() + 300_000,
    signal: new AbortController().signal,
    maintainLease: async () => true,
    running: async () => true,
  });
  it('does not hang on a stopped receiver that never acknowledges its input', async () => {
    const stream = new StalledInput();
    expect(
      await sendCloudInput(stream, 'large frozen input', {
        ...options(),
        running: async () => false,
      }),
    ).toBe('stopped');
    expect(stream.destroyed).toBe(true);
  });
  it('stops sending when current authority is lost, without waiting for the write', async () => {
    const stream = new StalledInput();
    expect(
      await sendCloudInput(stream, 'input', {
        ...options(),
        maintainLease: async () => false,
      }),
    ).toBe('canceled');
    expect(stream.destroyed).toBe(true);
  });
  it('obeys the frozen five-minute deadline even when both controls are unreachable', async () => {
    vi.useFakeTimers();
    const stream = new StalledInput();
    const task = sendCloudInput(stream, 'input', {
      ...options(),
      deadline: Date.now() + 1000,
      running: () => new Promise(() => {}),
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await task).toBe('deadline');
    expect(stream.destroyed).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps renewing the lease during a slow transmission and honors user cancel', async () => {
    vi.useFakeTimers();
    const stream = new StalledInput(),
      abort = new AbortController();
    const maintainLease = vi.fn(async () => true);
    const task = sendCloudInput(stream, 'input', {
      ...options(),
      signal: abort.signal,
      maintainLease,
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(maintainLease.mock.calls.length).toBeGreaterThan(2);
    abort.abort();
    expect(await task).toBe('canceled');
    expect(stream.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('a closed connection or failed control is unknown, never a successful write', async () => {
    const closed = new StalledInput();
    const task = sendCloudInput(closed, 'input', options());
    closed.destroy();
    expect(await task).toBe('unknown');
    const failed = new StalledInput();
    expect(
      await sendCloudInput(failed, 'input', {
        ...options(),
        running: async () => {
          throw Error('daemon unavailable');
        },
      }),
    ).toBe('unknown');
  });
  it('releases monitoring after the normal write callback', async () => {
    vi.useFakeTimers();
    const stream = new Duplex({
      read() {},
      write(_data, _encoding, callback) {
        callback();
      },
    });
    expect(await sendCloudInput(stream, 'input', options())).toBe('sent');
    await vi.advanceTimersByTimeAsync(3000);
    expect(vi.getTimerCount()).toBe(0);
    expect(stream.destroyed).toBe(false);
    stream.destroy();
  });
});
