import { once, getEventListeners } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamProjectLogs } from './project-logs.js';

const id = 'a'.repeat(64);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function daemon(reply: RequestListener) {
  const root = await mkdtemp(join(tmpdir(), 'rice-project-logs-'));
  const socket = join(root, 'engine.sock');
  const server = createServer(reply);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  server.listen(socket);
  await once(server, 'listening');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return socket;
}

function frame(bytes = Buffer.from('ready')) {
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}

describe('shared Engine log stream settlement', () => {
  it('preserves split frame decoding and releases the abort listener on success', async () => {
    const bytes = frame();
    const socket = await daemon((_req, res) => {
      res.write(bytes.subarray(0, 5));
      setImmediate(() => res.end(bytes.subarray(5)));
    });
    const cancel = new AbortController();
    const receive = vi.fn();
    await streamProjectLogs(socket, id, receive, 1000, cancel.signal);
    expect(receive).toHaveBeenCalledWith(Buffer.from('ready'));
    expect(getEventListeners(cancel.signal, 'abort')).toHaveLength(0);
    cancel.abort();
  });

  it('does not create a request for an already aborted signal', async () => {
    const received = vi.fn<RequestListener>((_req, res) => res.end());
    const socket = await daemon(received);
    const cancel = new AbortController();
    const reason = Error('cancel before request');
    cancel.abort(reason);
    await expect(
      streamProjectLogs(socket, id, vi.fn(), 1000, cancel.signal),
    ).rejects.toBe(reason);
    expect(received).not.toHaveBeenCalled();
  });

  it('rejects reentrant receiver cancellation before queued end without a late socket error', async () => {
    const socket = await daemon((_req, res) => res.end(frame()));
    const cancel = new AbortController();
    const reason = Error('cancel from receiver');
    await expect(
      streamProjectLogs(
        socket,
        id,
        () => cancel.abort(reason),
        1000,
        cancel.signal,
      ),
    ).rejects.toBe(reason);
    await new Promise((resolve) => setImmediate(resolve));
    expect(getEventListeners(cancel.signal, 'abort')).toHaveLength(0);
  });

  it('rejects a complete over-limit response before queued end without an uncaught socket error', async () => {
    const bytes = Buffer.concat([
      frame(Buffer.alloc(250_000)),
      frame(Buffer.alloc(250_000)),
    ]);
    const socket = await daemon((_req, res) => {
      res.setHeader('content-length', bytes.length);
      res.end(bytes);
    });
    await expect(
      streamProjectLogs(socket, id, vi.fn(), 1000),
    ).rejects.toMatchObject({ code: 'DAEMON_OUTPUT_LIMIT' });
    await new Promise((resolve) => setImmediate(resolve));
  });

  it.each([
    { bytes: Buffer.from([1]), code: 'DAEMON_OUTPUT_INCOMPLETE' },
    { bytes: Buffer.alloc(8), code: 'DAEMON_INVALID_FRAME' },
    {
      bytes: (() => {
        const header = frame().subarray(0, 8);
        header.writeUInt32BE(250_001, 4);
        return header;
      })(),
      code: 'DAEMON_INVALID_FRAME',
    },
  ])(
    'retains $code for a complete invalid response',
    async ({ bytes, code }) => {
      const socket = await daemon((_req, res) => res.end(bytes));
      const cancel = new AbortController();
      await expect(
        streamProjectLogs(socket, id, vi.fn(), 1000, cancel.signal),
      ).rejects.toMatchObject({ code });
      expect(getEventListeners(cancel.signal, 'abort')).toHaveLength(0);
      await new Promise((resolve) => setImmediate(resolve));
    },
  );

  it('preserves receiver failure without silently resolving the complete frame', async () => {
    const socket = await daemon((_req, res) => res.end(frame()));
    await expect(
      streamProjectLogs(
        socket,
        id,
        () => {
          throw Error('invalid output');
        },
        1000,
      ),
    ).rejects.toMatchObject({ code: 'DAEMON_INVALID_OUTPUT' });
  });

  it('preserves unsuccessful HTTP rejection and removes cancellation listeners', async () => {
    const socket = await daemon((_req, res) => {
      res.statusCode = 503;
      res.end();
    });
    const cancel = new AbortController();
    await expect(
      streamProjectLogs(socket, id, vi.fn(), 1000, cancel.signal),
    ).rejects.toMatchObject({ code: 'DAEMON_LOGS_UNAVAILABLE' });
    expect(getEventListeners(cancel.signal, 'abort')).toHaveLength(0);
  });

  it('closes the real stream at its absolute deadline despite valid output', async () => {
    let closed!: () => void;
    const observedClose = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const socket = await daemon((_req, res) => {
      res.write(frame());
      const timer = setInterval(() => res.write(frame()), 2);
      res.once('close', () => {
        clearInterval(timer);
        closed();
      });
    });
    const cancel = new AbortController();
    await expect(
      streamProjectLogs(socket, id, vi.fn(), 30, cancel.signal),
    ).rejects.toMatchObject({ code: 'DAEMON_TIMEOUT' });
    await observedClose;
    expect(getEventListeners(cancel.signal, 'abort')).toHaveLength(0);
  });
});
