import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  link,
  lstat,
  open,
  realpath,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  LocalFilePathSchema,
  LocalFileResultSchema,
  localFileMaximumBytes,
  type LocalFilePayload,
  type LocalFileResult,
  type LocalFileVersion,
  type LocalFileObject,
} from '@allrice/contracts';
import {
  resolveAuthorizedPath,
  resolveAuthorizedWriteTarget,
} from './executor.js';

const execFileAsync = promisify(execFile);
const chunkBytes = 64 * 1024;
const documentTypes: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
};
export class LocalFileError extends Error {
  constructor(
    readonly code: string,
    readonly unknown = false,
  ) {
    super(code);
  }
}
function sameFile(a: Stats, b: Stats) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    b.isFile()
  );
}
async function authorizedFile(root: string, path: string) {
  LocalFilePathSchema.parse(path);
  const { candidateReal: absolute } = await resolveAuthorizedPath(root, path);
  if ((await lstat(resolve(root, path))).isSymbolicLink())
    throw new LocalFileError('FILE_SYMLINK');
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new LocalFileError('FILE_TYPE_UNSUPPORTED');
    if (stat.size > localFileMaximumBytes)
      throw new LocalFileError('FILE_TOO_LARGE');
    return { absolute, handle, stat };
  } catch (e) {
    await handle.close();
    throw e;
  }
}
async function hashFile(
  handle: FileHandle,
  stat: Stats,
  path: string,
): Promise<LocalFileVersion> {
  const hash = createHash('sha256'),
    buffer = Buffer.alloc(chunkBytes);
  let position = 0;
  while (position <= stat.size) {
    const read = await handle.read(
      buffer,
      0,
      Math.min(chunkBytes, stat.size - position + 1),
      position,
    );
    if (!read.bytesRead) break;
    position += read.bytesRead;
    if (position > localFileMaximumBytes || position > stat.size)
      throw new LocalFileError('FILE_CHANGED');
    hash.update(buffer.subarray(0, read.bytesRead));
  }
  if (position !== stat.size || !sameFile(stat, await handle.stat()))
    throw new LocalFileError('FILE_CHANGED');
  const checksum = `sha256:${hash.digest('hex')}`;
  return {
    checksum,
    sizeBytes: stat.size,
    version: `sha256:${createHash('sha256')
      .update(
        JSON.stringify([
          path,
          stat.dev,
          stat.ino,
          stat.size,
          stat.mtimeMs,
          stat.ctimeMs,
          checksum,
        ]),
      )
      .digest('hex')}`,
    mediaType:
      documentTypes[basename(path).split('.').at(-1)?.toLowerCase() ?? ''] ??
      'application/octet-stream',
  };
}
export async function inspectLocalFile(root: string, path: string) {
  const file = await authorizedFile(root, path);
  try {
    return await hashFile(file.handle, file.stat, path);
  } finally {
    await file.handle.close();
  }
}
export interface LocalFileTransport {
  download(object: LocalFileObject): Promise<ReadableStream<Uint8Array>>;
  upload(
    file: LocalFileVersion,
    name: string,
    bytes: ReadableStream<Uint8Array>,
    object: LocalFileObject | null,
  ): Promise<LocalFileObject>;
}
export type LocalFileExecutionOptions = {
  transport: LocalFileTransport;
  authorize: (force?: boolean) => Promise<boolean>;
  signal?: AbortSignal;
  chooseFile?: (root: string, signal?: AbortSignal) => Promise<string | null>;
  openFile?: (absolute: string, reveal: boolean) => Promise<void>;
  checkpoint?: (result: LocalFileResult) => Promise<void>;
};
async function permission(options: LocalFileExecutionOptions, force = false) {
  if (options.signal?.aborted || !(await options.authorize(force)))
    throw new LocalFileError('FILE_CANCELED');
}
function result(
  status: LocalFileResult['status'],
  path: string,
  file: LocalFileVersion,
  object: LocalFileObject | null,
) {
  return LocalFileResultSchema.parse({
    contractVersion: 1,
    status,
    path,
    file,
    object,
    platformUploaded: status === 'uploaded',
    localSaved: status === 'saved',
  });
}
async function checkpoint(
  options: LocalFileExecutionOptions,
  output: LocalFileResult,
) {
  try {
    await options.checkpoint?.(output);
  } catch {
    throw new LocalFileError('FILE_RESULT_UNKNOWN', true);
  }
}

