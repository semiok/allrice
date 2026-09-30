import { afterEach, describe, expect, it, vi } from 'vitest';
import { boundedModelStream } from './allrice-model-stream.mjs';

afterEach(() => vi.useRealTimers());
function stuck() {
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: vi.fn(() => new Promise(() => {})),
    return: vi.fn(() => new Promise(() => {})),
  };
}
describe('native model wait bound', () => {
  it('reports waiting, bounds an uncooperative next/return and discards late output', async () => {
    vi.useFakeTimers();
    const source = stuck();
    let deliver;
    source.next.mockImplementation(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    const onWait = vi.fn();
    const iterator = boundedModelStream(source, {
      idleMs: 100,
      noticeMs: 30,
      onWait,
    });
    const result = iterator.next();
    const rejected = expect(result).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(30);
    expect(onWait.mock.calls).toEqual([['started']]);
    await vi.advanceTimersByTimeAsync(70);
    await rejected;
    expect(source.return).toHaveBeenCalledOnce();
    expect(onWait.mock.calls).toEqual([['started'], ['failed']]);
    deliver({ done: false, value: { type: 'text-delta', text: 'late' } });
    expect(await iterator.next()).toMatchObject({ done: true });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('responds to cancellation even if the provider ignores it', async () => {
    vi.useFakeTimers();
    const controller = new globalThis.AbortController();
    const source = stuck();
    const iterator = boundedModelStream(source, { signal: controller.signal });
    const result = iterator.next();
    const rejected = expect(result).rejects.toMatchObject({ code: 'ABORTED' });
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not start a request for an already canceled consumer', async () => {
    const source = stuck();
    const signal = globalThis.AbortSignal.abort();
    await expect(
      boundedModelStream(source, { signal }).next(),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(source.next).not.toHaveBeenCalled();
  });
  it('resets idle time on progress and excludes consumer processing time', async () => {
    vi.useFakeTimers();
    const source = stuck();
    let deliver;
    source.next.mockImplementation(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    const onWait = vi.fn();
    const iterator = boundedModelStream(source, {
      idleMs: 100,
      noticeMs: 30,
      onWait,
    });
    const first = iterator.next();
    await vi.advanceTimersByTimeAsync(40);
    deliver({ done: false, value: 'progress' });
    expect(await first).toMatchObject({ value: 'progress' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onWait.mock.calls).toEqual([['started'], ['completed']]);
    const next = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    deliver({ done: true });
    expect(await next).toMatchObject({ done: true });
    expect(source.return).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
