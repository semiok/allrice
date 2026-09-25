import { createServer, type RequestListener } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBrowserHttpAuthority } from './local-browser-client.js';
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const stop of close.splice(0)) await stop();
});
async function fixture(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  close.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error();
  return new LocalBrowserHttpAuthority({
    server: `http://127.0.0.1:${address.port}`,
    token: 'synthetic-device-token',
  });
}
describe('P22 real HTTP authority transport', () => {
  it('does not wait for a failed response stream to finish cancellation', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), { status: 502 }),
      ),
    );
    const client = new LocalBrowserHttpAuthority({
      server: 'https://saas.example',
      token: 'synthetic',
    });
    await expect(client.claim(randomUUID(), false)).rejects.toThrow(
      'LOCAL_BROWSER_AUTHORITY_UNAVAILABLE',
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each(['caller', 'deadline'])(
    'settles on %s cancellation even when fetch never settles',
    async (kind) => {
      vi.useFakeTimers();
      const fetchMock = vi.fn<typeof fetch>(
        () => new Promise<Response>(() => {}),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = new LocalBrowserHttpAuthority({
        server: 'https://saas.example',
        token: 'synthetic',
      });
      const shutdown = new AbortController();
      const pending = client.claim(randomUUID(), false, false, shutdown.signal);
      const rejected = expect(pending).rejects.toThrow(
        'LOCAL_BROWSER_AUTHORITY_UNAVAILABLE',
      );
      if (kind === 'caller') shutdown.abort();
      else await vi.advanceTimersByTimeAsync(2500);
      await rejected;
      expect(fetchMock.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each(['headers', 'body'])(
    'caller stop aborts an actual pending claim %s',
    async (phase) => {
      let received!: () => void;
      const requestReceived = new Promise<void>((resolve) => {
        received = resolve;
      });
      const client = await fixture((_req, res) => {
        if (phase === 'body') {
          res.writeHead(200);
          res.write('{');
        }
        received();
      });
      const shutdown = new AbortController();
      const pending = client.claim(randomUUID(), false, false, shutdown.signal);
      await requestReceived;
      const stoppedAt = Date.now();
      shutdown.abort();
      await expect(pending).rejects.toThrow(
        'LOCAL_BROWSER_AUTHORITY_UNAVAILABLE',
      );
      expect(Date.now() - stoppedAt).toBeLessThan(1000);
    },
  );
  it('a pre-aborted claim sends no HTTP request and never retries preview', async () => {
    let calls = 0;
    const client = await fixture((_req, res) => {
      calls++;
      res.writeHead(400);
      res.end('{}');
    });
    const shutdown = new AbortController();
    shutdown.abort();
    await expect(
      client.claim(randomUUID(), true, true, shutdown.signal),
    ).rejects.toThrow('LOCAL_BROWSER_AUTHORITY_UNAVAILABLE');
    expect(calls).toBe(0);
  });
  it('rejects a non-OK partial body without waiting for the server to finish it', async () => {
    const client = await fixture((_req, res) => {
      res.writeHead(503);
      res.write('{');
    });
    const began = Date.now();
    await expect(client.claim(randomUUID(), false)).rejects.toThrow(
      'LOCAL_BROWSER_AUTHORITY_UNAVAILABLE',
    );
    expect(Date.now() - began).toBeLessThan(1000);
  });
  it('omits preview capability for ordinary claims, preserving strict P22 servers', async () => {
    const controllerId = randomUUID();
    const client = await fixture(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({
        kind: 'claim',
        controllerId,
        acceptWork: true,
      });
      res.end(
        JSON.stringify({ workspace: null, lease: null, revocations: [] }),
      );
    });
    expect(await client.claim(controllerId, true)).toMatchObject({
      workspace: null,
    });
  });
  it('negotiates unsupported preview only once and retries an ordinary claim, never execution', async () => {
    const requests: Record<string, unknown>[] = [];
    const client = await fixture(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      if (Object.hasOwn(body, 'acceptPreview')) {
        res.writeHead(400);
        res.end('{}');
      } else
        res.end(
          JSON.stringify({ workspace: null, lease: null, revocations: [] }),
        );
    });
    const controllerId = randomUUID();
    await client.claim(controllerId, true, true);
    await client.claim(controllerId, true, true);
    expect(requests).toEqual([
      { kind: 'claim', controllerId, acceptWork: true, acceptPreview: true },
      { kind: 'claim', controllerId, acceptWork: true },
      { kind: 'claim', controllerId, acceptWork: true },
    ]);
  });
  it.each([401, 403, 404, 500])(
    'does not downgrade preview or retry after HTTP %s',
    async (status) => {
      let calls = 0;
      const client = await fixture((_req, res) => {
        calls++;
        res.writeHead(status);
        res.end('{}');
      });
      await expect(client.claim(randomUUID(), true, true)).rejects.toThrow(
        'LOCAL_BROWSER_AUTHORITY_UNAVAILABLE',
      );
      expect(calls).toBe(1);
    },
  );
  it('rejects non-TLS remote authority channels and cannot redirect credentials', async () => {
    expect(
      () =>
        new LocalBrowserHttpAuthority({
          server: 'http://remote.example',
          token: 'synthetic',
        }),
    ).toThrow('LOCAL_BROWSER_AUTHORITY_UNAVAILABLE');
    const client = await fixture((_req, res) => {
      res.writeHead(302, { location: 'https://foreign.example/private' });
      res.end();
    });
    await expect(client.claim(randomUUID(), false)).rejects.toThrow(
      'LOCAL_BROWSER_AUTHORITY_UNAVAILABLE',
    );
  });
  it('sends stable controller id with opt-out and device auth but no raw API error leaks', async () => {
    const client = await fixture(async (req, res) => {
      expect(req.headers.authorization).toBe('Bearer synthetic-device-token');
      const parts = [];
      for await (const part of req) parts.push(part);
      expect(JSON.parse(Buffer.concat(parts).toString())).toMatchObject({
        kind: 'claim',
        acceptWork: false,
      });
      res.writeHead(403);
      res.end(
        JSON.stringify({
          error: { message: 'synthetic-sensitive-server-trace' },
        }),
      );
    });
    await expect(client.claim(randomUUID(), false)).rejects.toThrow(
      'LOCAL_BROWSER_AUTHORITY_UNAVAILABLE',
    );
  });
  it('actual capture bytes and bounded input use fixed authenticated endpoints', async () => {
    const objectId = randomUUID();
    const client = await fixture(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (req.url?.endsWith('/capture')) {
        expect(Buffer.concat(chunks).toString()).toBe('synthetic-image');
        const metadata = JSON.parse(
          Buffer.from(
            String(req.headers['x-allrice-browser-capture']),
            'base64url',
          ).toString(),
        );
        expect(metadata.kind).toBe('screenshot');
        res.end(JSON.stringify({ objectId }));
      } else {
        res.setHeader('content-type', 'application/octet-stream');
        res.end('synthetic-input-too-long');
      }
    });
    expect(
      await client.capture(
        {
          kind: 'screenshot',
          workspaceId: randomUUID(),
          controllerLeaseToken: randomUUID(),
          fence: 1,
          observationId: randomUUID(),
        },
        Buffer.from('synthetic-image'),
      ),
    ).toBe(objectId);
    await expect(
      client.takeInput(
        {
          kind: 'take_input',
          workspaceId: randomUUID(),
          controllerLeaseToken: randomUUID(),
          operationId: randomUUID(),
          operationLeaseToken: randomUUID(),
          inputKind: 'private',
        },
        2,
      ),
    ).rejects.toThrow('LOCAL_BROWSER_AUTHORITY_UNAVAILABLE');
  });
});
