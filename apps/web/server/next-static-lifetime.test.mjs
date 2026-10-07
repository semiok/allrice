import { createServer, request } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { setImmediate } from 'node:timers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDevRequestHandler } from './dev-maintenance.mjs';

// Load the actual installed Next/send implementation, including the pinned
// pnpm patch. A mock handler cannot prove native filesystem-stream closure.
const require = createRequire(import.meta.url);
const { serveStatic } = require('next/dist/server/serve-static.js');
const { pipeToNodeResponse } = require('next/dist/server/pipe-readable.js');
const send = require('next/dist/compiled/send');
const servers = [],
  folders = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true });
});
async function fixture(handle) {
  const folder = await mkdtemp(join(tmpdir(), 'allrice-next-lifetime-'));
  folders.push(folder);
  const path = join(folder, 'asset.bin');
  await writeFile(path, Buffer.alloc(8 * 1024 * 1024, 42));
  let finished = 0,
    handlerSettled = false;
  const errors = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const lifecycle = {
    enabled: true,
    async run(_, body) {
      try {
        await body();
        finished++;
      } catch (error) {
        errors.push(error);
        throw error;
      } finally {
        resolveDone();
      }
    },
  };
  const server = createServer(
    createDevRequestHandler(lifecycle, async (req, res) => {
      await handle(req, res, path, folder);
      handlerSettled = true;
    }),
  );
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    done,
    errors,
    counts: () => ({ finished, handlerSettled }),
  };
}
async function abortAfterChunk(url) {
  await new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      res.once('data', () => {
        req.destroy();
        resolve();
      });
    });
    req.on('error', (error) => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
    req.end();
  });
}
describe('Pinned native Next response lifetime', () => {
  it('joins actual filesystem close after an aborted static transfer', async () => {
    const streams = [];
    const prototype = send({}).constructor.prototype;
    const emit = prototype.emit;
    vi.spyOn(prototype, 'emit').mockImplementation(function (event, ...args) {
      if (event === 'stream') streams.push(args[0]);
      return emit.call(this, event, ...args);
    });
    const s = await fixture((req, res, path) => serveStatic(req, res, path));
    await abortAfterChunk(s.url + '/asset.bin');
    await s.done;
    expect(s.counts()).toEqual({ finished: 1, handlerSettled: true });
    expect(streams).toHaveLength(1);
    expect(streams[0].closed).toBe(true);
    expect(streams[0].fd).toBeNull();
  });
  it('preserves full GET, HEAD and conditional 304 completion', async () => {
    const s = await fixture((req, res, path) => serveStatic(req, res, path));
    const first = await globalThis.fetch(s.url + '/asset.bin');
    expect((await first.arrayBuffer()).byteLength).toBe(8 * 1024 * 1024);
    expect(first.status).toBe(200);
    const head = await globalThis.fetch(s.url + '/asset.bin', {
      method: 'HEAD',
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    // fetch inserts cache-control:no-cache for conditional headers, which
    // intentionally defeats send's freshness check. Use actual raw HTTP.
    const cached = await new Promise((resolve, reject) => {
      const req = request(
        s.url + '/asset.bin',
        {
          headers: { 'if-none-match': first.headers.get('etag') },
        },
        (res) => {
          res.resume();
          res.once('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(cached).toBe(304);
    await s.done;
    await vi.waitFor(() => expect(s.counts().finished).toBe(3));
  });
  it('preserves native missing-file and directory rejection for the router', async () => {
    const errors = [];
    const s = await fixture(async (req, res, path, folder) => {
      try {
        await serveStatic(
          req,
          res,
          req.url === '/directory' ? folder : path + '.missing',
        );
      } catch (error) {
        errors.push(error.code);
        res.writeHead(404);
        res.end('missing');
      }
    });
    expect((await globalThis.fetch(s.url + '/missing')).status).toBe(404);
    expect((await globalThis.fetch(s.url + '/directory')).status).toBe(404);
    await vi.waitFor(() => expect(s.counts().finished).toBe(2));
    expect(errors).toEqual(['ENOENT', 'ENOENT']);
  });
  it('native streaming abort returns without dropping the source cancel promise', async () => {
    let canceled = false;
    const s = await fixture((_, res) =>
      pipeToNodeResponse(
        new globalThis.ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(64 * 1024));
          },
          async cancel() {
            await new Promise((resolve) => setImmediate(resolve));
            canceled = true;
          },
        }),
        res,
      ),
    );
    await abortAfterChunk(s.url + '/stream');
    await s.done;
    expect(s.errors).toEqual([]);
    expect(canceled).toBe(true);
    expect(s.counts()).toEqual({ finished: 1, handlerSettled: true });
  });

  it('streaming close still waits for an actual waitUntil continuation', async () => {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let wrote = false;
    const s = await fixture((_, res) =>
      pipeToNodeResponse(
        new globalThis.ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(64));
            controller.close();
          },
        }),
        res,
        held.then(() => {
          wrote = true;
        }),
      ),
    );
    await abortAfterChunk(s.url + '/stream');
    await new Promise((resolve) => setImmediate(resolve));
    expect(wrote).toBe(false);
    expect(s.counts().finished).toBe(0);
    release();
    await s.done;
    expect(s.errors).toEqual([]);
    expect(wrote).toBe(true);
    expect(s.counts()).toEqual({ finished: 1, handlerSettled: true });
  });
});
