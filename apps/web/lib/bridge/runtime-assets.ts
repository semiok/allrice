import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  managedPythonPayloadForPlatform,
  managedNodePayloadForPlatform,
} from '@allrice/contracts';

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
  const release = platform
    ? [
        managedPythonPayloadForPlatform(platform),
        managedNodePayloadForPlatform(platform),
      ].find(
        (item) =>
          item &&
          archive ===
            `${item.archive.sha256.slice('sha256:'.length)}.docker.tar.gz`,
      )
    : null;
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

/** Range is available only for the already-open, hash-verified fixed archive. */
export async function managedRuntimeAssetResponse(
  request: Request,
  asset: NonNullable<Awaited<ReturnType<typeof openManagedPythonPayload>>>,
) {
  const size = asset.release.archive.sizeBytes;
  const etag = `"${asset.release.archive.sha256}"`;
  const headers = new Headers({
    'Content-Type': 'application/gzip',
    'Content-Length': String(size),
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'X-Allrice-Checksum': asset.release.archive.sha256,
    'Accept-Ranges': 'bytes',
    ETag: etag,
  });
  let start = 0,
    end = size - 1,
    status = 200;
  const range = request.headers.get('range');
  const validator = request.headers.get('if-range');
  if (
    request.method !== 'HEAD' &&
    range &&
    (!validator || validator === etag)
  ) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      if (!match[1]) start = Math.max(0, size - Number(match[2]));
      else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      }
    }
    if (
      !match ||
      (!match[1] && !match[2]) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= size ||
      end < start ||
      (!match[1] && Number(match[2]) <= 0)
    ) {
      await asset.handle.close();
      headers.set('Content-Range', `bytes */${size}`);
      headers.set('Content-Length', '0');
      return new Response(null, { status: 416, headers });
    }
    status = 206;
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    headers.set('Content-Length', String(end - start + 1));
  }
  if (request.method === 'HEAD') {
    await asset.handle.close();
    return new Response(null, { headers });
  }
  return new Response(
    Readable.toWeb(
      asset.handle.createReadStream({ start, end, autoClose: true }),
    ) as ReadableStream<Uint8Array>,
    { status, headers },
  );
}
