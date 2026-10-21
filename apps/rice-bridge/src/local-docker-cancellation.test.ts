import { once, getEventListeners } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalDockerApi } from './local-docker-api.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function daemon(reply: RequestListener) {
  const root = await mkdtemp(join(tmpdir(), 'rice-docker-cancel-'));
  const socket = join(root, 'engine.sock');
  const server = createServer(reply);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  server.listen(socket);
  await once(server, 'listening');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return new LocalDockerApi(socket);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function frame(text: string) {
  const bytes = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}

describe('local Engine cancellation and absolute deadlines', () => {
  it('retains the existing JSON and logs argument lists', async () => {
    const api = await daemon((req, res) =>
      res.end(req.url?.includes('/logs?') ? frame('ready') : '{"ready":true}'),
    );
    await expect(api.json('GET', '/info', undefined, 1000)).resolves.toEqual({
      ready: true,
    });
    const receive = vi.fn();
    await api.logs('a'.repeat(64), receive, 1000);
    expect(
      Buffer.concat(receive.mock.calls.map(([bytes]) => bytes)).toString(),
    ).toBe('ready');
  });

  it('sends neither request for an already canceled caller', async () => {
    const received = vi.fn<RequestListener>((_req, res) => res.end('{}'));
    const api = await daemon(received);
    const cancel = new AbortController();
    const reason = Error('owned cancellation');
    cancel.abort(reason);
    await expect(
      api.json('GET', '/info', undefined, 1000, cancel.signal),
    ).rejects.toBe(reason);
    await expect(
      api.logs('a'.repeat(64), vi.fn(), 1000, cancel.signal),
    ).rejects.toBe(reason);
    expect(received).not.toHaveBeenCalled();
    expect(getEventListeners(cancel.signal, 'abort')).toHaveLength(0);
  });

  it.each([false, true])(
    'closes canceled JSON HTTP before/after headers (%s)',
    async (headers) => {
      const reached = deferred(),
        closed = deferred();
      let lateReply!: () => void;
      const api = await daemon((_req, res) => {
        res.once('close', closed.resolve);
        if (headers) {
          res.setHeader('content-type', 'application/json');
          res.write('{"ready":');
        }
        lateReply = () => res.end(headers ? 'true}' : '{"ready":true}');
        reached.resolve();
      });
      const cancel = new AbortController(),
        reason = Error('owned cancellation');
      const result = api.json('GET', '/info', undefined, 1000, cancel.signal);
      const rejected = expect(result).rejects.toBe(reason);
      await reached.promise;
      cancel.abort(reason);
      await rejected;
      await closed.promise;
      lateReply();
      expect(getEventListeners(cancel.signal, 'abort')).toHaveLength(0);
    },
  );

  it('rejects queued JSON success after cancellation and removes the listener', async () => {
    const cancel = new AbortController(),
      reason = Error('owned cancellation');
    const api = await daemon((_req, res) => {
      res.end('{"ready":true}');
      cancel.abort(reason);
    });
    await expect(
      api.json('GET', '/info', undefined, 1000, cancel.signal),
    ).rejects.toBe(reason);
    expect(getEventListeners(cancel.signal, 'abort')).toHaveLength(0);
  });

  it('enforces the JSON deadline despite dribbling bytes', async () => {
    const closed = deferred();
    const api = await daemon((_req, res) => {
      res.write('[');
      const timer = setInterval(() => res.write(' '), 2);
      res.once('close', () => {
        clearInterval(timer);
        closed.resolve();
      });
    });
    const cancel = new AbortController();
    await expect(
      api.json('GET', '/info', undefined, 30, cancel.signal),
    ).rejects.toMatchObject({ code: 'DAEMON_TIMEOUT' });
    await closed.promise;
    expect(getEventListeners(cancel.signal, 'abort')).toHaveLength(0);
  });

  it('removes JSON cancellation listeners on success and daemon failure', async () => {
    const api = await daemon((req, res) => {
      res.statusCode = req.url?.endsWith('/failure') ? 503 : 200;
      res.end('{}');
    });
    const cancel = new AbortController();
    await api.json('GET', '/info', undefined, 1000, cancel.signal);
    expect(getEventListeners(cancel.signal, 'abort')).toHaveLength(0);
    await expect(
      api.json('GET', '/failure', undefined, 1000, cancel.signal),
    ).rejects.toMatchObject({ code: 'DAEMON_HTTP_503' });
    expect(getEventListeners(cancel.signal, 'abort')).toHaveLength(0);
  });

  it('closes a stalled log stream on cancellation', async () => {
    const reached = deferred(),
      closed = deferred();
    const api = await daemon((_req, res) => {
      res.flushHeaders();
      res.once('close', closed.resolve);
      reached.resolve();
    });
    const cancel = new AbortController(),
      reason = Error('owned cancellation');
    const pending = api.logs('a'.repeat(64), vi.fn(), 1000, cancel.signal);
    const rejected = expect(pending).rejects.toBe(reason);
    await reached.promise;
    cancel.abort(reason);
    await rejected;
    await closed.promise;
    expect(getEventListeners(cancel.signal, 'abort')).toHaveLength(0);
  });

  it('does not resolve a complete log response canceled by its receiver', async () => {
    const cancel = new AbortController(),
      reason = Error('owned cancellation');
    const api = await daemon((_req, res) => res.end(frame('complete')));
    await expect(
      api.logs('a'.repeat(64), () => cancel.abort(reason), 1000, cancel.signal),
    ).rejects.toBe(reason);
    expect(getEventListeners(cancel.signal, 'abort')).toHaveLength(0);
  });

  it('bounds an endless valid log stream and releases its listener', async () => {
    const closed = deferred();
    const api = await daemon((_req, res) => {
      res.write(frame('first'));
      const timer = setInterval(() => res.write(frame('more')), 2);
      res.once('close', () => {
        clearInterval(timer);
        closed.resolve();
      });
    });
    const cancel = new AbortController();
    await expect(
      api.logs('a'.repeat(64), vi.fn(), 30, cancel.signal),
    ).rejects.toMatchObject({ code: 'DAEMON_TIMEOUT' });
    await closed.promise;
    expect(getEventListeners(cancel.signal, 'abort')).toHaveLength(0);
  });
});
