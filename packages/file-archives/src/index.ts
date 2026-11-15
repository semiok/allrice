import { setImmediate as yieldTask } from 'node:timers/promises';
import { createHash } from 'node:crypto';
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
  /** Internal caller bound; general file tools retain the 32-file default. */
  maximumFiles?: number;
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
  constructor(
    readonly code: ArchiveErrorCode,
    readonly reason?: ArchiveReadReason,
  ) {
    super(code);
  }
}
const fail = (code: ArchiveErrorCode): never => {
  throw new FileArchiveError(code);
};
function fileLimit(controls: ArchiveControls) {
  const value = controls.maximumFiles ?? fileArchiveMaximumFiles;
  if (!Number.isInteger(value) || value < 1 || value > maximumEntries)
    fail('FILE_ARCHIVE_LIMIT');
  return value;
}
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
            if (!directory && ++files > fileLimit(controls))
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
  if (files.length > fileLimit(controls)) fail('FILE_ARCHIVE_LIMIT');
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

/** Publication reader policy is explicit and separate from the 32-file/9MB
 * computer and Skill defaults above. No entry is inflated by opening a ZIP. */
export const referenceArchivePolicy = {
  maximumBytes: 50 * 1024 * 1024,
  maximumEntries: 128,
  maximumDeclaredBytes: 256 * 1024 * 1024,
  maximumMemberBytes: 20 * 1024 * 1024,
  maximumExpansionRatio: 100,
} as const;
export type ArchiveReadReason =
  | 'archive_bytes'
  | 'archive_entries'
  | 'archive_declared_bytes'
  | 'member_bytes'
  | 'expansion_ratio'
  | 'archive_structure'
  | 'archive_encrypted'
  | 'archive_compression'
  | 'archive_multivolume'
  | 'archive_crc'
  | 'member_size_mismatch';
export type ArchiveDirectoryEntry = {
  index: number;
  identity: string;
  path: string;
  kind: 'file' | 'directory';
  compressedBytes: number;
  declaredBytes: number;
  compression: 'store' | 'deflate';
};
function archiveReadFail(reason: ArchiveReadReason): never {
  const limits: ArchiveReadReason[] = [
    'archive_bytes',
    'archive_entries',
    'archive_declared_bytes',
    'member_bytes',
    'expansion_ratio',
  ];
  const unsupported: ArchiveReadReason[] = [
    'archive_encrypted',
    'archive_compression',
    'archive_multivolume',
  ];
  throw new FileArchiveError(
    limits.includes(reason)
      ? 'FILE_ARCHIVE_LIMIT'
      : unsupported.includes(reason)
        ? 'FILE_ARCHIVE_UNSUPPORTED'
        : reason === 'archive_crc'
          ? 'FILE_ARCHIVE_CRC_MISMATCH'
          : 'FILE_ARCHIVE_INVALID',
    reason,
  );
}
const archiveDigest = (bytes: Uint8Array) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
function archiveInteger(value: number) {
  if (!Number.isSafeInteger(value) || value < 0)
    archiveReadFail('archive_structure');
  return value;
}
function archiveRatio(expanded: number, compressed: number) {
  if (expanded > compressed * referenceArchivePolicy.maximumExpansionRatio)
    archiveReadFail('expansion_ratio');
}

/** Validate the bounded directory envelope before handing entries to yauzl.
 * ZIP64 is accepted only when every resolved integer is safe and bounded. */
