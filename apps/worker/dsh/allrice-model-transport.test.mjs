/* global fetch, Response, ReadableStream, AbortController, TextEncoder */
import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { ModelStreamDiagnosticSchema } from '@allrice/contracts';
import {
  createModelTransport,
  installModelTransportObservation,
} from './allrice-model-transport.mjs';

describe('request-scoped transport observation', () => {
  it('records a real pre-header disconnect without storing the request or inventing SSE activity', async () => {
    installModelTransportObservation();
    let requests = 0;
    const server = createServer((req) => {
      requests++;
      req.socket.destroy();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const scope = createModelTransport();
      await expect(
        scope.run(() =>
          fetch(`http://127.0.0.1:${server.address().port}/private-token`, {
            method: 'POST',
            headers: { authorization: 'Bearer SYNTHETIC_SECRET' },
            body: 'SYNTHETIC_BODY',
          }),
        ),
      ).rejects.toThrow('fetch failed');
      const diagnostic = scope.snapshot(0);
      expect(diagnostic).toMatchObject({
        transport: 'unobserved',
        bytes: 0,
        request: {
          phase: 'request_failed',
          errorCode: 'UND_ERR_SOCKET',
          aborted: false,
          elapsedMs: expect.any(Number),
        },
      });
      expect(requests).toBe(1);
      expect(scope.locallyClosed()).toBe(false);
      expect(
        ModelStreamDiagnosticSchema.safeParse({
          ...diagnostic,
          localCloseConfirmed: false,
          finishSeen: true,
          recoveryEligible: false,
        }).success,
      ).toBe(true);
      expect(JSON.stringify(diagnostic)).not.toMatch(
        /private-token|SYNTHETIC|127\.0\.0\.1|fetch failed/,
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('preserves non-SSE response status/body and isolates concurrent request scopes', async () => {
    const a = createModelTransport(),
      b = createModelTransport();
    const rejected = new Response('private provider response', { status: 503 });
    const ok = new Response('ok');
    const [ra, rb] = await Promise.all([
      a.fetch(async () => rejected, 'unused'),
      b.fetch(async () => ok, 'unused'),
    ]);
    expect(ra).toBe(rejected);
    expect(rb).toBe(ok);
    expect(await ra.text()).toBe('private provider response');
    expect(a.snapshot(0)).toMatchObject({
      transport: 'unobserved',
      request: { phase: 'headers_received', status: 503, aborted: false },
    });
    expect(b.snapshot(0).request.status).toBe(200);
    expect(JSON.stringify(a.snapshot(0))).not.toContain('private');
  });

  it('records a body read failure separately and rethrows the original error', async () => {
    const error = Object.assign(new Error('private body error'), {
      cause: { code: 'ECONNRESET', address: 'private endpoint' },
    });
    let sent = false;
    const scope = createModelTransport();
    const response = await scope.fetch(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (sent) controller.error(error);
              else {
                sent = true;
                controller.enqueue(new TextEncoder().encode(': ping\n\n'));
              }
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      'unused',
    );
    const reader = response.body.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toBe(error);
    expect(scope.snapshot(0)).toMatchObject({
      readFailed: true,
      request: {
        phase: 'body_failed',
        status: 200,
        errorCode: 'ECONNRESET',
        aborted: false,
      },
    });
    expect(JSON.stringify(scope.snapshot(0))).not.toContain('private');
  });

  it('does not execute error getters/proxies or retain arbitrary codes and cyclic causes', async () => {
    const trap = vi.fn(() => {
      throw Error('must_not_execute');
    });
    const getter = Object.defineProperty({}, 'code', { get: trap });
    const cyclic = { code: 'PRIVATE_TOKEN' };
    cyclic.cause = cyclic;
    for (const error of [
      getter,
      new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap }),
      cyclic,
    ]) {
      const scope = createModelTransport();
      let thrown;
      try {
        await scope.fetch(async () => {
          throw error;
        }, 'unused');
      } catch (caught) {
        thrown = caught;
      }
      expect(thrown === error).toBe(true);
      expect(scope.snapshot(0).request).not.toHaveProperty('errorCode');
      expect(JSON.stringify(scope.snapshot(0))).not.toContain('PRIVATE');
    }
    expect(trap).not.toHaveBeenCalled();
  });

  it('keeps caller abort and original thrown error intact without inferring retry permission', async () => {
    const controller = new AbortController();
    const error = Object.freeze(new Error('private stop reason'));
    controller.abort(error);
    const scope = createModelTransport();
    await expect(
      scope.fetch(
        async (_url, { signal }) => {
          signal.throwIfAborted();
        },
        'unused',
        { signal: controller.signal },
      ),
    ).rejects.toBe(error);
    expect(scope.snapshot(0)).toMatchObject({
      transport: 'unobserved',
      request: { phase: 'request_failed', aborted: true },
    });
    expect(scope.locallyClosed()).toBe(false);
  });

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
