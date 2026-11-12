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
import {
  connect as connectTcp,
  createServer as createTcpServer,
  type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
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

const ownedDownloadChild = String.raw`
import { Worker } from 'node:worker_threads';
import { ReadableStreamDefaultReader } from 'node:stream/web';
const [moduleUrl, fixtureJson, mode] = process.argv.slice(1);
const fixture = JSON.parse(fixtureJson);
const abort = new AbortController(), reason = () => {};
let terminated = 0, released = 0, pending = 0, pendingAtAbort = false, worker;
const cancel = () => {
  process.stdin.pause();
  pendingAtAbort = pending > 0;
  abort.abort(reason);
};
const emit = Worker.prototype.emit, post = Worker.prototype.postMessage;
const terminate = Worker.prototype.terminate, read = ReadableStreamDefaultReader.prototype.read;
Worker.prototype.emit = function(event, ...args) {
  if (event === 'message' && args[0]?.status) {
    worker = this;
    if (mode === 'headers-abort') cancel();
  }
  const result = Reflect.apply(emit, this, [event, ...args]);
  if (event === 'message' && args[0]?.status && mode === 'worker-exit') this.postMessage('fixture-exit');
  return result;
};
Worker.prototype.postMessage = function(value, ...args) {
  const result = Reflect.apply(post, this, [value, ...args]);
  if (value === 'release') {
    released++;
    if (mode === 'eof-abort') cancel();
  }
  return result;
};
Worker.prototype.terminate = function(...args) {
  terminated++;
  return Reflect.apply(terminate, this, args);
};
ReadableStreamDefaultReader.prototype.read = function(...args) {
  pending++;
  return Reflect.apply(read, this, args).finally(() => pending--);
};
const stage = value => process.stdout.write(JSON.stringify({ stage: value }) + '\n');
const { downloadManagedRuntimeAsset } = await import(moduleUrl);
process.stdin.once('data', cancel);
let success = false, sameCallerReason = false, errorCode = null, peerSuccess = false;
const peer = fixture.peer && downloadManagedRuntimeAsset(fixture.peer.path, fixture.peer.asset, new AbortController().signal).then(() => peerSuccess = true);
try {
  await downloadManagedRuntimeAsset(fixture.path, fixture.asset, abort.signal, {
    onBytes() {
      stage('body');
      if (mode === 'worker-error-body') worker.postMessage('fixture-error');
    },
  });
  success = true;
} catch (error) {
  sameCallerReason = error === reason;
  errorCode = typeof error?.code === 'string' ? error.code : null;
} finally {
  process.stdin.removeListener('data', cancel);
  process.stdin.pause();
}
if (peer) {
  stage('canceled');
  await peer;
}
process.stdout.write(JSON.stringify({ success, sameCallerReason, errorCode, terminated, released, pendingAtAbort, peerSuccess }) + '\n');
`;

async function within<T>(work: Promise<T>, ms: number, phase: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(phase)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function ownedChild(
  f: Awaited<ReturnType<typeof fixture>>,
  mode = 'success',
  options: {
    args?: string[];
    env?: Record<string, string>;
    peer?: Awaited<ReturnType<typeof fixture>>;
  } = {},
) {
  const project = fileURLToPath(new URL('../../../', import.meta.url));
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      ...(options.args ?? []),
      '--input-type=module',
      '--eval',
      ownedDownloadChild,
      new URL('./runtime-asset-download.ts', import.meta.url).href,
      JSON.stringify({ ...f, peer: options.peer }),
      mode,
    ],
    {
      cwd: project,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        TSX_TSCONFIG_PATH: join(project, 'tsconfig.base.json'),
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const stages = new Set<string>();
  const waiting = new Map<string, () => void>();
  let output = '',
    killed = false,
    natural = false,
    ioFailed = false;
  let result: Record<string, unknown> | undefined;
  child.on('error', () => (ioFailed = true));
  child.stdin.on('error', () => (ioFailed = true));
  child.stderr.resume();
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
    while (output.includes('\n')) {
      const end = output.indexOf('\n');
      const line = JSON.parse(output.slice(0, end));
      output = output.slice(end + 1);
      if (typeof line.stage === 'string') {
        stages.add(line.stage);
        waiting.get(line.stage)?.();
      } else result = line;
    }
  });
  const closed = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) =>
      child.once('close', (code, signal) => {
        natural = !killed;
        resolve({ code, signal });
      }),
  );
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      killed = true;
      child.kill('SIGKILL');
    }
    await within(closed, 5_000, 'owned-child-cleanup');
  });
  return {
    cancel: () => child.stdin.end('cancel'),
    observation: () => ({
      childDone: natural,
      resultReady: result !== undefined,
      ioFailed,
    }),
    stage: (name: string) =>
      within(
        Promise.race([
          stages.has(name)
            ? Promise.resolve()
            : new Promise<void>((resolve) => waiting.set(name, resolve)),
          closed.then(() => {
            throw Error('OWNED_CHILD_ENDED_BEFORE_STAGE');
          }),
        ]),
        10_000,
        `owned-child-${name}`,
      ),
    async done() {
      expect(await within(closed, 5_000, 'owned-child-natural-close')).toEqual({
        code: 0,
        signal: null,
      });
      expect(natural).toBe(true);
      expect(ioFailed).toBe(false);
      expect(result).toBeDefined();
      return result!;
    },
  };
}

