import { createServer, type RequestListener } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalBrowserHttpAuthority } from './local-browser-client.js';
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
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
