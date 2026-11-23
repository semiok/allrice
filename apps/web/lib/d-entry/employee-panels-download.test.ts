import { createHash } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  preparePanelDownload,
  readPanelResourceBytes,
  type PanelResource,
} from './employee-panels-download';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture(bytes = Buffer.from('完整\ufeffbytes\r\n')) {
  const signal = new AbortController();
  const authorize = vi.fn(async (active: AbortSignal) => {
    active.throwIfAborted();
  });
  const checksum = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  const open = vi.fn(async () => new Blob([new Uint8Array(bytes)]).stream());
  const resource: PanelResource = {
    fileName: '原件中文.txt',
    sizeBytes: bytes.length,
    mediaType: 'text/plain',
    open,
  };
  return { resource, checksum, signal, authorize, open };
}
describe('complete authorized panel download', () => {
  it('verifies all bytes before 200 and responds from an anonymous fixed handle', async () => {
    const f = fixture(),
      response = await preparePanelDownload(
        f.resource,
        f.checksum,
        f.signal.signal,
        f.authorize,
      );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(
      String(f.resource.sizeBytes),
    );
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-disposition')).toContain(
      encodeURIComponent('原件中文.txt'),
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from('完整\ufeffbytes\r\n'),
    );
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.authorize.mock.calls.length).toBeGreaterThan(3);
  });
  it.each(['short', 'long', 'checksum'] as const)(
    'does not construct success for %s source corruption',
    async (kind) => {
      const f = fixture(Buffer.from('abc'));
      if (kind === 'checksum') f.checksum = 'sha256:' + '0'.repeat(64);
      else
        f.open.mockResolvedValueOnce(
          new Blob([kind === 'short' ? 'ab' : 'abcd']).stream(),
        );
      await expect(
        preparePanelDownload(
          f.resource,
          f.checksum,
          f.signal.signal,
          f.authorize,
        ),
      ).rejects.toThrow('Panel resource changed');
    },
  );
  it('does zero source I/O when current authority refuses the initial request', async () => {
    const f = fixture();
    f.authorize.mockRejectedValueOnce(Error('denied'));
    await expect(
      preparePanelDownload(
        f.resource,
        f.checksum,
        f.signal.signal,
        f.authorize,
      ),
    ).rejects.toThrow('denied');
    expect(f.open).not.toHaveBeenCalled();
  });
  it('does not return before the real source EOF', async () => {
    const f = fixture(Buffer.from('abc')),
      eof = deferred(),
      entered = deferred();
    let first = true;
    f.open.mockResolvedValueOnce(
      new ReadableStream({
        pull(controller) {
          if (first) {
            first = false;
            controller.enqueue(Buffer.from('abc'));
            return;
          }
          entered.resolve();
          return eof.promise.then(() => controller.close());
        },
      }),
    );
    let settled = false;
    const pending = preparePanelDownload(
      f.resource,
      f.checksum,
      f.signal.signal,
      f.authorize,
    ).then((value) => {
      settled = true;
      return value;
    });
    await entered.promise;
    await turn();
    expect(settled).toBe(false);
    eof.resolve();
    const response = await pending;
    expect(await response.text()).toBe('abc');
  });
  it('joins a pending source acquisition and its cleanup after cancellation', async () => {
    const f = fixture(),
      entered = deferred(),
      acquired = deferred(),
      cleanup = deferred(),
      cancelEntered = deferred();
    f.open.mockImplementationOnce(async () => {
      entered.resolve();
      await acquired.promise;
      return new ReadableStream({
        cancel() {
          cancelEntered.resolve();
          return cleanup.promise;
        },
      });
    });
    let settled = false;
    const pending = preparePanelDownload(
      f.resource,
      f.checksum,
      f.signal.signal,
      f.authorize,
    ).finally(() => {
      settled = true;
    });
    await entered.promise;
    const reason = Error('stopped');
    f.signal.abort(reason);
    await turn();
    expect(settled).toBe(false);
    acquired.resolve();
    await cancelEntered.promise;
    await turn();
    expect(settled).toBe(false);
    cleanup.resolve();
    await expect(pending).rejects.toBe(reason);
  });
  it('joins a blocked read and source cancel, preserving a cleanup rejection', async () => {
    const f = fixture(),
      reading = deferred(),
      cleanup = deferred(),
      canceled = deferred(),
      failure = Error('cancel storage failed');
    f.open.mockResolvedValueOnce(
      new ReadableStream({
        pull() {
          reading.resolve();
        },
        cancel() {
          canceled.resolve();
          return cleanup.promise.then(() => {
            throw failure;
          });
        },
      }),
    );
    let settled = false;
    const pending = preparePanelDownload(
      f.resource,
      f.checksum,
      f.signal.signal,
      f.authorize,
    ).finally(() => {
      settled = true;
    });
    await reading.promise;
    f.signal.abort(Error('request closed'));
    await canceled.promise;
    await turn();
    expect(settled).toBe(false);
    cleanup.resolve();
    const error: unknown = await pending.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AggregateError);
    expect(String((error as AggregateError).cause)).toContain('request closed');
    expect(String((error as AggregateError).errors)).toContain(
      'Panel download cleanup failed',
    );
  });
  it('drops spooled response data if ACL is withdrawn after success construction', async () => {
    const f = fixture(),
      response = await preparePanelDownload(
        f.resource,
        f.checksum,
        f.signal.signal,
        f.authorize,
      );
    f.authorize.mockRejectedValueOnce(Error('object revoked'));
    await expect(response.arrayBuffer()).rejects.toThrow('object revoked');
  });
  it('rechecks between response chunks and cancels without opening the source again', async () => {
    const f = fixture(Buffer.alloc(65537, 65)),
      response = await preparePanelDownload(
        f.resource,
        f.checksum,
        f.signal.signal,
        f.authorize,
      );
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.value?.byteLength).toBe(65536);
    f.authorize.mockRejectedValueOnce(Error('withdrawn'));
    await expect(reader.read()).rejects.toThrow('withdrawn');
    reader.releaseLock();
    expect(f.open).toHaveBeenCalledTimes(1);
  });
  it('consumer cancellation joins an in-flight response authorization Promise', async () => {
    const f = fixture(),
      response = await preparePanelDownload(
        f.resource,
        f.checksum,
        f.signal.signal,
        f.authorize,
      );
    const entered = deferred(),
      gate = deferred();
    f.authorize.mockImplementationOnce(async (active) => {
      entered.resolve();
      await gate.promise;
      active.throwIfAborted();
    });
    const reader = response.body!.getReader(),
      reading = reader.read();
    await entered.promise;
    let settled = false;
    const closing = reader.cancel('consumer closed').finally(() => {
      settled = true;
    });
    await turn();
    expect(settled).toBe(false);
    gate.resolve();
    await closing;
    await reading;
    reader.releaseLock();
  });
  it('an already aborted request does not allocate a source stream', async () => {
    const f = fixture();
    f.signal.abort(Error('closed'));
    await expect(
      preparePanelDownload(
        f.resource,
        f.checksum,
        f.signal.signal,
        f.authorize,
      ),
    ).rejects.toThrow('closed');
    expect(f.open).not.toHaveBeenCalled();
  });
  it('sanitizes header controls while retaining the owner file name', async () => {
    const f = fixture();
    f.resource.fileName = '原件\r\n\0.txt';
    const response = await preparePanelDownload(
      f.resource,
      f.checksum,
      f.signal.signal,
      f.authorize,
    );
    expect(response.headers.get('content-disposition')).not.toContain('%0D');
    expect(response.headers.get('content-disposition')).toContain('___');
    await response.body!.cancel();
  });
});
describe('bounded authorized preview bytes', () => {
  it('does not open a file larger than the actual renderer bound', async () => {
    const f = fixture();
    await expect(
      readPanelResourceBytes(f.resource, 1, f.signal.signal),
    ).rejects.toThrow('limit');
    expect(f.open).not.toHaveBeenCalled();
  });
  it('returns exact bytes after EOF and rejects a short stream', async () => {
    const f = fixture(Buffer.from('abc'));
    expect(
      await readPanelResourceBytes(f.resource, 3, f.signal.signal),
    ).toEqual(Buffer.from('abc'));
    f.open.mockResolvedValueOnce(new Blob(['ab']).stream());
    await expect(
      readPanelResourceBytes(f.resource, 3, f.signal.signal),
    ).rejects.toThrow('changed');
  });
  it('waits for source cancel after a renderer bound is exceeded', async () => {
    const f = fixture(Buffer.from('a')),
      entered = deferred(),
      gate = deferred();
    f.open.mockResolvedValueOnce(
      new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('ab'));
        },
        cancel() {
          entered.resolve();
          return gate.promise;
        },
      }),
    );
    let settled = false;
    const result = readPanelResourceBytes(
      f.resource,
      1,
      f.signal.signal,
    ).finally(() => {
      settled = true;
    });
    await entered.promise;
    await turn();
    expect(settled).toBe(false);
    gate.resolve();
    await expect(result).rejects.toThrow('changed');
  });
});
