import { spawn } from 'node:child_process';
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
import { createServer as createTcpServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const cancelDownloadChild = String.raw`
const [moduleUrl, path, assetJson] = process.argv.slice(1);
const { downloadManagedRuntimeAsset } = await import(moduleUrl);
const abort = new AbortController();
const reason = new Error('fixture-caller-abort');
const cancel = () => {
  process.stdin.pause();
  abort.abort(reason);
};
process.stdin.once('data', cancel);
let promiseRejected = false;
let sameCallerReason = false;
try {
  await downloadManagedRuntimeAsset(path, JSON.parse(assetJson), abort.signal);
} catch (error) {
  promiseRejected = true;
  sameCallerReason = error === reason;
} finally {
  process.stdin.removeListener('data', cancel);
  process.stdin.pause();
}
process.stdout.write(JSON.stringify({
  promiseRejected,
  sameCallerReason,
  activeTCP: process.getActiveResourcesInfo().filter((kind) => kind === 'TCPSocketWrap').length,
}) + '\n');
if (!promiseRejected || !sameCallerReason) process.exitCode = 1;
`;

it.each(['HTTP preheaders', 'stalled TLS'] as const)(
  'closes canceled pre-response downloads and exits naturally (%s)',
  async (stage) => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-cancel-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    let reachedStage!: () => void;
    const ready = new Promise<void>((resolve) => (reachedStage = resolve));
    const sockets = new Set<Socket>();
    const socketCloses: Promise<void>[] = [];
    const server =
      stage === 'HTTP preheaders'
        ? createServer(() => reachedStage())
        : createTcpServer((socket) =>
            socket.once('data', () => reachedStage()),
          );
    server.on('connection', (socket: Socket) => {
      sockets.add(socket);
      socket.on('error', () => {
        // Caller cancellation may reset this synthetic accepted connection.
      });
      socketCloses.push(
        new Promise<void>((resolve) =>
          socket.once('close', () => {
            sockets.delete(socket);
            resolve();
          }),
        ),
      );
    });
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('FIXTURE_ADDRESS');
    const path = join(root, 'payload');
    const asset = {
      fileName: 'payload',
      url: `${stage === 'HTTP preheaders' ? 'http' : 'https'}://127.0.0.1:${address.port}/payload`,
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const project = fileURLToPath(new URL('../../../', import.meta.url));
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        cancelDownloadChild,
        new URL('./runtime-asset-download.ts', import.meta.url).href,
        path,
        JSON.stringify(asset),
      ],
      {
        cwd: project,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          TSX_TSCONFIG_PATH: join(project, 'tsconfig.base.json'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let cleanupKill = false;
    let naturalClose = false;
    let spawnFailed = false;
    let stdinFailed = false;
    let stdout = '';
    let rejected: unknown = null;
    child.on('error', () => (spawnFailed = true));
    child.stdin.on('error', () => (stdinFailed = true));
    child.stderr.resume();
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (!stdout.includes('\n')) return;
      try {
        const value = JSON.parse(stdout);
        if (
          typeof value.promiseRejected === 'boolean' &&
          typeof value.sameCallerReason === 'boolean' &&
          Number.isSafeInteger(value.activeTCP) &&
          value.activeTCP >= 0
        )
          rejected = {
            promiseRejected: value.promiseRejected,
            sameCallerReason: value.sameCallerReason,
            activeTCP: value.activeTCP,
          };
      } catch {
        // Only the fixed child observation is evidence, never raw output.
      }
    });
    const closed = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) =>
        child.once('close', (code, signal) => {
          naturalClose = !cleanupKill;
          resolve({ code, signal });
        }),
    );
    const bounded = async <T>(work: Promise<T>, ms: number, phase: string) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  Error(
                    JSON.stringify({
                      phase,
                      rejected,
                      openSockets: sockets.size,
                      naturalClose,
                      spawnFailed,
                      stdinFailed,
                    }),
                  ),
                ),
              ms,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        cleanupKill = true;
        child.kill('SIGKILL');
      }
      await bounded(closed, 5_000, 'cleanup');
    });
    await bounded(
      Promise.race([
        ready,
        closed.then(() => {
          throw Error('FIXTURE_CHILD_ENDED_BEFORE_REQUEST');
        }),
      ]),
      10_000,
      'request-stage',
    );
    child.stdin.end('x');
    const outcome = await bounded(
      closed.then(async (result) => {
        await Promise.all(socketCloses);
        return result;
      }),
      5_000,
      'canceled-connection-close',
    );
    expect(rejected).toMatchObject({
      promiseRejected: true,
      sameCallerReason: true,
    });
    expect(outcome).toEqual({ code: 0, signal: null });
    expect(naturalClose).toBe(true);
    expect(spawnFailed).toBe(false);
    expect(stdinFailed).toBe(false);
    expect(sockets.size).toBe(0);
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  },
  20_000,
);

it('rejects URL credentials without sending an authenticated asset request', async () => {
  let calls = 0;
  const f = await fixture((_req, res) => {
    calls++;
    res.end(bytes);
  });
  const url = new URL(f.asset.url);
  url.username = 'fixture';
  url.password = 'fixture';
  await expect(
    downloadManagedRuntimeAsset(
      f.path,
      { ...f.asset, url: url.href },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'RUNTIME_DOWNLOAD_CONNECTION_FAILED' });
  expect(calls).toBe(0);
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('classifies a dropped response body as a connection failure after all retries', async () => {
  let calls = 0;
  let drop: (() => void) | undefined;
  const f = await fixture((_req, res) => {
    calls++;
    res.writeHead(200, { 'Content-Length': bytes.length, ETag: '"fixed"' });
    res.write(bytes.subarray(0, 8));
    drop = () => res.destroy();
  });
  await expect(
    downloadManagedRuntimeAsset(f.path, f.asset, new AbortController().signal, {
      onProgress: (state) => {
        if (state.stage === 'downloading' && state.receivedBytes === 8)
          drop?.();
      },
    }),
  ).rejects.toMatchObject({ code: 'RUNTIME_DOWNLOAD_CONNECTION_FAILED' });
  expect(calls).toBe(3);
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
});
