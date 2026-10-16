import { setImmediate as yieldTask } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import CRC32 from 'crc-32';
import { Zip, ZipDeflate, type ZipInputFile } from 'fflate';
import { fromBuffer, type Entry, type ZipFile } from 'yauzl';

export const fileArchiveMaximumBytes = 9_000_000;
export const fileArchiveMaximumFiles = 32;
const maximumEntries = 128;
const maximumPathBytes = 1024;
const maximumExpansionRatio = 100;
const chunkBytes = 64 * 1024;

type ArchiveFile = { path: string; bytes: Uint8Array };
type ArchiveControls = {
  signal?: AbortSignal;
  authorize?: () => Promise<boolean>;
};
type ArchiveErrorCode =
  | 'FILE_ARCHIVE_INVALID'
  | 'FILE_ARCHIVE_LIMIT'
  | 'FILE_ARCHIVE_UNSAFE_PATH'
  | 'FILE_ARCHIVE_PATH_CONFLICT'
  | 'FILE_ARCHIVE_UNSUPPORTED'
  | 'FILE_ARCHIVE_CRC_MISMATCH'
  | 'FILE_ARCHIVE_CANCELED'
  | 'FILE_ARCHIVE_AUTHORITY_LOST';

export class FileArchiveError extends Error {
  constructor(readonly code: ArchiveErrorCode) {
    super(code);
  }
}
const fail = (code: ArchiveErrorCode): never => {
  throw new FileArchiveError(code);
};
const canceled = () => new FileArchiveError('FILE_ARCHIVE_CANCELED');
function checkSignal(signal?: AbortSignal) {
  if (signal?.aborted) throw canceled();
}
async function authorized(controls: ArchiveControls) {
  checkSignal(controls.signal);
  if (!controls.authorize) return;
  let removeAbort = () => {};
  try {
    const aborted = new Promise<never>((_, reject) => {
      if (!controls.signal) return;
      const abort = () => reject(canceled());
      controls.signal.addEventListener('abort', abort, { once: true });
      removeAbort = () => controls.signal?.removeEventListener('abort', abort);
      if (controls.signal.aborted) abort();
    });
    const allowed = await Promise.race([
      Promise.resolve()
        .then(() => controls.authorize!())
        .catch(() => false),
      aborted,
    ]);
    checkSignal(controls.signal);
    if (!allowed) fail('FILE_ARCHIVE_AUTHORITY_LOST');
  } finally {
    removeAbort();
  }
}
async function checkpoint(controls: ArchiveControls) {
  await authorized(controls);
  // Synchronous fflate chunks must yield to cancellation/lease timers too.
  await yieldTask();
  checkSignal(controls.signal);
}

function hasControlCharacters(path: string) {
  for (const character of path) {
    const code = character.codePointAt(0)!;
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
      return true;
  }
  return false;
}

// yauzl exposes raw names in 3.2.0; its older DefinitelyTyped declarations
// omit this field and the public readLocalFileHeader API.
type RawEntry = Entry & { fileNameRaw: Buffer };
type LocalHeader = {
  generalPurposeBitFlag: number;
  compressionMethod: number;
  fileName: Buffer;
};
type HeaderZipFile = ZipFile & {
  readLocalFileHeader(
    entry: Entry,
    callback: (error: Error | null, header?: LocalHeader) => void,
  ): void;
};

function validateRawPath(bytes: Buffer, directory: boolean) {
  // CP437 decoding maps some ASCII control bytes to printable glyphs. A
  // Unicode-path extra field may also override the original name. Check both.
  if (
    !bytes.length ||
    bytes.length > maximumPathBytes ||
    bytes.some((byte) => byte < 0x20 || byte === 0x7f)
  )
    fail('FILE_ARCHIVE_UNSAFE_PATH');
  const path = bytes.toString('latin1');
  const name = directory ? path.slice(0, -1) : path;
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes(':') ||
    path.endsWith('/') !== directory ||
    name.split('/').some((part) => !part || part === '.' || part === '..')
  )
    fail('FILE_ARCHIVE_UNSAFE_PATH');
}

/** One namespace for both explicit directory markers and implicit ancestors.
 * Case/Unicode collisions are rejected rather than normalized into new names. */
