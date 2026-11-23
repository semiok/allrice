import { createHash } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { createAuthorizedFileResource } from './authorized-file-resource.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture(
  bytes = Buffer.from('中文\ufeff\r\nexact\0bytes'),
  source = bytes,
) {
  const lifetime = new AbortController();
  let allowed = true;
  const recheck = vi.fn(async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!allowed) throw Error('current access revoked');
  });
  const cancel = vi.fn(async () => {});
  const get = vi.fn(
    async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < source.byteLength; offset += 3)
            controller.enqueue(source.subarray(offset, offset + 3));
          controller.close();
        },
        cancel,
      }),
  );
  const open = createAuthorizedFileResource({
    checksum: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength,
    signal: lifetime.signal,
    recheck,
    openSource: get,
    changed: () => Error('exact bytes changed'),
  });
  return {
    open,
    lifetime,
    recheck,
    get,
    cancel,
    revoke: () => {
      allowed = false;
    },
  };
}
describe('shared authorized immutable owner stream', () => {
  it('delivers all exact bytes including BOM, NUL and split Unicode, then validates EOF', async () => {
    const f = fixture();
    const actual = Buffer.from(
      await new Response(
        await f.open(new AbortController().signal),
      ).arrayBuffer(),
    );
    expect(actual).toEqual(Buffer.from('中文\ufeff\r\nexact\0bytes'));
    expect(f.get).toHaveBeenCalledTimes(1);
    expect(f.recheck.mock.calls.length).toBeGreaterThan(4);
    expect(f.cancel).not.toHaveBeenCalled();
  });
  it.each(['short', 'long', 'hash'] as const)(
    'rejects %s bytes without accepting EOF',
    async (kind) => {
      const bytes = Buffer.from('abc'),
        source =
          kind === 'short'
            ? Buffer.from('ab')
            : kind === 'long'
              ? Buffer.from('abcd')
              : Buffer.from('abd');
      const f = fixture(bytes, source);
      await expect(
        new Response(await f.open(new AbortController().signal)).arrayBuffer(),
      ).rejects.toThrow('exact bytes changed');
    },
  );
  it('denies before storage and does not allow a later open after owner revocation', async () => {
    const f = fixture();
    f.revoke();
    await expect(f.open(new AbortController().signal)).rejects.toThrow(
      'current access revoked',
    );
    expect(f.get).not.toHaveBeenCalled();
  });
  it('rechecks after storage acquisition and awaits its cancellation', async () => {
    const f = fixture(),
      cleanup = deferred();
    f.get.mockImplementationOnce(async () => {
      f.revoke();
      return new ReadableStream({ cancel: () => cleanup.promise });
    });
    let settled = false;
    const opening = f.open(new AbortController().signal).finally(() => {
      settled = true;
    });
    await turn();
    expect(settled).toBe(false);
    cleanup.resolve();
    await expect(opening).rejects.toThrow('current access revoked');
  });
  it('drops a chunk when access is revoked during its actual read', async () => {
    const bytes = Buffer.from('abc'),
      f = fixture(bytes),
      reading = deferred(),
      release = deferred();
    f.get.mockImplementationOnce(
      async () =>
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            reading.resolve();
            await release.promise;
            f.revoke();
            controller.enqueue(bytes);
          },
        }),
    );
    const stream = await f.open(new AbortController().signal);
    const reader = stream.getReader(),
      result = reader.read();
    await reading.promise;
    release.resolve();
    await expect(result).rejects.toThrow('current access revoked');
    reader.releaseLock();
  });
  it('joins pending owner SQL and source cancellation before reporting abort', async () => {
    const f = fixture(),
      entered = deferred(),
      sql = deferred(),
      canceled = deferred(),
      cleanup = deferred();
    f.get.mockImplementationOnce(
      async () =>
        new ReadableStream({
          cancel() {
            canceled.resolve();
            return cleanup.promise;
          },
        }),
    );
    const reader = (await f.open(new AbortController().signal)).getReader();
    f.recheck.mockImplementationOnce(async (signal) => {
      entered.resolve();
      await sql.promise;
      signal.throwIfAborted();
    });
    let settled = false;
    const reading = reader.read().finally(() => {
      settled = true;
    });
    await entered.promise;
    const stop = Error('request canceled');
    f.lifetime.abort(stop);
    await canceled.promise;
    await turn();
    expect(settled).toBe(false);
    cleanup.resolve();
    await turn();
    expect(settled).toBe(false);
    sql.resolve();
    await expect(reading).rejects.toBe(stop);
    reader.releaseLock();
  });
  it('consumer cancel really waits for cleanup without converting normal cancellation into a failure', async () => {
    const f = fixture(),
      gate = deferred(),
      entered = deferred();
    f.get.mockImplementationOnce(
      async () =>
        new ReadableStream({
          cancel() {
            entered.resolve();
            return gate.promise;
          },
        }),
    );
    const reader = (await f.open(new AbortController().signal)).getReader();
    let settled = false;
    const closing = reader.cancel('close').then(() => {
      settled = true;
    });
    await entered.promise;
    await turn();
    expect(settled).toBe(false);
    gate.resolve();
    await closing;
    expect(settled).toBe(true);
    reader.releaseLock();
  });
  it('keeps the business error and a failed source cleanup together', async () => {
    const f = fixture(),
      cleanup = Error('source cleanup failed');
    f.get.mockImplementationOnce(
      async () =>
        new ReadableStream({
          cancel: async () => {
            throw cleanup;
          },
        }),
    );
    const reader = (await f.open(new AbortController().signal)).getReader();
    f.revoke();
    const error = await reader.read().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toContain(cleanup);
    expect((error as AggregateError).cause).toBeInstanceOf(Error);
    expect(String((error as AggregateError).cause)).toContain(
      'current access revoked',
    );
    reader.releaseLock();
  });
  it('rejects an already canceled caller before it touches storage', async () => {
    const f = fixture(),
      canceled = new AbortController();
    canceled.abort(Error('closed'));
    await expect(f.open(canceled.signal)).rejects.toThrow('closed');
    expect(f.get).not.toHaveBeenCalled();
  });
});
