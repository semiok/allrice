import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { managedPythonPayloadForPlatform } from '@allrice/contracts';

const maxArchiveBytes = 256 * 1024 * 1024;

/** Fixed public software only; neither a user path nor a model-chosen download. */
export async function openManagedPythonPayload(
  architecture: string,
  archive: string,
) {
  const platform =
    architecture === 'linux-amd64'
      ? 'macos-x64'
      : architecture === 'linux-arm64'
        ? 'macos-arm64'
        : null;
  const release = platform ? managedPythonPayloadForPlatform(platform) : null;
  const directory = process.env.ALLRICE_BRIDGE_RUNTIME_ASSET_DIR;
  if (
    !release ||
    !directory ||
    release.archive.sizeBytes > maxArchiveBytes ||
    archive !==
      `${release.archive.sha256.slice('sha256:'.length)}.docker.tar.gz` ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(release.archive.fileName)
  )
    return null;
  let handle;
  try {
    handle = await open(
      join(resolve(directory), release.archive.fileName),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const before = await handle.stat();
    if (!before.isFile() || before.size !== release.archive.sizeBytes)
      throw new Error('asset_size');
    const hash = createHash('sha256'),
      chunk = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, before.size - offset),
        offset,
      );
      if (!bytesRead) throw new Error('asset_truncated');
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      `sha256:${hash.digest('hex')}` !== release.archive.sha256 ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('asset_integrity');
    return { handle, release };
  } catch {
    await handle?.close();
    return null;
  }
}
