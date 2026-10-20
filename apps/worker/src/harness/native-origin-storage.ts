import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

type StorageCode =
  | 'DSH_NATIVE_ORIGIN_STORAGE_NOT_VIRGIN'
  | 'DSH_NATIVE_ORIGIN_STORAGE_INVALID_NAMESPACE'
  | 'DSH_NATIVE_ORIGIN_STORAGE_UNAVAILABLE'
  | 'DSH_NATIVE_ORIGIN_STORAGE_ABORTED';

export class NativeOriginStorageError extends Error {
  constructor(readonly code: StorageCode) {
    super(code);
    this.name = 'NativeOriginStorageError';
  }
}

function reject(code: StorageCode): never {
  // Do not retain a filesystem error/cause: it can disclose the namespace.
  throw new NativeOriginStorageError(code);
}

function checkAbort(signal: AbortSignal) {
  if (signal.aborted) reject('DSH_NATIVE_ORIGIN_STORAGE_ABORTED');
}

async function checked<T>(signal: AbortSignal, read: () => Promise<T>) {
  checkAbort(signal);
  const value = await read();
  checkAbort(signal);
  return value;
}

type Directory = { path: string; dev: bigint; ino: bigint };
function directory(
  path: string,
  value: Awaited<ReturnType<typeof inspectStat>>,
) {
  if (value.isSymbolicLink() || !value.isDirectory())
    reject('DSH_NATIVE_ORIGIN_STORAGE_NOT_VIRGIN');
  return { path, dev: value.dev, ino: value.ino };
}
const inspectStat = (path: string) => lstat(path, { bigint: true });

async function verifyDirectory(before: Directory, signal: AbortSignal) {
  const current = directory(
    before.path,
    await checked(signal, () => inspectStat(before.path)),
  );
  if (
    current.dev !== before.dev ||
    current.ino !== before.ino ||
    (await checked(signal, () => realpath(before.path))) !== before.path
  )
    reject('DSH_NATIVE_ORIGIN_STORAGE_NOT_VIRGIN');
}

function missing(error: unknown) {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

/** Read-only precondition for an authorized first writer of a legacy, unbound
 * origin. The namespace covers ALL content-generation IDs for that context.
 *
 * This is NOT a writer fence. The caller must hold the current Job/producer
 * protocol authorization and prevent competing writers/path replacement through
 * the actual switch; separate filesystem observations cannot eliminate TOCTOU.
 * No directories are created and no entry bodies or DSH filenames are read. */
export async function assertVirginNativeNamespace(
  namespace: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    checkAbort(signal);
    if (
      typeof namespace !== 'string' ||
      namespace.includes('\0') ||
      !isAbsolute(namespace) ||
      resolve(namespace) !== namespace
    )
      reject('DSH_NATIVE_ORIGIN_STORAGE_INVALID_NAMESPACE');

    const root = parse(namespace).root;
    const ancestors = [root];
    for (const part of relative(root, namespace).split(sep).filter(Boolean))
      ancestors.push(join(ancestors[ancestors.length - 1]!, part));
    const verified: Directory[] = [];
    for (const path of ancestors) {
      let value: Awaited<ReturnType<typeof inspectStat>>;
      try {
        value = await checked(signal, () => inspectStat(path));
      } catch (error) {
        if (!missing(error) || !verified.length) throw error;
        // ENOENT from lstat alone may follow an ancestor disappearing. Recheck
        // every known parent, then require the SAME missing component again.
        // ENOENT in realpath/readdir/revalidation is never an empty result.
        for (const parent of verified) await verifyDirectory(parent, signal);
        try {
          await checked(signal, () => inspectStat(path));
        } catch (again) {
          if (!missing(again)) throw again;
          checkAbort(signal);
          return;
        }
        reject('DSH_NATIVE_ORIGIN_STORAGE_UNAVAILABLE');
      }
      const before = directory(path, value);
      await verifyDirectory(before, signal);
      verified.push(before);
    }

    const entries = await checked(signal, () => readdir(namespace));
    if (entries.length) reject('DSH_NATIVE_ORIGIN_STORAGE_NOT_VIRGIN');
    for (const parent of verified) await verifyDirectory(parent, signal);
    checkAbort(signal);
  } catch (error) {
    if (signal.aborted) reject('DSH_NATIVE_ORIGIN_STORAGE_ABORTED');
    if (error instanceof NativeOriginStorageError) throw error;
    reject('DSH_NATIVE_ORIGIN_STORAGE_UNAVAILABLE');
  }
}
