import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeEntryServer, deferred } from './native-entry.fixture.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await nativeEntryServer();
  let unknown = false;
  const peers: WebSocket[] = [];
  cleanups.push(async () => {
    for (const peer of peers) peer.terminate();
    if (unknown)
      await expect(f.close()).rejects.toThrow('Entry fixture cleanup unknown');
    else await f.close();
  });
  return {
    ...f,
    expectUnknownClose() {
      unknown = true;
    },
    connect(extra: Record<string, string> = {}) {
      const url =
        f.origin.replace('http:', 'ws:') +
        '/internal/d-entry/native-mux?' +
        new URLSearchParams({
          organizationId: f.identity.organizationId,
          ...f.selection,
        });
      const peer = new WebSocket(url, {
        headers: {
          authorization: 'Bearer original_session_opaque_token',
          ...extra,
        },
      });
      peer.on('error', () => {});
      peers.push(peer);
      return peer;
    },
  };
}
const follow = {
  type: 'open',
  streamId: 'child-read',
  endpoint: 'session/follow',
  payload: {
    args: {
      request: {
        address: {
          kind: 'subagent',
          parentSessionId: 'dsh-root',
          childSessionId: 'dsh-child',
          mode: 'continuable',
        },
      },
    },
  },
};

describe('server-side browser Mux gate and owned request closure', () => {
  it('forwards only a generated/authorized child read, then aborts and joins an idle connection on real owner revocation', async () => {
    const f = await fixture(),
      sent = deferred<void>(),
      finished = deferred<void>();
    f.sent.mockImplementationOnce(async () => sent.resolve());
    vi.mocked(f.admission.boundary.finish).mockImplementationOnce(async () => {
      await f.muxClosed.promise;
      finished.resolve();
    });
    const peer = f.connect();
    await once(peer, 'open');
    peer.send(JSON.stringify(follow));
    await sent.promise;
    expect(JSON.parse(f.sent.mock.calls[0]![0])).toEqual(follow);
    const message = once(peer, 'message');
    f.muxFrames.push(
      JSON.stringify({
        type: 'item',
        streamId: 'child-read',
        value: { event: 'fixture-read' },
      }),
    );
    expect(JSON.parse(String((await message)[0]))).toMatchObject({
      type: 'item',
      streamId: 'child-read',
    });
    const closed = once(peer, 'close');
    f.authorization.abort(new Error('current session/release revoked'));
    await closed;
    await finished.promise;
    expect(f.admission.boundary.finish).toHaveBeenCalledTimes(1);
  });

  it('refuses a child prompt in a Mux open before upstream send; native parent control is outside this browser adapter', async () => {
    const f = await fixture(),
      finished = deferred<void>();
    vi.mocked(f.admission.boundary.finish).mockImplementationOnce(async () =>
      finished.resolve(),
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
              requestId: 'fixture-reply',
              mode: 'queue',
              content: [{ type: 'text', text: 'forbidden' }],
            },
          },
        },
      }),
    );
    await closed;
    await finished.promise;
    expect(f.sent).not.toHaveBeenCalled();
    expect(f.admission.boundary.finish).toHaveBeenCalledTimes(1);
  });

  it('authenticates Upgrade, refuses browser Origin on the internal endpoint, and does not treat missing handles as joined', async () => {
    const f = await fixture();
    let peer = f.connect({ origin: 'https://browser.invalid' });
    let response = once(peer, 'unexpected-response');
    const [request, rejected] = await response;
    expect(rejected.statusCode).toBe(404);
    rejected.resume();
    request.destroy();
    expect(f.data.acquireMux).not.toHaveBeenCalled();
    const finished = deferred<void>();
    vi.mocked(f.admission.boundary.finish).mockImplementationOnce(async () =>
      finished.resolve(),
    );
    const invalid = new URL('/internal/d-entry/native-mux', f.origin);
    invalid.search = new URLSearchParams({
      organizationId: f.identity.organizationId,
      ...f.selection,
    }).toString();
    const status = await new Promise<number>((resolve, reject) => {
      const raw = httpRequest(
        invalid,
        {
          headers: {
            authorization: 'Bearer original_session_opaque_token',
            connection: 'Upgrade',
            upgrade: 'websocket',
            'sec-websocket-version': '13',
            'sec-websocket-key': 'invalid',
          },
        },
        (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode!));
        },
      );
      raw.on('error', reject);
      raw.on('upgrade', (_response, socket) => {
        socket.destroy();
        reject(new Error('Invalid native Mux handshake was accepted'));
      });
      raw.end();
    });
    expect(status).toBe(400);
    await finished.promise;
    await f.muxClosed.promise;
    expect(f.admission.boundary.finish).toHaveBeenCalledTimes(1);
    const unknown = new Error('partial acquisition unknown');
    f.expectUnknownClose();
    vi.mocked(f.data.acquireMux).mockImplementationOnce(() => {
      throw unknown;
    });
    peer = f.connect();
    response = once(peer, 'unexpected-response');
    const [request2, rejected2] = await response;
    expect(rejected2.statusCode).toBe(503);
    rejected2.resume();
    request2.destroy();
    expect(f.admission.boundary.finish).toHaveBeenCalledTimes(2);
  });
});
