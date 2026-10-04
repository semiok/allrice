import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { RuntimeCommandError as LocalCommandError } from './errors.js';
type Asset = {
  fileName: string;
  url: string;
  sizeBytes: number;
  sha256: string;
  sha512?: string;
};
export async function runtimeAssetMatches(path: string, asset: Asset) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      before.nlink !== 1 ||
      before.mode & 0o022 ||
      before.size !== asset.sizeBytes
    )
      return false;
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

/** Same preparation lifecycle, fixed native releases, resumable only after hash validation. */
export async function downloadManagedRuntimeAsset(
  path: string,
  asset: Asset,
  signal: AbortSignal,
) {
  if (await runtimeAssetMatches(path, asset)) return;
  const temp = join(dirname(path), `${basename(path)}.${randomUUID()}.part`);
  const file = await open(
    temp,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(600_000)]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    let url = new URL(asset.url),
      response: Response | undefined;
    for (let i = 0; i < 5; i++) {
      response = await fetch(url, { redirect: 'manual', signal: bounded });
      if (response.status < 300 || response.status > 399) break;
      await response.body?.cancel();
      const next = new URL(response.headers.get('location') ?? '', url);
      if (
        next.protocol !== 'https:' ||
        ![
          'github.com',
          'release-assets.githubusercontent.com',
          'objects.githubusercontent.com',
          'download.docker.com',
          'raw.githubusercontent.com',
        ].includes(next.hostname)
      )
        throw new LocalCommandError('RUNTIME_DOWNLOAD_REDIRECT_DENIED');
      url = next;
    }
    if (!response?.ok || !response.body)
      throw new LocalCommandError('RUNTIME_DOWNLOAD_UNAVAILABLE');
    reader = response.body.getReader();
    let size = 0;
    const hash = createHash('sha256'),
      sha512 = asset.sha512 ? createHash('sha512') : null;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bounded.throwIfAborted();
      size += next.value.length;
      if (size > asset.sizeBytes)
        throw new LocalCommandError('RUNTIME_DOWNLOAD_LIMIT');
      hash.update(next.value);
      sha512?.update(next.value);
      await file.writeFile(next.value);
    }
    if (
      size !== asset.sizeBytes ||
      hash.digest('hex') !== asset.sha256 ||
      (sha512 && sha512.digest('hex') !== asset.sha512)
    )
      throw new LocalCommandError('RUNTIME_CHECKSUM_MISMATCH');
    await file.sync();
    await file.close();
    bounded.throwIfAborted();
    await rename(temp, path);
  } finally {
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
    await file.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
  }
}