class ArchivePaths {
  private readonly paths = new Map<
    string,
    { spelling: string; directory: boolean; declared: boolean }
  >();
  add(path: string, directory = false) {
    if (
      typeof path !== 'string' ||
      !path ||
      Buffer.byteLength(path) > maximumPathBytes ||
      path.startsWith('/') ||
      path.includes('\\') ||
      path.includes(':') ||
      hasControlCharacters(path) ||
      path.endsWith('/') !== directory
    )
      fail('FILE_ARCHIVE_UNSAFE_PATH');
    const name = directory ? path.slice(0, -1) : path;
    const parts = name.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..'))
      fail('FILE_ARCHIVE_UNSAFE_PATH');
    for (let i = 0; i < parts.length; i++) {
      const spelling = parts.slice(0, i + 1).join('/');
      const key = spelling.normalize('NFC').toUpperCase().toLowerCase();
      const leaf = i === parts.length - 1;
      const isDirectory = !leaf || directory;
      const previous = this.paths.get(key);
      if (
        previous &&
        (previous.spelling !== spelling ||
          !previous.directory ||
          !isDirectory ||
          (leaf && previous.declared))
      )
        fail('FILE_ARCHIVE_PATH_CONFLICT');
      this.paths.set(key, {
        spelling,
        directory: isDirectory,
        declared: (previous?.declared ?? false) || leaf,
      });
    }
    return name;
  }
}

function boundedSize(value: number) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > fileArchiveMaximumBytes
  )
    fail('FILE_ARCHIVE_LIMIT');
}
function expansion(uncompressed: number, compressed: number) {
  if (uncompressed > compressed * maximumExpansionRatio)
    fail('FILE_ARCHIVE_LIMIT');
}
function ordinaryEntry(entry: Entry) {
  if (
    entry.isEncrypted() ||
    (entry.generalPurposeBitFlag & 0x2041) !== 0 ||
    ![0, 8].includes(entry.compressionMethod)
  )
    fail('FILE_ARCHIVE_UNSUPPORTED');
  const type = (entry.externalFileAttributes >>> 16) & 0xf000;
  const directory = entry.fileName.endsWith('/');
  if (
    (type !== 0 && type !== (directory ? 0x4000 : 0x8000)) ||
    (!directory && (entry.externalFileAttributes & 0x10) !== 0) ||
    (directory && entry.uncompressedSize !== 0)
  )
    fail('FILE_ARCHIVE_UNSUPPORTED');
  boundedSize(entry.compressedSize);
  boundedSize(entry.uncompressedSize);
  expansion(entry.uncompressedSize, entry.compressedSize);
  validateRawPath((entry as RawEntry).fileNameRaw, directory);
  return directory;
}

/** No paths are read or written. All central-directory metadata is checked
 * before any file is inflated, and every actual chunk is counted and CRC'd. */
