import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, rm, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type {
  HostHistoryAttachment,
  RequestContext,
  StorageObject,
} from '@allrice/contracts';
import { HostHistoryIntegrityError } from '@allrice/storage';

/** Host-only owner authority, never constructed from browser/guest metadata.
 * acquire must install a real object-permission subscription without a gap
 * around its current authorization check. Pending acquire/open/reauthorize
 * must observe the supplied signal and settle after their I/O has stopped.
 * A failed acquire must also release resources before rejecting.
 * close must release the subscription and await all owner resources. */
export interface DEntryHistoryAttachmentHandle {
  readonly object: StorageObject;
  readonly revoked: AbortSignal;
  reauthorize(signal: AbortSignal): Promise<StorageObject>;
  open(signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  close(): Promise<void>;
}

export interface DEntryHistoryAttachmentPort {
  /** Private host-controlled directory; never a request or object-key path. */
  readonly spoolDirectory: string;
  acquire(
    context: RequestContext,
    objectId: string,
    signal: AbortSignal,
  ): Promise<DEntryHistoryAttachmentHandle>;
}

/** Prepare exact bytes before a successful response exists. The anonymous
 * private file is written once, verified, then read through the same handle;
 * neither the source nor a path can replace it after verification. */
export async function prepareHistoryAttachment(input: {
  files: DEntryHistoryAttachmentPort;
  context: RequestContext;
  attachment: HostHistoryAttachment;
  signal: AbortSignal;
  authorize(
    owner: DEntryHistoryAttachmentHandle,
    signal: AbortSignal,
  ): Promise<void>;
}) {
  const transfer = new AbortController();
  let signal = AbortSignal.any([input.signal, transfer.signal]);
  let owner: DEntryHistoryAttachmentHandle | undefined;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let directory: string | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancellation: Promise<void> | undefined;
  let active = Promise.resolve();
  let cleanup: Promise<void> | undefined;
  let ready = false;
  let output: ReadableStreamDefaultController<Uint8Array> | undefined;

  const cancelSource = () => {
    if (reader && !cancellation) cancellation = reader.cancel(signal.reason);
    // The promise is awaited by releaseSource; attach now to avoid an
    // unhandled rejection while an in-flight open/read/write settles.
    void cancellation?.catch(() => undefined);
  };
  const releaseSource = async () => {
    if (!reader) return;
    cancelSource();
    try {
      await cancellation;
    } finally {
      reader.releaseLock();
      reader = undefined;
    }
  };
  const finish = () => {
    cleanup ??= (async () => {
      signal.removeEventListener('abort', abort);
      await active;
      const results = await Promise.allSettled(
        [
          async () => releaseSource(),
          async () => file?.close(),
          async () =>
            directory && rm(directory, { recursive: true, force: true }),
          async () => owner?.close(),
        ].map(async (release) => release()),
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    })();
    return cleanup;
  };
  const abort = () => {
    cancelSource();
    if (ready)
      void finish().then(
        () => output?.error(signal.reason),
        (error: unknown) => output?.error(error),
      );
  };

  try {
    signal.throwIfAborted();
    owner = await input.files.acquire(
      input.context,
      input.attachment.objectId,
      signal,
    );
    signal = AbortSignal.any([signal, owner.revoked]);
    signal.addEventListener('abort', abort, { once: true });
    signal.throwIfAborted();
    await input.authorize(owner, signal);
    signal.throwIfAborted();
    if (!isAbsolute(input.files.spoolDirectory))
      throw new Error('History spool directory must be a host absolute path');
    await mkdir(input.files.spoolDirectory, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(input.files.spoolDirectory, 'history-'));
    signal.throwIfAborted();
    const path = join(directory, 'bytes');
    file = await open(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        constants.O_NOFOLLOW,
      0o600,
    );
    await unlink(path);
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
    signal.throwIfAborted();
    reader = (await owner.open(signal)).getReader();
    signal.throwIfAborted();
    const hash = createHash('sha256');
    let size = 0;
    while (true) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      await input.authorize(owner, signal);
      signal.throwIfAborted();
      if (next.value.byteLength > input.attachment.sizeBytes - size)
        throw new HostHistoryIntegrityError();
      // Own each write buffer across awaits, without retaining the whole file.
      for (let offset = 0; offset < next.value.byteLength; offset += 65536) {
        const bytes = Buffer.from(next.value.subarray(offset, offset + 65536));
        let written = 0;
        while (written < bytes.byteLength) {
          signal.throwIfAborted();
          const result = await file.write(bytes.subarray(written));
          if (!result.bytesWritten) throw new HostHistoryIntegrityError();
          written += result.bytesWritten;
        }
        hash.update(bytes);
        size += bytes.byteLength;
      }
    }
    await releaseSource();
    if (
      size !== input.attachment.sizeBytes ||
      `sha256:${hash.digest('hex')}` !== input.attachment.checksum
    )
      throw new HostHistoryIntegrityError();
    await input.authorize(owner, signal);
    signal.throwIfAborted();
    let position = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          output = controller;
        },
        pull(controller) {
          const read = (async () => {
            signal.throwIfAborted();
            await input.authorize(owner!, signal);
            signal.throwIfAborted();
            if (position === size) return null;
            const bytes = Buffer.allocUnsafe(Math.min(65536, size - position));
            const result = await file!.read(bytes, 0, bytes.length, position);
            if (!result.bytesRead) throw new HostHistoryIntegrityError();
            await input.authorize(owner!, signal);
            signal.throwIfAborted();
            position += result.bytesRead;
            return bytes.subarray(0, result.bytesRead);
          })();
          active = read.then(
            () => undefined,
            () => undefined,
          );
          return read.then(
            async (bytes) => {
              if (bytes === null) {
                await finish();
                controller.close();
              } else {
                signal.throwIfAborted();
                controller.enqueue(bytes);
                if (position === size) {
                  await finish();
                  signal.throwIfAborted();
                  controller.close();
                }
              }
            },
            async (error: unknown) => {
              await finish();
              controller.error(error);
            },
          );
        },
        async cancel(reason) {
          transfer.abort(reason);
          await finish();
        },
      },
      { highWaterMark: 0 },
    );
    ready = true;
    signal.throwIfAborted();
    return body;
  } catch (error) {
    transfer.abort(error);
    await finish();
    throw error;
  }
}
