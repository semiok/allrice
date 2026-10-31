/* global AbortController */
import { request } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { URL } from 'node:url';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { createPendingWork } from './pending-work.mjs';

/** Transport only: the fixed Web GET and Worker still own every read grant. */
export function createNativeSubagentFollowGateway({ port }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error('INVALID_LOOPBACK_PORT');
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    // No application messages are accepted from this read-only browser peer.
    maxPayload: 1,
  });
  const owners = new Set(),
    work = createPendingWork();
  let stopping = false,
    closing;
  const matches = (req) =>
    /^\/api\/v1\/sessions\/[^/?]+\/subagents(?:\?|$)/.test(req.url ?? '');
  return {
    matches,
    upgrade(req, socket, head) {
      const abort = new AbortController();
      const stop = () => abort.abort();
      socket.on('error', stop);
      socket.once('close', stop);
      const reject = (status) => {
        if (!socket.destroyed)
          socket.end(
            `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
            () => socket.destroy(),
          );
      };
      if (stopping) {
        reject('503 Service Unavailable');
        return Promise.resolve();
      }
      let url, headers;
      try {
        const origin = new URL(String(req.headers.origin));
        if (
          origin.origin !== req.headers.origin ||
          origin.host !== req.headers.host ||
          (origin.protocol !== 'https:' &&
            !(
              origin.protocol === 'http:' &&
              ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
            )) ||
          req.headers['sec-fetch-site'] === 'cross-site' ||
          req.method !== 'GET' ||
          req.headers.upgrade?.toLowerCase() !== 'websocket' ||
          !matches(req)
        )
          throw Error('NATIVE_FOLLOW_ORIGIN');
        url = new URL(req.url, origin);
        const allowed = [
          'organizationId',
          'workspaceId',
          'childId',
          'follow',
          'liveOnly',
        ];
        if (
          url.hash ||
          url.pathname !== req.url.split('?')[0] ||
          url.searchParams.get('follow') !== 'true' ||
          !url.searchParams.get('organizationId') ||
          !url.searchParams.get('workspaceId') ||
          (url.searchParams.has('liveOnly') &&
            url.searchParams.get('liveOnly') !== 'true') ||
          [...url.searchParams.keys()].some(
            (key) =>
              !allowed.includes(key) ||
              url.searchParams.getAll(key).length !== 1,
          )
        )
          throw Error('NATIVE_FOLLOW_TARGET');
        headers = {
          host: req.headers.host,
          origin: req.headers.origin,
          cookie: req.headers.cookie ?? '',
          'x-allrice-organization-id': url.searchParams.get('organizationId'),
          'x-allrice-workspace-id': url.searchParams.get('workspaceId'),
        };
        url.searchParams.delete('organizationId');
      } catch {
        reject('403 Forbidden');
        return Promise.resolve();
      }
      owners.add(abort);
      return work.run(async () => {
        let upstream, response, ws;
        try {
          response = await new Promise((resolve, reject) => {
            upstream = request(
              {
                hostname: '127.0.0.1',
                port,
                method: 'GET',
                path: url.pathname + url.search,
                headers,
                signal: abort.signal,
              },
              resolve,
            );
            upstream.on('error', reject);
            upstream.end();
          });
          if (
            response.statusCode !== 200 ||
            !response.headers['content-type']?.startsWith('text/event-stream')
          ) {
            reject(
              [401, 403, 404].includes(response.statusCode)
                ? `${response.statusCode} Unauthorized`
                : '503 Service Unavailable',
            );
            return;
          }
          abort.signal.throwIfAborted();
          wss.handleUpgrade(req, socket, head, (peer) => {
            ws = peer;
          });
          if (!ws) throw Error('NATIVE_FOLLOW_UPGRADE');
          ws.on('message', stop);
          await pipeline(response, createWebSocketStream(ws), {
            signal: abort.signal,
            end: false,
          });
          ws.close(1000);
        } catch {
          if (ws) ws.terminate();
          else reject('503 Service Unavailable');
        } finally {
          response?.destroy();
          upstream?.destroy();
          owners.delete(abort);
        }
      });
    },
    close() {
      if (closing) return closing;
      stopping = true;
      for (const abort of owners) abort.abort();
      for (const ws of wss.clients) ws.terminate();
      closing = work
        .drain()
        .then(() => new Promise((resolve) => wss.close(resolve)));
      return closing;
    },
  };
}