export async function readFileArchive(
  bytes: Uint8Array,
  controls: ArchiveControls = {},
): Promise<ArchiveFile[]> {
  checkSignal(controls.signal);
  if (!(bytes instanceof Uint8Array)) fail('FILE_ARCHIVE_INVALID');
  boundedSize(bytes.byteLength);
  const input = Buffer.from(bytes);
  await authorized(controls);
  return new Promise<ArchiveFile[]>((resolve, reject) => {
    let zip: ZipFile | undefined;
    let stream: Readable | undefined;
    let finished = false;
    let failure: FileArchiveError | undefined;
    const entries: { entry: Entry; path: string; directory: boolean }[] = [];
    const paths = new ArchivePaths();
    let files = 0;
    let declaredBytes = 0;
    let actualBytes = 0;
    const finish = (error?: unknown, result?: ArchiveFile[]) => {
      if (finished) return;
      finished = true;
      failure =
        error instanceof FileArchiveError
          ? error
          : error
            ? new FileArchiveError('FILE_ARCHIVE_INVALID')
            : undefined;
      controls.signal?.removeEventListener('abort', abort);
      // Reject through our promise; destroy without emitting an unhandled error.
      stream?.destroy();
      zip?.close();
      if (failure) reject(failure);
      else resolve(result!);
    };
    const abort = () => finish(canceled());
    const current = async () => {
      if (finished) throw failure ?? canceled();
      await authorized(controls);
      if (finished) throw failure ?? canceled();
    };
    controls.signal?.addEventListener('abort', abort, { once: true });
    if (controls.signal?.aborted) {
      abort();
      return;
    }
    fromBuffer(
      input,
      {
        lazyEntries: true,
        autoClose: false,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, opened) => {
        if (finished) {
          opened?.close();
          return;
        }
        if (error || !opened) {
          finish(error ?? new FileArchiveError('FILE_ARCHIVE_INVALID'));
          return;
        }
        zip = opened;
        zip.on('error', finish);
        const extract = async () => {
          const result: ArchiveFile[] = [];
          for (const item of entries) {
            await current();
            const header = await new Promise<LocalHeader>((accept, deny) => {
              (opened as HeaderZipFile).readLocalFileHeader(
                item.entry,
                (e, value) => {
                  if (finished) deny(failure ?? canceled());
                  else if (e || !value)
                    deny(e ?? new FileArchiveError('FILE_ARCHIVE_INVALID'));
                  else accept(value);
                },
              );
            });
            if (
              (header.generalPurposeBitFlag & 0x2041) !== 0 ||
              ![0, 8].includes(header.compressionMethod)
            )
              fail('FILE_ARCHIVE_UNSUPPORTED');
            if (
              header.compressionMethod !== item.entry.compressionMethod ||
              !header.fileName.equals((item.entry as RawEntry).fileNameRaw)
            )
              fail('FILE_ARCHIVE_INVALID');
            await current();
            const readable = await new Promise<Readable>((accept, deny) => {
              opened.openReadStream(item.entry, (e, value) => {
                if (finished) {
                  value?.destroy();
                  deny(failure ?? canceled());
                } else if (e || !value)
                  deny(e ?? new FileArchiveError('FILE_ARCHIVE_INVALID'));
                else {
                  stream = value;
                  accept(value);
                }
              });
            });
            const parts: Buffer[] = [];
            let size = 0;
            let checksum = 0;
            try {
              for await (const value of readable) {
                const available = value as Uint8Array;
                // A buffered Readable can coalesce its 64KiB source chunks.
                // Slice before copying/CRC so timers and authority remain live.
                for (
                  let offset = 0;
                  offset < available.length;
                  offset += chunkBytes
                ) {
                  await current();
                  await yieldTask();
                  checkSignal(controls.signal);
                  if (finished) throw failure ?? canceled();
                  const end = Math.min(offset + chunkBytes, available.length);
                  const length = end - offset;
                  size += length;
                  actualBytes += length;
                  boundedSize(size);
                  boundedSize(actualBytes);
                  expansion(size, item.entry.compressedSize);
                  if (size > item.entry.uncompressedSize)
                    fail('FILE_ARCHIVE_INVALID');
                  const chunk = Buffer.from(available.subarray(offset, end));
                  checksum = CRC32.buf(chunk, checksum);
                  parts.push(chunk);
                }
              }
            } finally {
              readable.destroy();
              stream = undefined;
            }
            if (size !== item.entry.uncompressedSize)
              fail('FILE_ARCHIVE_INVALID');
            if (checksum >>> 0 !== item.entry.crc32)
              fail('FILE_ARCHIVE_CRC_MISMATCH');
            if (!item.directory)
              result.push({
                path: item.path,
                bytes: Buffer.concat(parts, size),
              });
          }
          await current();
          finish(undefined, result);
        };
        zip.on('entry', (entry: Entry) => {
          void (async () => {
            await current();
            if (entries.length >= maximumEntries) fail('FILE_ARCHIVE_LIMIT');
            const directory = ordinaryEntry(entry);
            if (!directory && ++files > fileArchiveMaximumFiles)
              fail('FILE_ARCHIVE_LIMIT');
            const path = paths.add(entry.fileName, directory);
            declaredBytes += entry.uncompressedSize;
            boundedSize(declaredBytes);
            expansion(declaredBytes, input.length);
            entries.push({ entry, path, directory });
            if (!finished) opened.readEntry();
          })().catch(finish);
        });
        zip.once('end', () => {
          void extract().catch(finish);
        });
        try {
          if (
            !Number.isSafeInteger(zip.entryCount) ||
            zip.entryCount < 0 ||
            zip.entryCount > maximumEntries
          )
            fail('FILE_ARCHIVE_LIMIT');
          zip.readEntry();
        } catch (e) {
          finish(e);
        }
      },
    );
  });
}