it.each(['disabled', 'env', 'cli', 'node-options', 'no-proxy'])(
  'preserves native startup proxy routing and natural EOF (%s)',
  async (mode) => {
    let targetCalls = 0,
      proxied = 0,
      forwarded = 0;
    const f = await fixture((_req, res) => {
      targetCalls++;
      res.end(bytes);
    });
    const target = new URL(f.asset.url);
    const proxy = createServer((_req, res) => {
      forwarded++;
      res.end(bytes);
    });
    const connections = new Set<Duplex>();
    const track = (socket: Duplex) => {
      connections.add(socket);
      socket.on('error', () => undefined);
      socket.once('close', () => connections.delete(socket));
    };
    proxy.on('connect', (req, socket, head) => {
      expect(req.url).toBe(target.host);
      proxied++;
      const upstream = connectTcp({
        host: target.hostname,
        port: Number(target.port),
      });
      track(socket);
      track(upstream);
      socket.once('close', () => upstream.destroy());
      upstream.once('close', () => socket.destroy());
      upstream.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
    });
    cleanups.push(async () => {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const port = (proxy.address() as { port: number }).port;
    const child = ownedChild(f, 'success', {
      args: mode === 'cli' ? ['--use-env-proxy'] : [],
      env: {
        HTTP_PROXY: `http://127.0.0.1:${port}`,
        ...(mode === 'env' || mode === 'no-proxy'
          ? { NODE_USE_ENV_PROXY: '1' }
          : {}),
        ...(mode === 'node-options' ? { NODE_OPTIONS: '--use-env-proxy' } : {}),
        ...(mode === 'no-proxy' ? { NO_PROXY: '127.0.0.1' } : {}),
      },
    });
    expect(await child.done()).toMatchObject({
      success: true,
      terminated: 0,
      released: 1,
    });
    expect(targetCalls).toBe(1);
    expect(forwarded).toBe(0);
    expect(proxied).toBe(mode === 'disabled' || mode === 'no-proxy' ? 0 : 1);
    expect(await readFile(f.path)).toEqual(bytes);
  },
  20_000,
);

it.each(['CONNECT', 'tunnel TLS'])(
  'closes an explicitly proxied HTTPS owner at %s before naturally exiting',
  async (stage) => {
    const f = await fixture((_req, res) => res.end(bytes));
    f.asset.url = f.asset.url.replace('http:', 'https:');
    let reached!: () => void;
    const ready = new Promise<void>((resolve) => (reached = resolve));
    const proxy = createServer();
    const sockets = new Set<Socket>();
    const closes: Promise<void>[] = [];
    let peerEnded = 0;
    proxy.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      closes.push(
        new Promise<void>((resolve) =>
          socket.once('close', () => {
            sockets.delete(socket);
            resolve();
          }),
        ),
      );
    });
    proxy.on('connect', (_req, socket) => {
      // HTTP upgrades retain allowHalfOpen. Finish our half only after the
      // owned client has sent FIN, and drain so that FIN can be observed.
      socket.once('end', () => {
        peerEnded++;
        socket.end();
      });
      if (stage === 'CONNECT') reached();
      else {
        socket.once('data', () => reached());
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      }
      socket.resume();
    });
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const port = (proxy.address() as { port: number }).port;
    const child = ownedChild(f, 'cancel', {
      env: { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: `http://127.0.0.1:${port}` },
    });
    await within(ready, 10_000, 'proxy-request-stage');
    child.cancel();
    const result = await within(
      Promise.all([child.done(), ...closes]),
      5_000,
      'proxy-canceled-close',
    ).catch((error: unknown) => {
      throw new Error(
        JSON.stringify({
          phase: 'proxy-canceled-close',
          ...child.observation(),
          peerEnded,
          openSockets: sockets.size,
        }),
        { cause: error },
      );
    });
    expect(result[0]).toMatchObject({
      success: false,
      sameCallerReason: true,
      terminated: 1,
    });
    expect(sockets.size).toBe(0);
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
  },
  20_000,
);

