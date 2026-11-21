/* global AbortController, fetch */
import { on, once } from 'node:events';
import { URL, URLSearchParams } from 'node:url';
import process from 'node:process';
import { WebSocket, WebSocketServer } from 'ws';
import {
  DEntryMountSchema,
  DEntryNativeOwnerRequestSchema,
} from '@allrice/contracts';
import { createPendingWork } from './pending-work.mjs';

/** Web transports only to its fixed Worker. The Worker decodes and authorizes
 * EVERY logical Mux open; this is never a browser-to-guest opaque WS tunnel. */
export function createDEntryNativeGateway({
  port,
  probe = fetch,
  connect = (url, options) => new WebSocket(url, options),
}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error('INVALID_LOOPBACK_PORT');
  const wss = new WebSocketServer({ noServer: true });
  const work = createPendingWork(),
    owners = new Set();
  const cleanupErrors = [];
  let stopping = false,
    closing;
  const matches = (request) =>
    request.url?.split('?')[0] === '/api/v1/d-entry/native-mux';
  return {
    matches,
    upgrade(request, socket, head) {
      const abort = new AbortController();
      const browserClosed = new Promise((resolve) =>
        socket.once('close', resolve),
      );
      const rejectHttp = (status) =>
        Promise.race([
          new Promise((resolve) =>
            socket.end(
              `HTTP/1.1 ${status} Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
              resolve,
            ),
          ),
          browserClosed,
        ]);
      const stop = (reason) =>
        abort.abort(reason instanceof Error ? reason : undefined);
      socket.once('close', stop);
      socket.on('error', stop);
      owners.add(abort);
      return work.run(async () => {
        let worker, peer, response, workerClosed;
        let rejection = 403;
        try {
          if (stopping) throw Error('D_ENTRY_STOPPING');
          const origin = new URL(String(request.headers.origin));
          if (
            origin.origin !== request.headers.origin ||
            origin.host !== request.headers.host ||
            (origin.protocol !== 'https:' &&
              !(
                origin.protocol === 'http:' &&
                ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
              )) ||
            request.headers['sec-fetch-site'] === 'cross-site' ||
            request.method !== 'GET' ||
            !matches(request)
          )
            throw Error('D_ENTRY_ORIGIN');
          const url = new URL(request.url, origin);
          const allowed = [
            'organizationId',
            'workspaceId',
            'employeeInstanceId',
            'threadId',
          ];
          if (
            [...url.searchParams.keys()].some(
              (key) =>
                !allowed.includes(key) ||
                url.searchParams.getAll(key).length !== 1,
            )
          )
            throw Error('D_ENTRY_SELECTORS');
          const { organizationId, ...selection } = Object.fromEntries(
            url.searchParams,
          );
          const input = DEntryNativeOwnerRequestSchema.parse({
            organizationId,
            selection,
          });
          if (!input.selection.threadId) throw Error('D_ENTRY_THREAD_REQUIRED');
          // This name is the existing Web session cookie (identity/session.ts),
          // not a native Cookie. The actual Web probe and Worker authenticate it.
          rejection = 401;
          const values = String(request.headers.cookie ?? '')
            .split(';')
            .map((value) => value.trim())
            .filter((value) => value.startsWith('allrice_session='));
          if (values.length !== 1) throw Error('D_ENTRY_SESSION_REQUIRED');
          const token = values[0].slice('allrice_session='.length);
          if (!/^[A-Za-z0-9_-]{16,4096}$/.test(token))
            throw Error('D_ENTRY_SESSION_REQUIRED');
          rejection = 503;
          // Only our own Web loopback receives the original browser Cookie;
          // portal and current tenant authentication stays at its normal owner.
          response = await probe(
            `http://127.0.0.1:${port}/api/v1/d-entry/native-owner`,
            {
              method: 'POST',
              redirect: 'error',
              signal: abort.signal,
              headers: {
                host: request.headers.host,
                origin: request.headers.origin,
                cookie: request.headers.cookie ?? '',
                'content-type': 'application/json',
                'x-allrice-organization-id': input.organizationId,
                'x-allrice-workspace-id': input.selection.workspaceId,
              },
              body: JSON.stringify(input.selection),
            },
          );
          if (!response.ok) {
            const status = [401, 403, 404].includes(response.status)
              ? response.status
              : 503;
            await rejectHttp(status);
            return;
          }
          const { mount } = await response.json();
          const safe = DEntryMountSchema.parse(mount);
          if (
            safe.identity.organizationId !== input.organizationId ||
            safe.identity.workspaceId !== input.selection.workspaceId ||
            safe.identity.employeeInstanceId !==
              input.selection.employeeInstanceId ||
            safe.identity.threadId !== input.selection.threadId ||
            safe.executionGeneration !== '4.0'
          )
            throw Error('D_ENTRY_BINDING');
          const base = new URL(
            process.env.ALLRICE_WORKER_INTERNAL_URL?.trim() ||
              `http://127.0.0.1:${process.env.ALLRICE_WORKER_PORT ?? '3101'}`,
          );
          if (
            !['http:', 'https:'].includes(base.protocol) ||
            base.username ||
            base.password ||
            base.search ||
            base.hash
          )
            throw Error('D_ENTRY_WORKER');
          const target = new URL('/internal/d-entry/native-mux', base);
          target.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
          target.search = new URLSearchParams({
            organizationId: safe.identity.organizationId,
            ...input.selection,
          }).toString();
          abort.signal.throwIfAborted();
          worker = connect(target, {
            headers: { authorization: `Bearer ${token}` },
            followRedirects: false,
          });
          workerClosed = new Promise((resolve) =>
            worker.once('close', resolve),
          );
          const terminate = () => worker.terminate();
          abort.signal.addEventListener('abort', terminate, { once: true });
          worker.once('close', stop);
          worker.on('error', stop);
          try {
            if (worker.readyState !== WebSocket.OPEN)
              await once(worker, 'open', { signal: abort.signal });
            abort.signal.throwIfAborted();
            peer = await new Promise((resolve, reject) => {
              let done = false;
              const cleanup = () => {
                socket.off('close', fail);
                socket.off('error', fail);
                abort.signal.removeEventListener('abort', fail);
              };
              const fail = () => {
                if (done) return;
                done = true;
                cleanup();
                reject(abort.signal.reason ?? Error('D_ENTRY_UPGRADE_CLOSED'));
              };
              socket.once('close', fail);
              socket.once('error', fail);
              abort.signal.addEventListener('abort', fail, { once: true });
              if (abort.signal.aborted) {
                fail();
                return;
              }
              try {
                wss.handleUpgrade(request, socket, head, (ws) => {
                  if (done) {
                    ws.terminate();
                    return;
                  }
                  done = true;
                  cleanup();
                  resolve(ws);
                });
              } catch (error) {
                done = true;
                cleanup();
                reject(error);
              }
            });
            peer.once('close', stop);
            peer.on('error', stop);
            const forward = async (from, to) => {
              for await (const [message, binary] of on(from, 'message', {
                signal: abort.signal,
                close: ['close'],
                highWaterMark: 1,
                lowWaterMark: 1,
              })) {
                if (binary) throw Error('D_ENTRY_MUX_BINARY');
                abort.signal.throwIfAborted();
                await new Promise((resolve, reject) =>
                  to.send(message, { binary: false }, (error) =>
                    error ? reject(error) : resolve(),
                  ),
                );
              }
            };
            await Promise.allSettled([
              forward(peer, worker).finally(stop),
              forward(worker, peer).finally(stop),
            ]);
          } finally {
            abort.signal.removeEventListener('abort', terminate);
          }
        } catch {
          if (!peer && !socket.destroyed && !socket.writableEnded)
            await rejectHttp(rejection);
        } finally {
          abort.abort();
          peer?.terminate();
          socket.destroy();
          worker?.terminate();
          const results = await Promise.allSettled([
            workerClosed,
            browserClosed,
            response && !response.bodyUsed
              ? response.body?.cancel()
              : undefined,
          ]);
          cleanupErrors.push(
            ...results.flatMap((result) =>
              result.status === 'rejected' ? [result.reason] : [],
            ),
          );
          socket.off('close', stop);
          socket.off('error', stop);
          owners.delete(abort);
        }
      });
    },
    close() {
      if (closing) return closing;
      stopping = true;
      for (const owner of owners) owner.abort();
      closing = (async () => {
        await work.drain();
        await new Promise((resolve, reject) =>
          wss.close((error) => (error ? reject(error) : resolve())),
        );
        if (cleanupErrors.length)
          throw new AggregateError(
            cleanupErrors,
            'D entry Web transport close is unknown',
          );
      })();
      return closing;
    },
  };
}