/** Native byte handling shared by Run operations and direct user commands. */
export async function executeLocalFile(
  root: string,
  payload: LocalFilePayload,
  options: LocalFileExecutionOptions,
): Promise<LocalFileResult> {
  await permission(options);
  let path = payload.arguments.path;
  if (payload.capability === 'local.file.select') {
    if (!options.chooseFile)
      throw new LocalFileError('NATIVE_PICKER_UNAVAILABLE');
    const canceled = new AbortController();
    const signal = AbortSignal.any([
      canceled.signal,
      AbortSignal.timeout(300_000),
      ...(options.signal ? [options.signal] : []),
    ]);
    // Picking is not a detached approval: cancellation/expiry/revocation closes
    // the native panel even when the user has not responded yet.
    const poll = setInterval(() => {
      void options.authorize(true).then(
        (allowed) => {
          if (!allowed) canceled.abort();
        },
        () => canceled.abort(),
      );
    }, 500);
    let cancel!: () => void;
    let selected: string | null;
    try {
      selected = await Promise.race([
        options.chooseFile(root, signal),
        new Promise<never>((_, reject) => {
          cancel = () => reject(new LocalFileError('FILE_CANCELED'));
          if (signal.aborted) cancel();
          else signal.addEventListener('abort', cancel, { once: true });
        }),
      ]);
    } finally {
      clearInterval(poll);
      signal.removeEventListener('abort', cancel);
      canceled.abort();
    }
    if (!selected) throw new LocalFileError('FILE_CANCELED');
    await permission(options, true);
    path = relative(await realpath(root), await realpath(selected))
      .split(sep)
      .join('/');
    LocalFilePathSchema.parse(path);
  }
  if (payload.capability === 'local.file.save') {
    const { candidate, rootReal, metadata } =
      await resolveAuthorizedWriteTarget(root, path);
    if (metadata) throw new LocalFileError('PATH_ALREADY_EXISTS');
    const parent = dirname(candidate),
      parentIdentity = await lstat(parent);
    const temporary = resolve(parent, `.allrice-${randomUUID()}.part`);
    const handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    let committed = false;
    try {
      const reader = (
        await options.transport.download(payload.arguments.object)
      ).getReader();
      const hash = createHash('sha256');
      let size = 0;
      try {
        for (;;) {
          await permission(options);
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (
            size > payload.arguments.object.sizeBytes ||
            size > localFileMaximumBytes
          )
            throw new LocalFileError('FILE_TOO_LARGE');
          hash.update(chunk.value);
          let offset = 0;
          while (offset < chunk.value.byteLength) {
            const written = (await handle.write(chunk.value, offset))
              .bytesWritten;
            if (!written) throw new LocalFileError('FILE_WRITE_FAILED');
            offset += written;
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (
        size !== payload.arguments.object.sizeBytes ||
        `sha256:${hash.digest('hex')}` !== payload.arguments.object.checksum
      )
        throw new LocalFileError('FILE_CHECKSUM_MISMATCH');
      await handle.sync();
      await permission(options, true);
      const currentParent = await lstat(parent);
      if (
        currentParent.dev !== parentIdentity.dev ||
        currentParent.ino !== parentIdentity.ino ||
        (await realpath(parent)) !== parent ||
        (await realpath(root)) !== rootReal
      )
        throw new LocalFileError('FOLDER_CHANGED');
      // Atomic create-only commit: concurrent same-name writes cannot be overwritten.
      await link(temporary, candidate).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'EEXIST')
          throw new LocalFileError('PATH_ALREADY_EXISTS');
        throw e;
      });
      committed = true;
      await unlink(temporary);
      const directory = await open(
        parent,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      const inspected = await inspectLocalFile(root, path);
      // Save preserves the source object's MIME metadata and original bytes;
      // opening remains a separately checked, supported document action.
      const output = result(
        'saved',
        path,
        { ...inspected, mediaType: payload.arguments.object.mediaType },
        payload.arguments.object,
      );
      await checkpoint(options, output);
      return output;
    } catch (e) {
      if (committed) throw new LocalFileError('FILE_SAVE_UNKNOWN', true);
      throw e;
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
  const file = await authorizedFile(root, path);
  try {
    const inspected = await hashFile(file.handle, file.stat, path);
    if ('expected' in payload.arguments) {
      const expected = payload.arguments.expected;
      if (
        inspected.version !== expected.version ||
        inspected.checksum !== expected.checksum ||
        inspected.sizeBytes !== expected.sizeBytes ||
        inspected.mediaType !== expected.mediaType
      )
        throw new LocalFileError('FILE_CHANGED');
    }
    if (payload.capability === 'local.file.inspect')
      return result('inspected', path, inspected, null);
    if (
      payload.capability === 'local.file.import' ||
      payload.capability === 'local.file.select'
    ) {
      let position = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            await permission(options);
            if (position === file.stat.size) {
              if (
                !sameFile(file.stat, await file.handle.stat()) ||
                !sameFile(file.stat, await lstat(file.absolute))
              )
                throw new LocalFileError('FILE_CHANGED');
              controller.close();
              return;
            }
            const buffer = Buffer.alloc(
              Math.min(chunkBytes, file.stat.size - position),
            );
            const read = await file.handle.read(
              buffer,
              0,
              buffer.byteLength,
              position,
            );
            if (!read.bytesRead) throw new LocalFileError('FILE_CHANGED');
            position += read.bytesRead;
            controller.enqueue(buffer.subarray(0, read.bytesRead));
          } catch (e) {
            controller.error(e);
          }
        },
      });
      const object = await options.transport.upload(
        inspected,
        basename(path),
        stream,
        payload.capability === 'local.file.import'
          ? payload.arguments.object
          : null,
      );
      const output = result('uploaded', path, inspected, object);
      await checkpoint(options, output);
      return output;
    }
    await permission(options, true);
    const header = Buffer.alloc(16);
    await file.handle.read(header, 0, header.length, 0);
    if (
      !Object.values(documentTypes).includes(inspected.mediaType) ||
      (file.stat.mode & 0o111) !== 0 ||
      header.subarray(0, 2).toString() === '#!' ||
      header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      [
        'feedface',
        'feedfacf',
        'cefaedfe',
        'cffaedfe',
        'cafebabe',
        'bebafeca',
      ].includes(header.subarray(0, 4).toString('hex'))
    )
      throw new LocalFileError('FILE_OPEN_UNSUPPORTED');
    if (!sameFile(file.stat, await lstat(file.absolute)))
      throw new LocalFileError('FILE_CHANGED');
    const reveal = payload.capability === 'local.file.reveal';
    if (options.openFile) await options.openFile(file.absolute, reveal);
    else {
      if (process.platform !== 'darwin')
        throw new LocalFileError('PLATFORM_UNSUPPORTED');
      try {
        await execFileAsync(
          '/usr/bin/open',
          [...(reveal ? ['-R'] : []), '--', file.absolute],
          { timeout: 10_000, maxBuffer: 4096 },
        );
      } catch (e) {
        const error = e as NodeJS.ErrnoException;
        if (error.code === 'ETIMEDOUT' || ('killed' in error && error.killed))
          throw new LocalFileError('FILE_OPEN_UNKNOWN', true);
        throw new LocalFileError(
          reveal ? 'FINDER_UNAVAILABLE' : 'DEFAULT_APPLICATION_UNAVAILABLE',
        );
      }
    }
    const output = result(
      reveal ? 'revealed' : 'opened',
      path,
      inspected,
      null,
    );
    await checkpoint(options, output);
    return output;
  } finally {
    await file.handle.close();
  }
}