function archiveDirectoryBounds(bytes: Buffer) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) archiveReadFail('archive_structure');
  if (
    bytes.readUInt16LE(end + 4) ||
    bytes.readUInt16LE(end + 6) ||
    bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10)
  )
    archiveReadFail('archive_multivolume');
  let count = bytes.readUInt16LE(end + 10);
  let size = bytes.readUInt32LE(end + 12);
  let start = bytes.readUInt32LE(end + 16);
  let boundary = end;
  if (end >= 20 && bytes.readUInt32LE(end - 20) === 0x07064b50) {
    if (bytes.readUInt32LE(end - 16) || bytes.readUInt32LE(end - 4) !== 1)
      archiveReadFail('archive_multivolume');
    const record = archiveInteger(Number(bytes.readBigUInt64LE(end - 12)));
    if (record + 56 > end - 20 || bytes.readUInt32LE(record) !== 0x06064b50)
      archiveReadFail('archive_structure');
    const recordBytes = archiveInteger(
      Number(bytes.readBigUInt64LE(record + 4)),
    );
    if (recordBytes < 44 || record + 12 + recordBytes !== end - 20)
      archiveReadFail('archive_structure');
    if (
      bytes.readUInt32LE(record + 16) ||
      bytes.readUInt32LE(record + 20) ||
      bytes.readBigUInt64LE(record + 24) !== bytes.readBigUInt64LE(record + 32)
    )
      archiveReadFail('archive_multivolume');
    count = archiveInteger(Number(bytes.readBigUInt64LE(record + 32)));
    size = archiveInteger(Number(bytes.readBigUInt64LE(record + 40)));
    start = archiveInteger(Number(bytes.readBigUInt64LE(record + 48)));
    boundary = record;
  }
  if (count > referenceArchivePolicy.maximumEntries)
    archiveReadFail('archive_entries');
  if (start + size !== boundary) archiveReadFail('archive_structure');
  const records: { identity: string; start: number; end: number }[] = [];
  let cursor = start;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > boundary || bytes.readUInt32LE(cursor) !== 0x02014b50)
      archiveReadFail('archive_structure');
    if (bytes.readUInt16LE(cursor + 34)) archiveReadFail('archive_multivolume');
    const next =
      cursor +
      46 +
      bytes.readUInt16LE(cursor + 28) +
      bytes.readUInt16LE(cursor + 30) +
      bytes.readUInt16LE(cursor + 32);
    if (next > boundary) archiveReadFail('archive_structure');
    records.push({
      identity: archiveDigest(bytes.subarray(cursor, next)),
      start: cursor,
      end: next,
    });
    cursor = next;
  }
  if (cursor !== boundary) archiveReadFail('archive_structure');
  return {
    start,
    count,
    records,
    checksum: archiveDigest(bytes.subarray(start, boundary)),
  };
}

export function isFileArchiveContainer(bytes: Uint8Array) {
  // A complete bounded directory, not a filename/MIME guess. Office is
  // excluded by its package identity, without decompressing any member.
  try {
    const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (input.length > referenceArchivePolicy.maximumBytes) return false;
    const directory = archiveDirectoryBounds(input);
    return !directory.records.some(({ start }) => {
      const name = input
        .subarray(start + 46, start + 46 + input.readUInt16LE(start + 28))
        .toString('utf8');
      return name === '[Content_Types].xml';
    });
  } catch {
    return false;
  }
}

/** Caller must close in finally. Public metadata contains no mutable yauzl
 * entry or path-to-filesystem capability. readMember inflates only its index. */
