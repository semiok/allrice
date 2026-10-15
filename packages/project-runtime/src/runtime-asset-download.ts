import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeCommandError as LocalCommandError } from './errors.js';
type Asset = {
  fileName: string;
  url: string;
  sizeBytes: number;
  sha256: string;
  sha512?: string;
};
const flags = constants.O_NOFOLLOW | constants.O_NONBLOCK;
async function privateFile(path: string, access: number) {
  const file = await open(path, access | flags, 0o600);
  const stat = await file.stat();
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    stat.nlink !== 1 ||
    stat.mode & 0o022
  ) {
    await file.close();
    throw new LocalCommandError('UNSAFE_RUNTIME_DOWNLOAD');
  }
  return file;
}
export async function runtimeAssetMatches(path: string, asset: Asset) {
  let handle;
  try {
    handle = await privateFile(path, constants.O_RDONLY);
    const before = await handle.stat();
    if (before.size !== asset.sizeBytes) return false;
    const sha = createHash('sha256'),
      sha512 = asset.sha512 ? createHash('sha512') : null;
    for await (const bytes of handle.createReadStream({ autoClose: false })) {
      sha.update(bytes);
      sha512?.update(bytes);
    }
    const after = await handle.stat();
    return (
      before.ino === after.ino &&
      before.dev === after.dev &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs &&
      sha.digest('hex') === asset.sha256 &&
      (!sha512 || sha512.digest('hex') === asset.sha512)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  } finally {
    await handle?.close();
  }
}

const redirectHosts = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'download.docker.com',
  'raw.githubusercontent.com',
]);
async function fetchAsset(
  asset: Asset,
  offset: number,
  etag: string | undefined,
  signal: AbortSignal,
) {
  let url = new URL(asset.url);
  for (let i = 0; i < 5; i++) {
    const response = await fetch(url, {
      redirect: 'manual',
      signal,
      headers: {
        'Accept-Encoding': 'identity',
        ...(offset
          ? { Range: `bytes=${offset}-`, ...(etag ? { 'If-Range': etag } : {}) }
          : {}),
      },
    });
    if (response.status < 300 || response.status > 399) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    const next = location ? new URL(location, url) : null;
    if (
      !next ||
      next.protocol !== 'https:' ||
      next.username ||
      next.password ||
      (next.port && next.port !== '443') ||
      !redirectHosts.has(next.hostname)
    )
      throw new LocalCommandError('RUNTIME_DOWNLOAD_REDIRECT_DENIED');
    url = next;
  }
  throw new LocalCommandError('RUNTIME_DOWNLOAD_REDIRECT_DENIED');
}

type DownloadOptions = {
  onProgress?: (state: {
    stage: 'downloading' | 'verifying' | 'retrying';
    receivedBytes: number;
    expectedBytes: number;
    attempt: number;
    resumed: boolean;
    reason?: string;
  }) => void;
};
/** Fixed, hash-bound software. A private SQLite lock survives process crashes
 * without stale PID recovery; it never contains user files or credentials.
 * Partial bytes remain untrusted until the complete pinned hashes match. */
