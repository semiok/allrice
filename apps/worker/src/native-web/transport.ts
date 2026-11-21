import { request, Agent, type ClientRequest } from 'node:http';
import type { Socket } from 'node:net';
import WebSocket from 'ws';
import type {
  ConnectionWebSocket,
  RpcFetch,
} from '@deepseek-ai/dsh-client-connection/client';
import { PersonVmError } from '@allrice/person-vm';

/** Dedicated outbound resources; never the global fetch pool or a listener. */
export function nativeWebTransport(
  origin: string,
  signal: AbortSignal,
  lost: () => void,
) {
  const agent = new Agent({ keepAlive: false });
  const sockets = new Set<Socket>(),
    websockets = new Set<WebSocket>();
  const calls = new Set<ClientRequest>();
  const joins = new Set<Promise<void>>();
  let cookie: string | undefined,
    closing = false;
  function joined(promise: Promise<void>) {
    joins.add(promise);
    void promise.then(() => joins.delete(promise));
  }
  function target(input: string | URL) {
    signal.throwIfAborted();
    const url = new URL(input, origin);
    if (
      closing ||
      url.origin !== new URL(origin).origin ||
      url.username ||
      url.password
    )
      throw new PersonVmError('PROVIDER_FAILED');
    return url;
  }
  const fetch: RpcFetch = (input, init) =>
    new Promise((resolve, reject) => {
      try {
        const url = target(input);
        const headers = new Headers(init.headers);
        headers.set('host', url.host);
        headers.set('origin', new URL(origin).origin);
        if (cookie) headers.set('cookie', cookie);
        const callSignal = init.signal
          ? AbortSignal.any([signal, init.signal])
          : signal;
        const call = request(
          url,
          {
            method: init.method,
            headers: Object.fromEntries(headers),
            agent,
            signal: callSignal,
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('error', () =>
              reject(new PersonVmError('PROVIDER_FAILED')),
            );
            response.on('end', () => {
              try {
                const output = new Headers();
                for (const [key, value] of Object.entries(response.headers))
                  for (const item of Array.isArray(value)
                    ? value
                    : value === undefined
                      ? []
                      : [value])
                    output.append(key, item);
                const body = Buffer.concat(chunks);
                resolve(
                  new Response(
                    body.length ? Uint8Array.from(body).buffer : null,
                    {
                      status: response.statusCode!,
                      headers: output,
                    },
                  ),
                );
              } catch {
                reject(new PersonVmError('PROVIDER_FAILED'));
              }
            });
          },
        );
        calls.add(call);
        joined(
          new Promise((done) =>
            call.once('close', () => {
              calls.delete(call);
              reject(new PersonVmError('PROVIDER_FAILED')); // A closed, unanswered request is not a reply.
              done();
            }),
          ),
        );
        call.on('socket', (socket) => {
          sockets.add(socket);
          joined(
            new Promise((done) =>
              socket.once('close', () => {
                sockets.delete(socket);
                done();
              }),
            ),
          );
        });
        call.on('error', () => reject(new PersonVmError('PROVIDER_FAILED')));
        // Native Connection unary calls provide their already encoded JSON string.
        if (
          init.body !== undefined &&
          init.body !== null &&
          typeof init.body !== 'string'
        ) {
          call.destroy();
          reject(new PersonVmError('PROVIDER_FAILED'));
          return;
        }
        call.end(init.body);
      } catch {
        reject(new PersonVmError('PROVIDER_FAILED'));
      }
    });
  return {
    fetch,
    async authenticate(authenticatedUrl: string) {
      const url = target(authenticatedUrl);
      url.pathname = '/connect';
      url.searchParams.set('interactions', 'none');
      const response = await fetch(url, { method: 'GET', redirect: 'manual' });
      const values = response.headers.getSetCookie();
      if (
        response.status !== 302 ||
        response.headers.get('location') !== './api/remote.mux' ||
        values.length !== 1
      )
        throw new PersonVmError('PROVIDER_FAILED');
      cookie = values[0]!.split(';', 1)[0]!;
    },
    createWebSocket(input: string): ConnectionWebSocket {
      const url = new URL(input);
      const http = new URL(url);
      http.protocol = 'http:';
      target(http);
      if (
        url.protocol !== 'ws:' ||
        url.pathname !== '/api/remote.mux' ||
        url.search ||
        !cookie
      )
        throw new PersonVmError('PROVIDER_FAILED');
      let socket: WebSocket;
      try {
        socket = new WebSocket(url, {
          headers: {
            Cookie: cookie,
            Host: url.host,
            Origin: new URL(origin).origin,
          },
        });
      } catch {
        throw new PersonVmError('PROVIDER_FAILED');
      }
      websockets.add(socket);
      socket.on('error', () => {}); // Native carrier owns its typed failure; never log credential URLs.
      joined(
        new Promise((done) =>
          socket.once('close', () => {
            websockets.delete(socket);
            if (!closing) lost();
            done();
          }),
        ),
      );
      return socket as unknown as ConnectionWebSocket;
    },
    async close() {
      closing = true;
      cookie = undefined;
      agent.destroy();
      for (const call of calls) call.destroy();
      for (const socket of sockets) socket.destroy();
      for (const socket of websockets) socket.terminate();
      while (joins.size) await Promise.all([...joins]);
    },
  };
}
