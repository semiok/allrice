import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { downloadManagedRuntimeAsset } from './runtime-asset-download.js';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const bytes = Buffer.from(
  'fixed native runtime software archive, verified in full',
);
async function fixture(handler: RequestListener) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-resume-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const port = (server.address() as { port: number }).port;
  return {
    root,
    path: join(root, 'payload'),
    asset: {
      fileName: 'payload',
      url: `http://127.0.0.1:${port}/payload`,
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}
it('retries a dropped response from its exact saved offset and validates all bytes', async () => {
  const calls: Record<string, string | string[] | undefined>[] = [];
  let drop: (() => void) | undefined;
  const f = await fixture((req, res) => {
    calls.push({
      range: req.headers.range,
      validator: req.headers['if-range'],
    });
    if (calls.length === 1) {
      res.writeHead(200, { 'Content-Length': bytes.length, ETag: '"fixed"' });
      res.write(bytes.subarray(0, 9));
      drop = () => res.destroy();
      return;
    }
    res.writeHead(206, {
      'Content-Range': `bytes 9-${bytes.length - 1}/${bytes.length}`,
      'Content-Length': bytes.length - 9,
      ETag: '"fixed"',
    });
    res.end(bytes.subarray(9));
  });
  await downloadManagedRuntimeAsset(
    f.path,
    f.asset,
    new AbortController().signal,
    {
      onProgress: (s) => {
        if (s.receivedBytes === 9 && s.attempt === 1) drop?.();
      },
    },
  );
  expect(calls).toEqual([
    { range: undefined, validator: undefined },
    { range: 'bytes=9-', validator: '"fixed"' },
  ]);
  expect(await readFile(f.path)).toEqual(bytes);
  expect(
    (await readdir(f.root)).some(
      (x) => x.endsWith('.part') || x.endsWith('.json'),
    ),
  ).toBe(false);
});
it.each([true, false])(
  'retains canceled bytes across a new invocation; Range supported=%s',
  async (rangeSupported) => {
    const abort = new AbortController();
    let calls = 0;
    const ranges: (string | undefined)[] = [];
    const f = await fixture((req, res) => {
      ranges.push(req.headers.range);
      calls++;
      if (calls === 1) {
        res.writeHead(200, { 'Content-Length': bytes.length, ETag: '"fixed"' });
        res.write(bytes.subarray(0, 12));
        return;
      }
      if (rangeSupported) {
        res.writeHead(206, {
          'Content-Range': `bytes 12-${bytes.length - 1}/${bytes.length}`,
          'Content-Length': bytes.length - 12,
          ETag: '"fixed"',
        });
        res.end(bytes.subarray(12));
      } else {
        res.writeHead(200, { 'Content-Length': bytes.length, ETag: '"fixed"' });
        res.end(bytes);
      }
    });
    await expect(
      downloadManagedRuntimeAsset(f.path, f.asset, abort.signal, {
        onProgress: (s) => {
          if (s.receivedBytes === 12) abort.abort();
        },
      }),
    ).rejects.toThrow();
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await downloadManagedRuntimeAsset(
      f.path,
      f.asset,
      new AbortController().signal,
    );
    expect(ranges).toEqual([undefined, 'bytes=12-']);
    expect(await readFile(f.path)).toEqual(bytes);
  },
);
it.each(['range', 'etag', 'checksum'])(
  'does not activate an invalid %s response',
  async (kind) => {
    let calls = 0;
    const f = await fixture((_req, res) => {
      calls++;
      if (calls === 1 && kind !== 'checksum') {
        res.writeHead(200, { 'Content-Length': bytes.length, ETag: '"fixed"' });
        res.write(bytes.subarray(0, 9));
        setTimeout(() => res.destroy(), 20);
        return;
      }
      if (kind === 'checksum') {
        res.writeHead(200, { 'Content-Length': bytes.length });
        res.end(Buffer.alloc(bytes.length, 120));
        return;
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${kind === 'range' ? 8 : 9}-${bytes.length - 1}/${bytes.length}`,
        'Content-Length': bytes.length - 9,
        ETag: kind === 'etag' ? '"changed"' : '"fixed"',
      });
      res.end(bytes.subarray(9));
    });
    await expect(
      downloadManagedRuntimeAsset(
        f.path,
        f.asset,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code:
        kind === 'checksum'
          ? 'RUNTIME_CHECKSUM_MISMATCH'
          : 'RUNTIME_DOWNLOAD_RANGE_INVALID',
    });
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);
it('serializes concurrent writers and releases its lock after cancellation', async () => {
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r)),
    abort = new AbortController();
  const f = await fixture((_req, res) => {
    res.writeHead(200, { 'Content-Length': bytes.length });
    res.write(bytes.subarray(0, 8));
    entered();
  });
  const first = downloadManagedRuntimeAsset(
    f.path,
    f.asset,
    abort.signal,
  ).catch((e) => e);
  await ready;
  await expect(
    downloadManagedRuntimeAsset(f.path, f.asset, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'RUNTIME_DOWNLOAD_BUSY' });
  abort.abort();
  await first;
  const canceled = AbortSignal.abort();
  await expect(
    downloadManagedRuntimeAsset(f.path, f.asset, canceled),
  ).rejects.toThrow();
});
it('rejects a partial-file symlink without changing its target', async () => {
  const f = await fixture((_req, res) => res.end(bytes));
  const target = join(f.root, 'must-preserve');
  await writeFile(target, 'private');
  await symlink(target, `${f.path}.${f.asset.sha256}.part`);
  await expect(
    downloadManagedRuntimeAsset(f.path, f.asset, new AbortController().signal),
  ).rejects.toThrow();
  expect(await readFile(target, 'utf8')).toBe('private');
});
it('does not fetch a previously verified archive', async () => {
  let calls = 0;
  const f = await fixture((_req, res) => {
    calls++;
    res.end(bytes);
  });
  await writeFile(f.path, bytes, { mode: 0o600 });
  await downloadManagedRuntimeAsset(
    f.path,
    f.asset,
    new AbortController().signal,
  );
  expect(calls).toBe(0);
});