export async function downloadManagedRuntimeAsset(
  path: string,
  asset: Asset,
  signal: AbortSignal,
  options: DownloadOptions = {},
) {
  signal.throwIfAborted();
  if (
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    !Number.isSafeInteger(asset.sizeBytes) ||
    asset.sizeBytes <= 0 ||
    (asset.sha512 && !/^[a-f0-9]{128}$/.test(asset.sha512))
  )
    throw new LocalCommandError('RUNTIME_DOWNLOAD_MANIFEST_INVALID');
  if (await runtimeAssetMatches(path, asset)) return;
  const lockPath = `${path}.download.sqlite`;
  const lockFile = await privateFile(
    lockPath,
    constants.O_CREAT | constants.O_RDWR,
  );
  await lockFile.close();
  const { DatabaseSync } = await import('node:sqlite');
  const lock = new DatabaseSync(lockPath);
  let locked = false;
  const partial = `${path}.${asset.sha256}.part`,
    metadata = `${partial}.json`;
  const identity = createHash('sha256')
    .update(JSON.stringify(asset))
    .digest('hex');
  const budget = AbortSignal.any([signal, AbortSignal.timeout(600_000)]);
  try {
    try {
      lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      locked = true;
    } catch {
      throw new LocalCommandError('RUNTIME_DOWNLOAD_BUSY');
    }
    if (await runtimeAssetMatches(path, asset)) return;
    if (await runtimeAssetMatches(partial, asset)) {
      await rename(partial, path);
      await rm(metadata, { force: true });
      return;
    }
    let etag: string | undefined;
    let validMetadata = false;
    try {
      const file = await privateFile(metadata, constants.O_RDONLY);
      try {
        if ((await file.stat()).size <= 4096) {
          const value = JSON.parse(await file.readFile('utf8'));
          validMetadata = value.identity === identity;
          if (
            validMetadata &&
            typeof value.etag === 'string' &&
            /^"[^"\r\n]{1,512}"$/.test(value.etag)
          )
            etag = value.etag;
        }
      } finally {
        await file.close();
      }
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
        !(error instanceof SyntaxError)
      )
        throw error;
    }
    const file = await privateFile(
      partial,
      constants.O_CREAT | constants.O_RDWR,
    );
    try {
      if (!validMetadata || (await file.stat()).size >= asset.sizeBytes)
        await file.truncate(0);
      for (let attempt = 1; attempt <= 3; attempt++) {
        budget.throwIfAborted();
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        const requestAbort = new AbortController();
        const requestSignal = AbortSignal.any([budget, requestAbort.signal]);
        let idle: ReturnType<typeof setTimeout> | undefined;
        const resetIdle = () => {
          clearTimeout(idle);
          idle = setTimeout(
            () =>
              requestAbort.abort(
                new LocalCommandError('RUNTIME_DOWNLOAD_STALLED'),
              ),
            30_000,
          );
          idle.unref();
        };
        let discard = false;
        let resumed = false;
        try {
          let offset = (await file.stat()).size;
          resumed = offset > 0;
          resetIdle();
          const response = await fetchAsset(asset, offset, etag, requestSignal);
          if (!response.body)
            throw new LocalCommandError('RUNTIME_DOWNLOAD_UNAVAILABLE');
          reader = response.body.getReader();
          if (response.status === 416) {
            discard = true;
            throw new LocalCommandError('RUNTIME_DOWNLOAD_RANGE_INVALID');
          }
          if (response.status !== 200 && response.status !== 206) {
            if (response.status !== 429 && response.status < 500)
              discard = true;
            throw new LocalCommandError('RUNTIME_DOWNLOAD_UNAVAILABLE');
          }
          if (
            response.headers.get('content-encoding') &&
            response.headers.get('content-encoding') !== 'identity'
          ) {
            discard = true;
            throw new LocalCommandError('RUNTIME_DOWNLOAD_RANGE_INVALID');
          }
          const receivedEtag = response.headers.get('etag');
          if (response.status === 206) {
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
              response.headers.get('content-range') ?? '',
            );
            if (
              !range ||
              Number(range[1]) !== offset ||
              Number(range[2]) !== asset.sizeBytes - 1 ||
              Number(range[3]) !== asset.sizeBytes ||
              (etag && receivedEtag !== etag)
            ) {
              discard = true;
              throw new LocalCommandError('RUNTIME_DOWNLOAD_RANGE_INVALID');
            }
          } else {
            offset = 0;
            await file.truncate(0);
          }
          const length = response.headers.get('content-length');
          if (length !== null && Number(length) !== asset.sizeBytes - offset) {
            discard = true;
            throw new LocalCommandError('RUNTIME_DOWNLOAD_RANGE_INVALID');
          }
          etag =
            receivedEtag && /^"[^"\r\n]{1,512}"$/.test(receivedEtag)
              ? receivedEtag
              : undefined;
          const meta = await privateFile(
            metadata,
            constants.O_CREAT | constants.O_RDWR,
          );
          try {
            await meta.truncate(0);
            await meta.writeFile(
              JSON.stringify({ version: 1, identity, etag }),
            );
            await meta.sync();
          } finally {
            await meta.close();
          }
          options.onProgress?.({
            stage: 'downloading',
            receivedBytes: offset,
            expectedBytes: asset.sizeBytes,
            attempt,
            resumed,
          });
          for (;;) {
            resetIdle();
            const next = await reader.read();
            if (next.done) break;
            requestSignal.throwIfAborted();
            if (offset + next.value.length > asset.sizeBytes) {
              discard = true;
              throw new LocalCommandError('RUNTIME_DOWNLOAD_LIMIT');
            }
            // Explicit position is essential after a 200 fallback truncates a resumed file.
            let written = 0;
            while (written < next.value.length) {
              const result = await file.write(
                next.value,
                written,
                next.value.length - written,
                offset + written,
              );
              if (!result.bytesWritten)
                throw new LocalCommandError('RUNTIME_DOWNLOAD_DISK_ERROR');
              written += result.bytesWritten;
            }
            offset += written;
            options.onProgress?.({
              stage: 'downloading',
              receivedBytes: offset,
              expectedBytes: asset.sizeBytes,
              attempt,
              resumed,
            });
          }
          await file.sync();
          if (offset !== asset.sizeBytes)
            throw new LocalCommandError('RUNTIME_DOWNLOAD_INCOMPLETE');
          options.onProgress?.({
            stage: 'verifying',
            receivedBytes: offset,
            expectedBytes: asset.sizeBytes,
            attempt,
            resumed,
          });
          if (!(await runtimeAssetMatches(partial, asset))) {
            discard = true;
            throw new LocalCommandError('RUNTIME_CHECKSUM_MISMATCH');
          }
          budget.throwIfAborted();
          await rename(partial, path);
          await rm(metadata, { force: true });
          return;
        } catch (error) {
          await file.sync();
          const failure = signal.aborted
            ? signal.reason
            : budget.aborted
              ? new LocalCommandError('RUNTIME_DOWNLOAD_BUDGET_EXCEEDED')
              : requestAbort.signal.aborted
                ? requestAbort.signal.reason
                : error instanceof TypeError
                  ? new LocalCommandError('RUNTIME_DOWNLOAD_CONNECTION_FAILED')
                  : error;
          if (discard) {
            await file.truncate(0);
            await rm(metadata, { force: true });
            throw failure;
          }
          if (budget.aborted || attempt === 3) throw failure;
          options.onProgress?.({
            stage: 'retrying',
            receivedBytes: (await file.stat()).size,
            expectedBytes: asset.sizeBytes,
            attempt,
            resumed,
            reason:
              failure instanceof LocalCommandError
                ? failure.code
                : 'RUNTIME_DOWNLOAD_CONNECTION_FAILED',
          });
        } finally {
          clearTimeout(idle);
          requestAbort.abort();
          await reader?.cancel().catch(() => undefined);
          reader?.releaseLock();
        }
        await delay(attempt * 250, undefined, { signal: budget });
      }
    } finally {
      await file.close();
    }
  } finally {
    if (locked) lock.exec('ROLLBACK');
    lock.close();
  }
}
