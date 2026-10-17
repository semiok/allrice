import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReceiptDrainWindow } from './receipt-drain.js';
afterEach(() => vi.useRealTimers());
describe('owned native stop receipt deadline', () => {
  it('one hanging native RPC is closed, without a restarted budget for later flush', async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => {}),
      window = new ReceiptDrainWindow(close);
    const pending = window.within(() => new Promise(() => {}));
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'DSH_DRAIN_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(25_000);
    await rejected;
    expect(close).toHaveBeenCalledTimes(1);
    const next = vi.fn(async () => ({}));
    await expect(window.within(next)).rejects.toMatchObject({
      code: 'DSH_DRAIN_TIMEOUT',
    });
    expect(next).not.toHaveBeenCalled();
    await window.drop();
    expect(close).toHaveBeenCalledTimes(1);
    window.dispose();
  });
  it('a durable earlier deadline shortens the original window; later hints cannot extend it', async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => {}),
      window = new ReceiptDrainWindow(close);
    const start = Date.now();
    window.begin(new Date(start + 15_000).toISOString());
    await vi.advanceTimersByTimeAsync(5_000);
    window.begin(new Date(start + 90_000).toISOString());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(close).toHaveBeenCalledTimes(1);
    window.dispose();
  });
  it('all sequential stop steps share the original time and cannot run after cutoff', async () => {
    vi.useFakeTimers();
    const window = new ReceiptDrainWindow(async () => {});
    await window.within(async () => {});
    await vi.advanceTimersByTimeAsync(24_000);
    const pending = window.within(() => new Promise(() => {}));
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'DSH_DRAIN_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    window.dispose();
  });
  it('a successful child-only drain does not later close its healthy parent', async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => {}),
      window = new ReceiptDrainWindow(close);
    await window.within(async () => ({ drained: true }));
    window.dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(close).not.toHaveBeenCalled();
  });
});