export async function openReferenceArchive(
  bytes: Uint8Array,
  controls: Pick<ArchiveControls, 'signal' | 'authorize'> = {},
) {
  if (!(bytes instanceof Uint8Array)) archiveReadFail('archive_structure');
  if (bytes.byteLength > referenceArchivePolicy.maximumBytes)
    archiveReadFail('archive_bytes');
  const input = Buffer.from(bytes);
  const bounds = archiveDirectoryBounds(input);
  checkSignal(controls.signal);
  if (controls.authorize && !(await controls.authorize()))
    fail('FILE_ARCHIVE_AUTHORITY_LOST');
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    fromBuffer(
      input,
      {
        lazyEntries: true,
        autoClose: false,
        strictFileNames: true,
        validateEntrySizes: false,
      },
      (error, value) => {
        if (error || !value)
          reject(
            new FileArchiveError('FILE_ARCHIVE_INVALID', 'archive_structure'),
          );
        else resolve(value);
      },
    );
  });
  const entries: Entry[] = [];
  const directory: ArchiveDirectoryEntry[] = [];
  let stream: Readable | undefined;
  let closed = false;
  let failure: unknown;
  const close = () => {
    closed = true;
    stream?.destroy();
    zip.close();
  };
  const abort = () => {
    failure = canceled();
    close();
  };
  const current = async () => {
    if (failure) throw failure;
    if (closed) throw canceled();
    try {
      checkSignal(controls.signal);
      if (controls.authorize && !(await controls.authorize()))
        fail('FILE_ARCHIVE_AUTHORITY_LOST');
      await yieldTask();
      checkSignal(controls.signal);
    } catch (error) {
      failure = error;
      throw error;
    }
    if (failure) throw failure;
  };
  controls.signal?.addEventListener('abort', abort, { once: true });
  if (controls.signal?.aborted) abort();
  zip.on('error', (error) => {
    failure =
      error instanceof FileArchiveError
        ? error
        : new FileArchiveError('FILE_ARCHIVE_INVALID', 'archive_structure');
    stream?.destroy();
  });
  const finish = () => {
    controls.signal?.removeEventListener('abort', abort);
    close();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const paths = new ArchivePaths();
      let declared = 0;
      let compressed = 0;
      const rejectAbort = () => reject(canceled());
      const rejectError = () => reject(failure);
      const cleanup = () => {
        controls.signal?.removeEventListener('abort', rejectAbort);
        zip.removeListener('error', rejectError);
      };
      controls.signal?.addEventListener('abort', rejectAbort, { once: true });
      zip.on('error', rejectError);
      zip.once('end', () => {
        cleanup();
        resolve();
      });
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          await current();
          if (entries.length >= bounds.count)
            archiveReadFail('archive_structure');
          if (entry.isEncrypted() || entry.generalPurposeBitFlag & 0x2041)
            archiveReadFail('archive_encrypted');
          if (![0, 8].includes(entry.compressionMethod))
            archiveReadFail('archive_compression');
          const isDirectory = entry.fileName.endsWith('/');
          const type = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (
            (type !== 0 && type !== (isDirectory ? 0x4000 : 0x8000)) ||
            (!isDirectory && entry.externalFileAttributes & 0x10) ||
            (isDirectory && entry.uncompressedSize !== 0)
          )
            archiveReadFail('archive_structure');
          validateRawPath((entry as RawEntry).fileNameRaw, isDirectory);
          paths.add(entry.fileName, isDirectory);
          archiveInteger(entry.uncompressedSize);
          archiveInteger(entry.compressedSize);
          if (entry.compressedSize > input.length)
            archiveReadFail('archive_structure');
          archiveRatio(entry.uncompressedSize, entry.compressedSize);
          declared += entry.uncompressedSize;
          compressed += entry.compressedSize;
          if (declared > referenceArchivePolicy.maximumDeclaredBytes)
            archiveReadFail('archive_declared_bytes');
          archiveRatio(declared, compressed);
          const index = entries.length;
          entries.push(entry);
          directory.push({
            index,
            identity: bounds.records[index]!.identity,
            path: entry.fileName,
            kind: isDirectory ? 'directory' : 'file',
            compressedBytes: entry.compressedSize,
            declaredBytes: entry.uncompressedSize,
            compression: entry.compressionMethod === 0 ? 'store' : 'deflate',
          });
          zip.readEntry();
        })().catch((error) => {
          cleanup();
          reject(error);
        });
      });
      if (controls.signal?.aborted) {
        cleanup();
        reject(canceled());
      } else zip.readEntry();
    });
    await current();
    if (entries.length !== bounds.count) archiveReadFail('archive_structure');
    // Header/range verification is bounded metadata I/O, never decompression.
    const ranges: { start: number; end: number }[] = [];
    for (const entry of entries) {
      await current();
      const header = await new Promise<
        LocalHeader & {
          fileDataStart: number;
          crc32: number;
          compressedSize: number;
          uncompressedSize: number;
          extraField: Buffer;
        }
      >((resolve, reject) => {
        (zip as HeaderZipFile).readLocalFileHeader(entry, (error, value) => {
          if (error || !value)
            reject(
              new FileArchiveError('FILE_ARCHIVE_INVALID', 'archive_structure'),
            );
          else
            resolve(
              value as LocalHeader & {
                fileDataStart: number;
                crc32: number;
                compressedSize: number;
                uncompressedSize: number;
                extraField: Buffer;
              },
            );
        });
      });
      if (header.generalPurposeBitFlag & 0x2041)
        archiveReadFail('archive_encrypted');
      if (![0, 8].includes(header.compressionMethod))
        archiveReadFail('archive_compression');
      if (
        header.generalPurposeBitFlag !== entry.generalPurposeBitFlag ||
        header.compressionMethod !== entry.compressionMethod ||
        !header.fileName.equals((entry as RawEntry).fileNameRaw)
      )
        archiveReadFail('archive_structure');
      let localCompressed = header.compressedSize,
        localExpanded = header.uncompressedSize;
      if (localCompressed === 0xffffffff || localExpanded === 0xffffffff) {
        let found = false;
        for (let offset = 0; offset + 4 <= header.extraField.length;) {
          const id = header.extraField.readUInt16LE(offset),
            length = header.extraField.readUInt16LE(offset + 2);
          const stop = offset + 4 + length;
          offset += 4;
          if (stop > header.extraField.length)
            archiveReadFail('archive_structure');
          if (id === 1) {
            const readSize = () => {
              if (offset + 8 > stop) archiveReadFail('archive_structure');
              const size = archiveInteger(
                Number(header.extraField.readBigUInt64LE(offset)),
              );
              offset += 8;
              return size;
            };
            if (localExpanded === 0xffffffff) localExpanded = readSize();
            if (localCompressed === 0xffffffff) localCompressed = readSize();
            found = true;
            break;
          }
          offset = stop;
        }
        if (!found) archiveReadFail('archive_structure');
      }
      if (
        !(entry.generalPurposeBitFlag & 8) &&
        (header.crc32 !== entry.crc32 ||
          localCompressed !== entry.compressedSize ||
          localExpanded !== entry.uncompressedSize)
      )
        archiveReadFail('archive_structure');
      const start = archiveInteger(entry.relativeOffsetOfLocalHeader);
      let end = header.fileDataStart + entry.compressedSize;
      if (end > bounds.start) archiveReadFail('archive_structure');
      if (entry.generalPurposeBitFlag & 8) {
        let cursor = end;
        if (cursor + 4 > bounds.start) archiveReadFail('archive_structure');
        if (input.readUInt32LE(cursor) === 0x08074b50) cursor += 4;
        const wide =
          header.compressedSize === 0xffffffff ||
          header.uncompressedSize === 0xffffffff;
        if (cursor + (wide ? 20 : 12) > bounds.start)
          archiveReadFail('archive_structure');
        const crc = input.readUInt32LE(cursor);
        cursor += 4;
        const readSize = () => {
          const value = wide
            ? archiveInteger(Number(input.readBigUInt64LE(cursor)))
            : input.readUInt32LE(cursor);
          cursor += wide ? 8 : 4;
          return value;
        };
        if (
          crc !== entry.crc32 ||
          readSize() !== entry.compressedSize ||
          readSize() !== entry.uncompressedSize
        )
          archiveReadFail('archive_structure');
        end = cursor;
      }
      if (ranges.some((range) => start < range.end && end > range.start))
        archiveReadFail('archive_structure');
      ranges.push({ start, end });
    }
    return {
      directoryChecksum: bounds.checksum,
      entries: directory,
      close: finish,
      async readMember(index: number) {
        await current();
        if (!Number.isInteger(index) || !entries[index] || stream)
          archiveReadFail('archive_structure');
        const entry = entries[index]!;
        if (entry.uncompressedSize > referenceArchivePolicy.maximumMemberBytes)
          archiveReadFail('member_bytes');
        const readable = await new Promise<Readable>((resolve, reject) => {
          zip.openReadStream(entry, (error, value) => {
            if (error || !value)
              reject(
                new FileArchiveError(
                  'FILE_ARCHIVE_INVALID',
                  'archive_structure',
                ),
              );
            else if (closed) {
              value.destroy();
              reject(failure ?? canceled());
            } else {
              stream = value;
              resolve(value);
            }
          });
        });
        const chunks: Buffer[] = [];
        let size = 0,
          crc = 0;
        try {
          for await (const chunk of readable) {
            const available = chunk as Uint8Array;
            for (
              let offset = 0;
              offset < available.length;
              offset += chunkBytes
            ) {
              await current();
              const value = Buffer.from(
                available.subarray(offset, offset + chunkBytes),
              );
              size += value.length;
              if (size > referenceArchivePolicy.maximumMemberBytes)
                archiveReadFail('member_bytes');
              archiveRatio(size, entry.compressedSize);
              if (size > entry.uncompressedSize)
                archiveReadFail('member_size_mismatch');
              crc = CRC32.buf(value, crc);
              chunks.push(value);
            }
          }
          await current();
          if (size !== entry.uncompressedSize)
            archiveReadFail('member_size_mismatch');
          if (crc >>> 0 !== entry.crc32) archiveReadFail('archive_crc');
          return Buffer.concat(chunks, size);
        } catch (error) {
          if (controls.signal?.aborted) throw canceled();
          if (failure) throw failure;
          if (error instanceof FileArchiveError) throw error;
          throw new FileArchiveError(
            'FILE_ARCHIVE_INVALID',
            'archive_structure',
          );
        } finally {
          readable.destroy();
          stream = undefined;
        }
      },
    };
  } catch (error) {
    finish();
    throw error;
  }
}
