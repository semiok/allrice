import { constants } from 'node:fs';
import {
  mkdtemp,
  open,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export interface PanelResource {
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  open(signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}
/** Read a bounded preview through the same verified owner stream. All entered
 * I/O and cancellation settle before the caller observes failure. */
export async function readPanelResourceBytes(
  resource: PanelResource,
  maximum: number,
  signal: AbortSignal,
) {
  if (resource.sizeBytes > maximum) throw Error('Panel preview exceeds limit');
  const reader = (await resource.open(signal)).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum || size > resource.sizeBytes)
        throw Error('Panel resource changed');
      chunks.push(chunk.value);
    }
    if (size !== resource.sizeBytes) throw Error('Panel resource changed');
    return Buffer.concat(chunks);
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Panel preview cleanup failed',
        { cause: error },
      );
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Anonymous private spool: verify all source bytes before constructing a 200.
 * The response retains the same open handle and rechecks current object ACLs
 * around each read. This is a download, never a history/native ACL handle. */
export async function preparePanelDownload(
  resource: PanelResource,
  checksum: string,
  signal: AbortSignal,
  authorize: (signal: AbortSignal) => Promise<void>,
) {
  let file: FileHandle | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let directory: string | undefined;
  let path: string | undefined;
  let closing: Promise<void> | undefined;
  let pending: Promise<unknown> | undefined;
  let sourceCancel: Promise<PromiseSettledResult<void>> | undefined;
  const lifetime = new AbortController();
  const active = AbortSignal.any([signal, lifetime.signal]);
  const cleanup = () =>
    (closing ??= Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      const outcomes = await Promise.allSettled([
        pending,
        sourceCancel
          ? sourceCancel.then((result) => {
              if (result.status === 'rejected') throw result.reason;
            })
          : reader
            ? reader.cancel(active.reason)
            : undefined,
      ]);
      for (const result of outcomes)
        if (result.status === 'rejected' && result.reason !== active.reason)
          failures.push(result.reason);
      try {
        reader?.releaseLock();
      } catch (error) {
        failures.push(error);
      }
      reader = undefined;
      try {
        await file?.close();
      } catch (error) {
        failures.push(error);
      }
      file = undefined;
      try {
        if (path) await unlink(path);
      } catch (error) {
        failures.push(error);
      }
      try {
        if (directory) await rmdir(directory);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(failures, 'Panel download cleanup failed');
    }));
  // abort stops the owned stream; the real operation still joins before cleanup.
  const abort = () => {
    lifetime.abort(signal.reason);
    const source = reader;
    if (source)
      sourceCancel ??= Promise.resolve()
        .then(() => source.cancel(active.reason))
        .then(
          () => ({ status: 'fulfilled' as const, value: undefined }),
          (reason: unknown) => ({ status: 'rejected' as const, reason }),
        );
  };
  signal.addEventListener('abort', abort, { once: true });
  const current = async () => {
    active.throwIfAborted();
    await authorize(active);
    active.throwIfAborted();
  };
  try {
    await current();
    directory = await mkdtemp(join(tmpdir(), 'allrice-panel-'));
    path = join(directory, 'bytes');
    file = await open(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        constants.O_NOFOLLOW,
      0o600,
    );
    await unlink(path);
    path = undefined;
    await rmdir(directory);
    directory = undefined;
    reader = (await resource.open(active)).getReader();
    let size = 0;
    const hash = createHash('sha256');
    for (;;) {
      await current();
      const chunk = await reader.read();
      await current();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > resource.sizeBytes) throw Error('Panel resource changed');
      hash.update(chunk.value);
      let written = 0;
      while (written < chunk.value.byteLength) {
        await current();
        const result = await file.write(
          chunk.value,
          written,
          chunk.value.byteLength - written,
          size - chunk.value.byteLength + written,
        );
        if (!result.bytesWritten) throw Error('Panel spool write stopped');
        written += result.bytesWritten;
      }
    }
    if (
      size !== resource.sizeBytes ||
      'sha256:' + hash.digest('hex') !== checksum
    )
      throw Error('Panel resource changed');
    reader.releaseLock();
    reader = undefined;
    await current();
    let offset = 0;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let canceled = false;
    const stop = async (reason?: unknown) => {
      active.removeEventListener('abort', responseAbort);
      signal.removeEventListener('abort', abort);
      lifetime.abort(reason);
      await cleanup();
    };
    const responseAbort = () => {
      const work = pending;
      void Promise.resolve(work)
        .catch(() => undefined)
        .then(() => stop(active.reason))
        .then(
          () => {
            if (!canceled) controller.error(active.reason);
          },
          (error) => {
            if (!canceled)
              controller.error(
                new AggregateError(
                  [active.reason, error],
                  'Panel response cleanup failed',
                  { cause: active.reason },
                ),
              );
          },
        );
    };
    const stream = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value;
          active.addEventListener('abort', responseAbort, { once: true });
          if (active.aborted) responseAbort();
        },
        pull() {
          const work = Promise.resolve().then(async () => {
            await current();
            if (offset === resource.sizeBytes) return true;
            const chunk = Buffer.alloc(
              Math.min(64 * 1024, resource.sizeBytes - offset),
            );
            const result = await file!.read(chunk, 0, chunk.byteLength, offset);
            await current();
            if (!result.bytesRead) throw Error('Panel spool ended early');
            offset += result.bytesRead;
            controller.enqueue(chunk.subarray(0, result.bytesRead));
            return false;
          });
          pending = work;
          return work.then(
            async (done) => {
              if (pending === work) pending = undefined;
              if (done) {
                await stop();
                if (!canceled) controller.close();
              }
            },
            async (error: unknown) => {
              if (pending === work) pending = undefined;
              try {
                await stop(error);
              } catch (failure) {
                error = new AggregateError(
                  [error, failure],
                  'Panel response cleanup failed',
                  { cause: error },
                );
              }
              if (!canceled) controller.error(error);
            },
          );
        },
        async cancel(reason) {
          canceled = true;
          await stop(reason);
        },
      },
      { highWaterMark: 0 },
    );
    const name = Array.from(resource.fileName, (value) =>
      value.charCodeAt(0) < 32 || value.charCodeAt(0) === 127 ? '_' : value,
    ).join('');
    return new Response(stream, {
      headers: {
        'Content-Type': resource.mediaType,
        'Content-Length': String(resource.sizeBytes),
        'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (value) => '%' + value.charCodeAt(0).toString(16))}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    lifetime.abort(error);
    signal.removeEventListener('abort', abort);
    try {
      await cleanup();
    } catch (failure) {
      throw new AggregateError(
        [error, failure],
        'Panel download cleanup failed',
        { cause: error },
      );
    }
    throw error;
  }
}
