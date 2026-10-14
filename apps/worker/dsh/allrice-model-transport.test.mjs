/* global fetch */
import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  createModelTransport,
  installModelTransportObservation,
} from './allrice-model-transport.mjs';

describe('request-scoped transport observation', () => {
  it('closes only the abandoned stream and never stores response contents', async () => {
    installModelTransportObservation();
    const responses = [];
    const server = createServer((_req, res) => {
      responses.push(res);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': keep-alive\n\n');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const url = `http://127.0.0.1:${server.address().port}/`;
      const a = createModelTransport(),
        b = createModelTransport();
      const responseA = await a.run(() => fetch(url));
      const responseB = await b.run(() => fetch(url));
      const ra = responseA.body.getReader(),
        rb = responseB.body.getReader();
      await ra.read();
      await rb.read();
      expect(a.snapshot(0)).toMatchObject({
        state: 'heartbeat_only',
        heartbeats: 1,
      });
      a.stop();
      await ra.read().catch(() => {});
      expect(a.locallyClosed()).toBe(true);
      const secret = 'SYNTHETIC_PRIVATE_CONTENT';
      responses[1].end(
        `data: ${JSON.stringify({ type: 'response.completed', secret })}\n\n`,
      );
      expect((await rb.read()).done).toBe(false);
      await rb.read();
      expect(b.snapshot(0).terminalEvent).toBe(true);
      expect(JSON.stringify(b.snapshot(0))).not.toContain(secret);
      expect(b.locallyClosed()).toBe(true);
      b.stop();
      // A late SDK reconnect in the abandoned async scope cannot dispatch.
      await expect(a.run(() => fetch(url))).rejects.toThrow(
        'allrice_model_request_stopped',
      );
      expect(responses).toHaveLength(2);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
