/* global Response */
import { once } from 'node:events';
import { URLSearchParams } from 'node:url';
import { WebSocket } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { AllRiceHttpServer } from '../server.mjs';
import { createDEntryNativeGateway } from './d-entry-native.mjs';
import {
  nativeEntryServer,
  deferred,
} from '../../worker/src/d-entry/native-entry.fixture.ts';
import { dEntryClientMount } from '../lib/d-entry/admission.ts';

const cleanups = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
async function fixture() {
  const worker = await nativeEntryServer(),
    server = new AllRiceHttpServer(),
    peers = [];
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const probe = vi.fn(async () =>
    Response.json({
      mount: dEntryClientMount(worker.identity, '4.0', worker.owner.bindingRef),
      controlReady: true,
    }),
  );
  vi.stubEnv('ALLRICE_WORKER_INTERNAL_URL', worker.origin);
  server.dEntryNativeGateway = createDEntryNativeGateway({
    port: server.address().port,
    probe,
  });
  const next = vi.fn((_request, socket) => socket.destroy());
  server.on('upgrade', next);
  cleanups.push(async () => {
    for (const peer of peers) peer.terminate();
    await server.dEntryNativeGateway.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await worker.close();
  });
  return {
    worker,
    server,
    origin,
    probe,
    next,
    connect(extra = {}) {
      const peer = new WebSocket(
        origin.replace('http:', 'ws:') +
          '/api/v1/d-entry/native-mux?' +
          new URLSearchParams({
            organizationId: worker.identity.organizationId,
            ...worker.selection,
          }),
        {
          headers: {
            origin,
            cookie: 'allrice_session=original_browser_session_token',
            ...extra,
          },
        },
      );
      peer.on('error', () => {});
      peers.push(peer);
      return peer;
    },
  };
}

it('uses the same Web listener and original Bearer to Worker, whose Mux gate blocks a browser child write', async () => {
  const f = await fixture(),
    finished = deferred();
  vi.mocked(f.worker.admission.boundary.finish).mockImplementationOnce(
    async () => finished.resolve(),
  );
  const peer = f.connect();
  await once(peer, 'open');
  const closed = once(peer, 'close');
  peer.send(
    JSON.stringify({
      type: 'open',
      streamId: 'write',
      endpoint: 'session/prompt',
      payload: {
        args: {
          request: {
            sessionId: 'dsh-child',
            requestId: 'web-browser',
            mode: 'queue',
            content: [{ type: 'text', text: 'forbidden' }],
          },
        },
      },
    }),
  );
  await closed;
  await finished.promise;
  expect(f.worker.sent).not.toHaveBeenCalled();
  expect(f.next).not.toHaveBeenCalled();
  expect(f.worker.deps.authenticate).toHaveBeenCalledWith(
    'original_browser_session_token',
    {
      organizationId: f.worker.identity.organizationId,
      workspaceId: f.worker.identity.workspaceId,
    },
  );
  const [url, options] = f.probe.mock.calls[0];
  expect(url).toBe(`${f.origin}/api/v1/d-entry/native-owner`);
  expect(options.redirect).toBe('error');
  expect(options.headers.cookie).toBe(
    'allrice_session=original_browser_session_token',
  );
});

it('denies cross-origin or missing-cookie Upgrade without probing or contacting the native owner', async () => {
  const f = await fixture();
  for (const [headers, status] of [
    [{ origin: 'https://foreign.invalid' }, 403],
    [{ cookie: '' }, 401],
  ]) {
    const peer = f.connect(headers);
    const [request, response] = await once(peer, 'unexpected-response');
    expect(response.statusCode).toBe(status);
    response.resume();
    request.destroy();
  }
  expect(f.probe).not.toHaveBeenCalled();
  expect(f.worker.data.acquireMux).not.toHaveBeenCalled();
});

it('keeps a failed authenticated Worker probe unavailable and closes the per-request transports', async () => {
  const f = await fixture();
  f.probe.mockImplementationOnce(async () =>
    Response.json({ error: 'unbound' }, { status: 503 }),
  );
  const peer = f.connect();
  const [request, response] = await once(peer, 'unexpected-response');
  expect(response.statusCode).toBe(503);
  response.resume();
  request.destroy();
  expect(f.worker.data.acquireMux).not.toHaveBeenCalled();
});