it.each(['pending-body', 'headers-abort', 'eof-abort'])(
  'settles the original reader and caller reason at the %s boundary',
  async (mode) => {
    const f = await fixture((_req, res) => {
      res.writeHead(200, { 'Content-Length': bytes.length });
      if (mode === 'eof-abort') res.end(bytes);
      else res.write(bytes.subarray(0, 8));
    });
    const child = ownedChild(f, mode);
    if (mode === 'pending-body') {
      await child.stage('body');
      child.cancel();
    }
    expect(await child.done()).toMatchObject({
      success: false,
      sameCallerReason: true,
      ...(mode === 'pending-body' ? { pendingAtAbort: true } : {}),
      terminated: mode === 'eof-abort' ? 0 : 1,
      released: mode === 'eof-abort' ? 1 : 0,
    });
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
  },
  20_000,
);

it('keeps an unrelated in-process owner alive through pending-read cancellation', async () => {
  let finishPeer!: () => void, peerEntered!: () => void;
  const peerReady = new Promise<void>((resolve) => (peerEntered = resolve));
  const peer = await fixture((_req, res) => {
    res.writeHead(200, { 'Content-Length': bytes.length });
    res.write(bytes.subarray(0, 8));
    finishPeer = () => res.end(bytes.subarray(8));
    peerEntered();
  });
  const f = await fixture((_req, res) => {
    res.writeHead(200, { 'Content-Length': bytes.length });
    res.write(bytes.subarray(0, 8));
  });
  const child = ownedChild(f, 'pending-body', { peer });
  await Promise.all([
    child.stage('body'),
    within(peerReady, 10_000, 'peer-request'),
  ]);
  child.cancel();
  await child.stage('canceled');
  finishPeer();
  expect(await child.done()).toMatchObject({
    success: false,
    sameCallerReason: true,
    pendingAtAbort: true,
    peerSuccess: true,
    terminated: 1,
    released: 1,
  });
  expect(await readFile(peer.path)).toEqual(bytes);
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
}, 20_000);

it.each(['worker-error', 'worker-error-body', 'worker-exit'])(
  'preserves TypeError classification and closes an unexpected %s',
  async (mode) => {
    const f = await fixture((req, res) => {
      const offset = Number(req.headers.range?.match(/\d+/)?.[0] ?? 0);
      res.writeHead(offset ? 206 : 200, {
        'Content-Length': bytes.length - offset,
        ...(offset
          ? {
              'Content-Range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}`,
            }
          : {}),
      });
      res.write(bytes.subarray(offset, offset + 8));
    });
    const preload = join(f.root, 'worker-fault.mjs');
    await writeFile(
      preload,
      `
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
if (!isMainThread && workerData?.url) {
  if (${JSON.stringify(mode)} === 'worker-error') throw new TypeError('fixture-worker-error');
  if (${JSON.stringify(mode)} === 'worker-exit') globalThis.fetch = async () => new Response(new ReadableStream(), { headers: { 'Content-Length': '${bytes.length}' } });
  parentPort.on('message', value => {
    if (value === 'fixture-error') throw new TypeError('fixture-worker-error');
    if (value === 'fixture-exit') { parentPort.removeAllListeners('message'); parentPort.close(); }
  });
}
`,
    );
    const child = ownedChild(f, mode, { args: ['--import', preload] });
    expect(await child.done()).toMatchObject({
      success: false,
      sameCallerReason: false,
      errorCode: 'RUNTIME_DOWNLOAD_CONNECTION_FAILED',
    });
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
  },
  20_000,
);

it.each([404, 302])(
  'releases rejected HTTP %s owners without exiting the parent',
  async (status) => {
    let calls = 0;
    const f = await fixture((_req, res) => {
      calls++;
      res.writeHead(status, {
        'Content-Length': bytes.length,
        Location: 'https://fixture.denied.invalid/payload',
      });
      res.write(bytes.subarray(0, 8));
    });
    const attempts = status === 404 ? 1 : 3;
    expect(await ownedChild(f, 'failure').done()).toMatchObject({
      success: false,
      errorCode:
        status === 404
          ? 'RUNTIME_DOWNLOAD_UNAVAILABLE'
          : 'RUNTIME_DOWNLOAD_REDIRECT_DENIED',
      terminated: attempts,
    });
    expect(calls).toBe(attempts);
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
  },
  20_000,
);
