/* global fetch, Response, ReadableStream, AbortController, TextEncoder, setTimeout */
import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { ModelStreamDiagnosticSchema } from '@allrice/contracts';
import {
  createModelTransport,
  installModelTransportObservation,
} from './allrice-model-transport.mjs';

describe('request-scoped transport observation', () => {
  it('isolates two real concurrent HTTP scopes and an unscoped request', async () => {
    installModelTransportObservation();
    let count = 0;
    const bodyA = 'data: {"type":"response.completed","value":"PRIVATE_A"}\n\n',
      bodyB = 'data: {"type":"response.created"}\n\n';
    const server = createServer((req, res) => {
      count++;
      setTimeout(
        () => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(req.url === '/a' ? bodyA : bodyB);
        },
        req.url === '/a' ? 80 : 10,
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const a = createModelTransport(),
        b = createModelTransport(),
        base = `http://127.0.0.1:${server.address().port}`;
      await Promise.all([
        a.run(async () => {
          await (await fetch(base + '/a')).text();
        }),
        b.run(async () => {
          await (await fetch(base + '/b')).text();
        }),
        (async () => {
          await (await fetch(base + '/outside')).text();
        })(),
      ]);
      expect(count).toBe(3);
      expect(a.timing().requestCount).toBe(1);
      expect(b.timing().requestCount).toBe(1);
      expect(a.snapshot(0).bytes).toBe(new TextEncoder().encode(bodyA).length);
      expect(b.snapshot(0).bytes).toBe(new TextEncoder().encode(bodyB).length);
      expect(a.timing().httpRequests[0].headersMs).toBeGreaterThan(
        b.timing().httpRequests[0].headersMs + 30,
      );
      expect(JSON.stringify([a.timing(), b.timing()])).not.toMatch(
        /PRIVATE|outside|127\.0\.0\.1/,
      );
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
  it('separates actual HTTP headers, first heartbeat byte and first event without retaining a payload', async () => {
    installModelTransportObservation();
    const server = createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders();
        setTimeout(() => {
          res.write(': ping\n\n');
          setTimeout(
            () =>
              res.end(
                'data: {"type":"response.completed","private":"PRIVATE_BODY"}\n\n',
              ),
            30,
          );
        }, 30);
      }, 30);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const scope = createModelTransport();
      await scope.run(async () => {
        const r = await fetch(
          `http://127.0.0.1:${server.address().port}/PRIVATE_PATH`,
          {
            method: 'POST',
            headers: { authorization: 'Bearer PRIVATE_TOKEN' },
            body: 'PRIVATE_PROMPT',
          },
        );
        await r.text();
      });
      const timing = scope.timing(),
        request = timing.httpRequests[0];
      expect(timing).toMatchObject({
        transport: 'sse',
        requestCount: 1,
        requestsTruncated: false,
      });
      expect(request.headersMs - request.startedMs).toBeGreaterThanOrEqual(20);
      expect(request.firstByteMs - request.headersMs).toBeGreaterThanOrEqual(
        15,
      );
      expect(request.firstEventMs - request.firstByteMs).toBeGreaterThanOrEqual(
        15,
      );
      expect(request.closedMs).toBeGreaterThanOrEqual(request.firstEventMs);
      expect(
        request.connectionStartedMs === null ||
          request.connectionStartedMs >= request.startedMs,
      ).toBe(true);
      expect(JSON.stringify(timing)).not.toMatch(
        /PRIVATE|Bearer|127\.0\.0\.1|http:/,
      );
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
  it('bounds HTTP attempts and leaves unobserved or reused connection details unknown', async () => {
    const scope = createModelTransport();
    for (let i = 0; i < 12; i++)
      await scope.fetch(async () => new Response('ok'), 'private');
    const timing = scope.timing();
    expect(timing.requestCount).toBe(12);
    expect(timing.httpRequests).toHaveLength(8);
    expect(timing.requestsTruncated).toBe(true);
    expect(timing.httpRequests[0]).toMatchObject({
      connectionStartedMs: null,
      connectionReadyMs: null,
      firstByteMs: null,
      firstEventMs: null,
    });
  });
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