/** Mature fflate handles compression and the ZIP structure. A very compressible
 * file uses STORE so our generated archives satisfy the same expansion limit. */
export async function createFileArchive(
  files: ArchiveFile[],
  controls: ArchiveControls = {},
): Promise<Uint8Array> {
  checkSignal(controls.signal);
  if (!Array.isArray(files)) fail('FILE_ARCHIVE_INVALID');
  if (files.length > fileArchiveMaximumFiles) fail('FILE_ARCHIVE_LIMIT');
  const paths = new ArchivePaths();
  let total = 0;
  const inputs = files.map((file) => {
    if (!file || !(file.bytes instanceof Uint8Array))
      fail('FILE_ARCHIVE_INVALID');
    const path = paths.add(file.path);
    total += file.bytes.byteLength;
    boundedSize(total);
    return { path, bytes: Buffer.from(file.bytes) };
  });
  await authorized(controls);
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let outputBytes = 0;
  let complete = false;
  let failure: FileArchiveError | undefined;
  const archive = new Zip((error, chunk, final) => {
    if (failure) return;
    if (error) {
      failure = new FileArchiveError('FILE_ARCHIVE_INVALID');
      return;
    }
    if (outputBytes + chunk.length > fileArchiveMaximumBytes) {
      failure = new FileArchiveError('FILE_ARCHIVE_LIMIT');
      return;
    }
    outputBytes += chunk.length;
    parts.push(chunk);
    complete = final;
  });
  try {
    for (const input of inputs) {
      await checkpoint(controls);
      const compressed: Uint8Array<ArrayBuffer>[] = [];
      let compressedBytes = 0;
      let compressionFailure: FileArchiveError | undefined;
      const deflate = new ZipDeflate(input.path, { level: 6 });
      deflate.ondata = (error, chunk) => {
        if (compressionFailure) return;
        if (error) {
          compressionFailure = new FileArchiveError('FILE_ARCHIVE_INVALID');
          return;
        }
        if (compressedBytes + chunk.length > fileArchiveMaximumBytes) {
          compressionFailure = new FileArchiveError('FILE_ARCHIVE_LIMIT');
          return;
        }
        compressedBytes += chunk.length;
        compressed.push(chunk);
      };
      for (
        let position = 0;
        position < input.bytes.length;
        position += chunkBytes
      ) {
        await checkpoint(controls);
        const end = Math.min(position + chunkBytes, input.bytes.length);
        deflate.push(
          input.bytes.subarray(position, end),
          end === input.bytes.length,
        );
        if (compressionFailure) throw compressionFailure;
      }
      if (!input.bytes.length) deflate.push(input.bytes, true);
      if (compressionFailure) throw compressionFailure;
      const stored =
        input.bytes.length > compressedBytes * maximumExpansionRatio;
      const entry: ZipInputFile = {
        filename: input.path,
        compression: stored ? 0 : 8,
        flag: stored ? 0 : deflate.flag,
        crc: deflate.crc,
        size: input.bytes.length,
        os: 3,
        attrs: (0o100644 << 16) >>> 0,
        // The byte-only API has no source timestamp; use a deterministic ZIP epoch.
        mtime: new Date(1980, 0, 1),
      };
      archive.add(entry);
      const chunks = stored
        ? Array.from(
            { length: Math.max(1, Math.ceil(input.bytes.length / chunkBytes)) },
            (_, i) =>
              input.bytes.subarray(i * chunkBytes, (i + 1) * chunkBytes),
          )
        : compressed;
      for (const [index, chunk] of chunks.entries()) {
        await checkpoint(controls);
        entry.ondata!(null, chunk, index === chunks.length - 1);
        if (failure) throw failure;
      }
    }
    archive.end();
    if (failure) throw failure;
    if (!complete) fail('FILE_ARCHIVE_INVALID');
    await authorized(controls);
    return Buffer.concat(parts, outputBytes);
  } finally {
    archive.terminate();
  }
}
