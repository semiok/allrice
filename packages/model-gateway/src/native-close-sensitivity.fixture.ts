/** Real TCP I/O control only; observers never join or authorize product work. */
import { channel } from 'node:diagnostics_channel';
import { createServer } from 'node:http';
import { Socket } from 'node:net';
import type { Agent } from 'undici-native-proof';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import type { GatewayProvider } from './contract.ts';
import { closeServer, deferred, listen } from './gateway.fixture.ts';

export type NativeReleaseProbe = {
  slotEnter(): void;
  slotCommitted(): void;
  permitFinished(): void;
};
type Event = { kind: string; at: number };

export async function nativeCloseSensitivityFixture(owners: {
  release(callback: () => void): void;
  close(callback: () => Promise<void>): void;
}) {
  const events: Event[] = [];
  const mark = (kind: string) => events.push({ kind, at: events.length + 1 });
  const arrived = deferred();
  const destroying = deferred();
  const rejected = deferred();
  const closed = deferred();
  const committed = deferred();
  const finished = deferred();
  const sockets: Socket[] = [];
  const peers = new Set<Socket>();
  const requests = new Set<object>();
  const pendingDestroy = new Set<() => void>();
  const detaches = new Set<() => void>();
  let armed = false;
  let released = false;
  let calls = 0;
  let eof = 0;
  let origin = '';
  const resources: { agent?: Agent } = {};
  let disposal: Promise<void> | undefined;
  let installed = false;
  const originalFetch = globalThis.fetch;
  function allowPhysicalDestroy() {
    if (released) return;
    released = true;
    for (const destroy of pendingDestroy) destroy();
    pendingDestroy.clear();
  }
  class GatedSocket extends Socket {
    override _destroy(
      error: Error | null,
      callback: (error?: Error | null) => void,
    ) {
      let delegated = false;
      const destroy = () => {
        if (delegated) return;
        delegated = true;
        super._destroy(error, callback);
      };
      // Node destroy() entered this documented implementer method. No event,
      // close promise, private handle/state or destroyed flag is replaced.
      if (!armed || released) destroy();
      else {
        pendingDestroy.add(destroy);
        mark('destroy-requested');
        destroying.resolve();
      }
    }
  }
  const server = createServer((request) => {
    peers.add(request.socket);
    request.socket.once('close', onPeerClose);
    request.once('end', () => {
      mark('upstream-received');
      arrived.resolve();
    });
    request.resume(); // Discard payload; deliberately send no response headers.
  });
  const headers = channel('undici:client:sendHeaders');
  const trailers = channel('undici:request:trailers');
  const onHeaders = (message: unknown) => {
    const { request, socket } = message as { request: object; socket: Socket };
    if (sockets.includes(socket)) {
      requests.add(request);
      mark('send-headers');
    }
  };
  const onTrailers = (message: unknown) => {
    if (requests.has((message as { request: object }).request)) eof++;
  };
  const matches = (input: RequestInfo | URL) =>
    new URL(input instanceof Request ? input.url : String(input)).origin ===
    origin;
  const scopedFetch: typeof fetch = (input, init) => {
    if (!matches(input)) return originalFetch(input, init);
    calls++;
    const options = { ...init, dispatcher: resources.agent };
    const promise = originalFetch(input, options);
    // Observe the SAME raw native promise; no awaited cleanup or new outcome.
    void promise.then(undefined, () => {
      mark('raw-rejected');
      rejected.resolve();
    });
    return promise;
  };
  const dispose = () =>
    (disposal ??= (async () => {
      allowPhysicalDestroy();
      const failures: unknown[] = [];
      if (installed) {
        if (globalThis.fetch === scopedFetch) globalThis.fetch = originalFetch;
        else
          failures.push(
            new Error(
              'native proof fetch must be restored after gateway close',
            ),
          );
      }
      for (const operation of [
        () => resources.agent?.destroy(),
        () => (server.listening ? closeServer(server) : undefined),
      ])
        try {
          await operation();
        } catch (error) {
          failures.push(error);
        }
      headers.unsubscribe(onHeaders);
      trailers.unsubscribe(onTrailers);
      for (const detach of detaches) detach();
      for (const socket of peers) socket.off('close', onPeerClose);
      if (failures.length)
        throw new AggregateError(failures, 'native proof cleanup failed');
    })());
  function onClose() {
    mark('local-close');
    closed.resolve();
  }
  function onPeerClose() {
    mark('peer-close');
  }
  owners.release(allowPhysicalDestroy); // Registered before any async setup.
  owners.close(dispose);
  headers.subscribe(onHeaders);
  trailers.subscribe(onTrailers);
  origin = await listen(server);
  // Exact test alias, delayed until G12; never install a global dispatcher.
  const { Agent: NativeAgent } = await import('undici-native-proof');
  resources.agent = new NativeAgent({
    connections: 1,
    pipelining: 1,
    connect(options, callback) {
      const socket = new GatedSocket();
      sockets.push(socket);
      socket.once('close', onClose);
      const error = (value: Error) => callback(value, null);
      socket.once('error', error);
      const connected = () => {
        socket.off('error', error);
        callback(null, socket);
      };
      socket.once('connect', connected);
      detaches.add(() => {
        socket.off('close', onClose);
        socket.off('error', error);
        socket.off('connect', connected);
      });
      socket.connect({ host: options.hostname, port: Number(options.port) });
    },
  });
  globalThis.fetch = scopedFetch;
  installed = true;
  const provider: GatewayProvider = {
    classify(input) {
      return matches(input) ? { kind: 'model', protocol: 'opaque' } : null;
    },
    stream(_binding, _input, signal) {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<StreamChunk>> {
              await fetch(origin, { method: 'POST', body: '{}', signal });
              throw new Error(
                'pending-headers fixture received response headers',
              );
            },
          };
        },
      };
    },
  };
  const releaseProbe: NativeReleaseProbe = {
    slotEnter() {
      mark('slot-enter');
    },
    slotCommitted() {
      mark('slot-committed');
      committed.resolve();
    },
    permitFinished() {
      mark('permit-finished');
      finished.resolve();
    },
  };
  return {
    provider,
    releaseProbe,
    arrived,
    destroying,
    rejected,
    closed,
    committed,
    finished,
    allowPhysicalDestroy,
    dispose,
    arm() {
      armed = true;
    },
    snapshot() {
      const socket = sockets[0];
      const peer = [...peers][0];
      return {
        runtime: process.version + '/' + process.versions.undici,
        events: events.map((event) => ({ ...event })),
        calls,
        eof,
        sockets: sockets.length,
        requests: requests.size,
        held: armed && !released,
        tcpPeer:
          !!socket &&
          !!peer &&
          socket.localPort === peer.remotePort &&
          socket.remotePort === peer.localPort &&
          peers.size === 1,
        peerOpen: !!peer && !peer.destroyed,
      };
    },
  };
}
