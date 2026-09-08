import { constants, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';

const defaultMaximumBytes = 16 * 1024;
const readFlags =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
type ReadOptions = { maxBytes?: number };

function unsafe(): Error {
  // Never include the original exception: filesystem paths and credential
  // contents must not become CLI/desktop error messages.
  return Error('BRIDGE_CREDENTIAL_FILE_UNSAFE');
}
function missing(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
function maximum(options: ReadOptions = {}) {
  const value = options.maxBytes ?? defaultMaximumBytes;
  if (!Number.isSafeInteger(value) || value < 1 || value > 16 * 1024 * 1024)
    throw unsafe();
  return value;
}
function sameIdentity(left: Stats, right: Stats) {
  return left.dev === right.dev && left.ino === right.ino;
}
function sameVersion(left: Stats, right: Stats) {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}
function owned(metadata: Stats) {
  return (
    typeof process.getuid === 'function' && metadata.uid === process.getuid()
  );
}
function privateFile(metadata: Stats, maxBytes: number) {
  if (
    !metadata.isFile() ||
    !owned(metadata) ||
    (metadata.mode & 0o7777) !== 0o600 ||
    metadata.nlink !== 1 ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 0 ||
    metadata.size > maxBytes
  )
    throw unsafe();
}
async function openPrivate(path: string, maxBytes: number) {
  let handle: FileHandle;
  try {
    // O_NONBLOCK prevents an attacker-controlled FIFO from hanging before
    // fstat can reject it. O_NOFOLLOW rejects a final-component symlink.
    handle = await open(path, readFlags);
  } catch (error) {
    if (missing(error)) return null;
    throw unsafe();
  }
  try {
    const metadata = await handle.stat();
    privateFile(metadata, maxBytes);
    return { handle, metadata };
  } catch {
    await handle.close().catch(() => undefined);
    throw unsafe();
  }
}
async function directoryMetadata(directory: string): Promise<Stats | null> {
  try {
    const metadata = await lstat(directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !owned(metadata) ||
      (metadata.mode & 0o7777) !== 0o700
    )
      throw unsafe();
    return metadata;
  } catch (error) {
    if (missing(error)) return null;
    throw unsafe();
  }
}
async function unchangedDirectory(directory: string, expected: Stats) {
  const current = await directoryMetadata(directory);
  if (!current || !sameIdentity(current, expected)) throw unsafe();
}
function recordPath(directory: string, filename: string) {
  if (
    basename(filename) !== filename ||
    !/^[A-Za-z0-9_-]+\.json$/.test(filename)
  )
    throw unsafe();
  return join(directory, filename);
}

export async function prepareCredentialDirectory(directory: string) {
  try {
    // The caller prepares its config parent. Never recursively create or
    // chmod an existing ancestor of this dedicated credential directory.
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw unsafe();
  }
  if (!(await directoryMetadata(directory))) throw unsafe();
}

export async function readPrivateCredentialFile(
  path: string,
  options: ReadOptions = {},
): Promise<string | null> {
  const limit = maximum(options);
  const opened = await openPrivate(path, limit);
  if (!opened) return null;
  try {
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await opened.handle.read(
        bytes,
        count,
        bytes.length - count,
        count,
      );
      if (result.bytesRead === 0) break;
      count += result.bytesRead;
    }
    const after = await opened.handle.stat();
    privateFile(after, limit);
    if (
      count > limit ||
      count !== opened.metadata.size ||
      !sameVersion(opened.metadata, after)
    )
      throw unsafe();
    // Refuse silently lossy decoding; validation operates on the exact bytes.
    return new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(0, count),
    );
  } catch {
    throw unsafe();
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

export async function readCredentialRecordFile(
  directory: string,
  filename: string,
  options: ReadOptions = {},
): Promise<string | null> {
  const path = recordPath(directory, filename);
  const before = await directoryMetadata(directory);
  if (!before) return null;
  const value = await readPrivateCredentialFile(path, options);
  await unchangedDirectory(directory, before);
  return value;
}

async function fileMetadata(path: string, maxBytes = defaultMaximumBytes) {
  const opened = await openPrivate(path, maxBytes);
  if (!opened) return null;
  try {
    return opened.metadata;
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}
async function unchangedFile(path: string, expected: Stats | null) {
  const current = await fileMetadata(path);
  if (
    (expected === null && current !== null) ||
    (expected !== null && (current === null || !sameVersion(expected, current)))
  )
    throw unsafe();
}

export async function writeCredentialRecordFile(
  directory: string,
  filename: string,
  content: string,
): Promise<void> {
  const path = recordPath(directory, filename);
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > defaultMaximumBytes) throw unsafe();
  await prepareCredentialDirectory(directory);
  const before = await directoryMetadata(directory);
  if (!before) throw unsafe();
  // Do not use atomic replacement to silently bypass an unsafe old target.
  const previous = await fileMetadata(path);
  const temporary = join(directory, `.credential-${randomUUID()}.tmp`);
  let created: Stats | null = null;
  let handle: FileHandle | null = null;
  let committed = false;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    created = await handle.stat();
    privateFile(created, defaultMaximumBytes);
    await handle.writeFile(bytes);
    await handle.sync();
    const ready = await handle.stat();
    privateFile(ready, defaultMaximumBytes);
    if (!sameIdentity(created, ready) || ready.size !== bytes.length)
      throw unsafe();
    await handle.close();
    handle = null;
    await unchangedDirectory(directory, before);
    await unchangedFile(path, previous);
    const staged = await lstat(temporary);
    privateFile(staged, defaultMaximumBytes);
    if (!sameVersion(ready, staged)) throw unsafe();
    await rename(temporary, path);
    committed = true;
  } catch {
    throw unsafe();
  } finally {
    await handle?.close().catch(() => undefined);
    if (!committed && created) {
      // Clean only the inode created by this call, never an attacker replacement
      // or an old credential; a swapped directory is left for manual recovery.
      try {
        await unchangedDirectory(directory, before);
        const current = await lstat(temporary);
        if (sameIdentity(current, created)) await unlink(temporary);
      } catch {
        // The original operation has already failed with a safe error.
      }
    }
  }
}

export async function deletePrivateCredentialFile(path: string): Promise<void> {
  const before = await fileMetadata(path);
  if (!before) return;
  try {
    await unchangedFile(path, before);
    await unlink(path);
  } catch {
    throw unsafe();
  }
}

export async function deleteCredentialRecordFile(
  directory: string,
  filename: string,
): Promise<void> {
  const path = recordPath(directory, filename);
  const before = await directoryMetadata(directory);
  if (!before) return;
  await deletePrivateCredentialFile(path);
  await unchangedDirectory(directory, before);
}
