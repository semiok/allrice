import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { request as httpRequest } from 'node:http';
import {
  clearInterval,
  clearTimeout,
  setInterval,
  setTimeout,
} from 'node:timers';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import {
  UuidSchema,
  WorkbenchTerminalBrowserFrameSchema,
  WorkbenchTerminalServerFrameSchema,
  TerminalTargetSchema,
  TerminalStreamModeSchema,
  workbenchTerminalSocketPath,
  workbenchTerminalProtocol,
  workbenchTerminalStreamProtocol,
  bridgeSocketMaximumFrameBytes,
  bridgeSocketMaximumBufferedBytes,
  terminalMaximumPending,
} from '@allrice/contracts';
import { createPendingWork } from './pending-work.mjs';

/** Fixed local route, forwarding the same cookies/portal/tenant rules as the
 * rest of the Web app. Caller never controls a URL or arbitrary headers. */
export function createTerminalLoopbackAuthorization(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error('INVALID_LOOPBACK_PORT');
  return (request, input) =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(input);
      const headers = {
        host: request.headers.host,
        origin: request.headers.origin,
        cookie: request.headers.cookie ?? '',
        'x-allrice-organization-id':
          new URL(request.url, 'http://localhost').searchParams.get(
            'organizationId',
          ) ?? '',
        'x-allrice-workspace-id': input.workspaceId,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
      };
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/v1/workbench-terminal/authorize',
          headers,
        },
        (res) => {
          const chunks = [];
          let bytes = 0;
          res.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > 16_384) {
              res.destroy();
              req.destroy(Error('TERMINAL_AUTH_RESPONSE_TOO_LARGE'));
            } else chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () => {
            if (res.statusCode !== 200) {
              const error = Error('TERMINAL_AUTHORITY_UNAVAILABLE');
              error.status = res.statusCode;
              reject(error);
              return;
            }
            try {
              const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              resolve({
                target: TerminalTargetSchema.parse(result.target),
                deviceName: String(result.deviceName),
                streamMode: TerminalStreamModeSchema.parse(
                  result.streamMode ?? 'pull',
                ),
              });
            } catch {
              reject(Error('TERMINAL_AUTH_RESPONSE_INVALID'));
            }
          });
        },
      );
      const timer = setTimeout(
        () => req.destroy(Error('TERMINAL_AUTH_TIMEOUT')),
        4000,
      );
      req.once('close', () => clearTimeout(timer));
      req.once('error', reject);
      req.end(data);
    });
}

/** Human input and DSH frames are a bounded, non-replaying tunnel. The native
 * controller owns processes, screen recovery, acknowledgements and cleanup. */
export function createWorkbenchTerminalGateway({
  resolveAccess,
  transport,
  enabled = () => true,
  authorizationLeaseMs = 500,
  watchMs = 1000,
}) {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: bridgeSocketMaximumFrameBytes,
    handleProtocols: (protocols) =>
      protocols.has(workbenchTerminalStreamProtocol)
        ? workbenchTerminalStreamProtocol
        : protocols.has(workbenchTerminalProtocol)
          ? workbenchTerminalProtocol
          : false,
  });
  const owners = new Set(),
    admissions = new Set(),
    work = createPendingWork();
  let stopping = false,
    closing,
    cleanupFailed = false;
  const denied = (error) =>
    [401, 403, 404].includes(error?.status) ||
    error?.message === 'TERMINAL_TARGET_CHANGED';
  function identity(req) {
    const origin = new URL(String(req.headers.origin));
    if (
      origin.origin !== req.headers.origin ||
      origin.host !== req.headers.host ||
      (origin.protocol !== 'https:' &&
        !(
          origin.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
        )) ||
      req.headers['sec-fetch-site'] === 'cross-site'
    )
      throw Error('TERMINAL_ORIGIN');
    const url = new URL(req.url, origin.origin);
    const keys = [
      'organizationId',
      'workspaceId',
      'sessionId',
      'deviceId',
      'grantId',
    ];
    if (
      url.pathname !== workbenchTerminalSocketPath ||
      url.hash ||
      [...url.searchParams.keys()].some((key) => !keys.includes(key)) ||
      keys.some((key) => url.searchParams.getAll(key).length !== 1)
    )
      throw Error('TERMINAL_TARGET');
    const parsed = Object.fromEntries(
      keys.map((key) => [key, UuidSchema.parse(url.searchParams.get(key))]),
    );
    const { organizationId, ...input } = parsed;
    return { organizationId, input };
  }
  const sameTarget = (a, b) =>
    Object.keys(a).every((key) => key === 'label' || a[key] === b[key]) &&
    Object.keys(b).every((key) => key === 'label' || a[key] === b[key]);
  function owner(req, ws, access, input) {
    const state = {
      id: randomUUID(),
      ws,
      target: access.target,
      streamMode:
        ws.protocol === workbenchTerminalStreamProtocol &&
        access.streamMode === 'push'
          ? 'push'
          : 'pull',
      work: createPendingWork(),
      channel: null,
      stopped: false,
      ready: false,
      done: null,
      queue: Promise.resolve(),
      bytes: 0,
      seen: new Set(),
      pending: new Map(),
      checkedAt: Date.now(),
      checking: null,
    };
    owners.add(state);
    const socketClosed = new Promise((resolve) => ws.once('close', resolve));
    const channelReady = Promise.withResolvers();
    let channelClosed;
    const closeChannel = (revoke) => {
      if (!state.channel || channelClosed) return;
      channelClosed = Promise.resolve().then(() => state.channel.close(revoke));
      void channelClosed.catch(() => undefined);
    };
    state.stop = (revoke = false) => {
      if (state.stopped) return;
      state.stopped = true;
      clearInterval(watch);
      clearTimeout(readyTimeout);
      closeChannel(revoke);
      ws.close(revoke ? 4403 : 4009, 'TERMINAL_CONNECTION_UNAVAILABLE');
      const timer = setTimeout(() => ws.terminate(), 500);
      timer.unref();
      void socketClosed.then(() => clearTimeout(timer));
      state.done = (async () => {
        await socketClosed;
        await state.work.drain();
        closeChannel(revoke);
        await channelClosed;
      })();
      void state.done.then(
        () => owners.delete(state),
        () => {
          cleanupFailed = true;
          owners.delete(state);
        },
      );
    };
    const authorize = (force = false) => {
      if (state.stopped || stopping || !enabled())
        return Promise.reject(Error('TERMINAL_STOPPING'));
      if (!force && Date.now() - state.checkedAt < authorizationLeaseMs)
        return Promise.resolve();
      if (!state.checking)
        state.checking = state.work
          .run(async () => {
            const fresh = await resolveAccess(req, input);
            if (!sameTarget(state.target, fresh.target))
              throw Error('TERMINAL_TARGET_CHANGED');
            state.checkedAt = Date.now();
          })
          .finally(() => {
            state.checking = null;
          });
      return state.checking;
    };
    const send = (frame) => {
      if (state.stopped || stopping || ws.readyState !== WebSocket.OPEN)
        return Promise.reject(Error('TERMINAL_CLOSED'));
      const data = JSON.stringify(
        WorkbenchTerminalServerFrameSchema.parse(frame),
      );
      if (
        Buffer.byteLength(data) > bridgeSocketMaximumFrameBytes ||
        ws.bufferedAmount + Buffer.byteLength(data) >
          bridgeSocketMaximumBufferedBytes ||
        [...owners].reduce((n, o) => n + o.ws.bufferedAmount, 0) >
          16 * 1024 * 1024
      )
        return Promise.reject(Error('TERMINAL_BACKPRESSURE'));
      return new Promise((resolve, reject) =>
        ws.send(data, (error) => (error ? reject(error) : resolve())),
      );
    };
    const watch = setInterval(() => {
      if (state.checking || state.stopped) return;
      void authorize(true).catch((error) => state.stop(denied(error)));
    }, watchMs);
    watch.unref();
    const readyTimeout = setTimeout(() => state.stop(), 5000);
    readyTimeout.unref();
    ws.on('error', () => state.stop());
    ws.once('close', () => state.stop());
    ws.on('message', (data, binary) => {
      if (state.stopped || stopping) return;
      if (
        binary ||
        !state.ready ||
        state.bytes + data.length > bridgeSocketMaximumBufferedBytes
      ) {
        state.stop();
        return;
      }
      let frame;
      try {
        frame = WorkbenchTerminalBrowserFrameSchema.parse(
          JSON.parse(data.toString('utf8')),
        );
      } catch {
        state.stop();
        return;
      }
      const pending = state.pending.get(frame.requestId);
      if (frame.type === 'terminal.request') {
        if (
          state.seen.has(frame.requestId) ||
          state.seen.size >= 4096 ||
          state.pending.size >= terminalMaximumPending
        ) {
          state.stop();
          return;
        }
        state.seen.add(frame.requestId);
        state.pending.set(frame.requestId, {
          stream: ['attach', 'retain'].includes(frame.action),
          action: frame.action,
          credit: false,
          fragment: null,
        });
      } else if (!pending) {
        // A late return/cancel after completion has no execution effect.
        if (frame.type === 'terminal.cancel' && state.seen.has(frame.requestId))
          return;
        state.stop();
        return;
      } else if (frame.type === 'terminal.next') {
        if (state.streamMode === 'push' || !pending.stream || pending.credit) {
          state.stop();
          return;
        }
        pending.credit = true;
      } else if (
        frame.type === 'terminal.input' &&
        pending.action !== 'attach'
      ) {
        state.stop();
        return;
      } else if (frame.type === 'terminal.cancel')
        state.pending.delete(frame.requestId);
      state.bytes += data.length;
      state.queue = state.work.track(
        state.queue
          .then(async () => {
            if (state.stopped || stopping) return;
            await authorize(frame.type === 'terminal.request');
            if (state.stopped || stopping) return;
            if (!(await state.channel.send(frame)))
              throw Error('TERMINAL_BRIDGE_UNAVAILABLE');
          })
          .catch((error) => state.stop(denied(error)))
          .finally(() => {
            state.bytes -= data.length;
          }),
      );
    });
    // Reserve ownership before opening. A disconnected client still joins a
    // late opener, and the opener never allocates a replacement terminal.
    state.work.track(
      (async () => {
        state.channel = await transport.openTerminal({
          target: state.target,
          ...(state.streamMode === 'push' ? { streamMode: 'push' } : {}),
          id: state.id,
          onFrame: async (incoming) => {
            await channelReady.promise;
            if (state.stopped || stopping) return;
            const frame = { ...incoming };
            delete frame.id;
            if (frame.type === 'terminal.ready') {
              if (state.ready) throw Error('TERMINAL_DUPLICATE_READY');
              state.ready = true;
              clearTimeout(readyTimeout);
              await authorize(true);
              await send({
                ...frame,
                target: access.target,
                deviceName: access.deviceName,
                ...(state.streamMode === 'push' ? { streamMode: 'push' } : {}),
              });
              return;
            }
            if (frame.type === 'terminal.ended') {
              await send(frame);
              state.stop();
              return;
            }
            const pending = state.pending.get(frame.requestId);
            if (!pending) return;
            if (
              frame.type === 'terminal.frame' ||
              frame.type === 'terminal.fragment'
            ) {
              if (
                !pending.stream ||
                (state.streamMode === 'pull' && !pending.credit)
              )
                throw Error('TERMINAL_UNSOLICITED_OUTPUT');
              if (frame.type === 'terminal.fragment') {
                const previous = pending.fragment;
                if (
                  frame.index !== (previous?.next ?? 0) ||
                  (previous && frame.total !== previous.total)
                )
                  throw Error('TERMINAL_FRAGMENT_SEQUENCE');
                pending.fragment = {
                  next: frame.index + 1,
                  total: frame.total,
                  bytes: (previous?.bytes ?? 0) + Buffer.byteLength(frame.data),
                };
                if (pending.fragment.bytes > 2 * 1024 * 1024)
                  throw Error('TERMINAL_SCREEN_TOO_LARGE');
                if (frame.index + 1 === frame.total) {
                  pending.fragment = null;
                  pending.credit = false;
                }
              } else {
                if (pending.fragment) throw Error('TERMINAL_FRAGMENT_SEQUENCE');
                pending.credit = false;
              }
            } else if (
              frame.type === 'terminal.result' ||
              frame.type === 'terminal.finished'
            )
              state.pending.delete(frame.requestId);
            await authorize();
            await send(frame);
          },
          onClose: () => {
            state.stop();
          },
        });
        channelReady.resolve();
        if (state.stopped || stopping) closeChannel(false);
      })().catch((error) => {
        channelReady.resolve();
        state.stop(denied(error));
      }),
    );
    return state;
  }
  return {
    matches: (req) => req.url?.split('?')[0] === workbenchTerminalSocketPath,
    upgrade(req, socket, head) {
      socket.on('error', () => undefined);
      const reject = (status) => {
        if (!socket.destroyed)
          socket.end(
            `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
            () => socket.destroy(),
          );
      };
      if (stopping || !enabled()) {
        reject('404 Not Found');
        return Promise.resolve();
      }
      let identityInput;
      try {
        identityInput = identity(req);
        if (
          req.method !== 'GET' ||
          req.headers.upgrade?.toLowerCase() !== 'websocket' ||
          ![
            workbenchTerminalProtocol,
            workbenchTerminalStreamProtocol,
          ].includes(req.headers['sec-websocket-protocol'])
        )
          throw Error();
      } catch {
        reject('403 Forbidden');
        return Promise.resolve();
      }
      if (owners.size + admissions.size >= 64 || admissions.size >= 16) {
        reject('503 Service Unavailable');
        return Promise.resolve();
      }
      const admission = { stop: () => socket.destroy() };
      admissions.add(admission);
      const timer = setTimeout(admission.stop, 5000);
      return work.run(async () => {
        try {
          const access = await resolveAccess(req, identityInput.input);
          if (
            access.target.organizationId !== identityInput.organizationId ||
            Object.keys(identityInput.input).some(
              (key) => access.target[key] !== identityInput.input[key],
            )
          )
            throw Error('TERMINAL_TARGET_CHANGED');
          if (socket.destroyed || stopping) return;
          wss.handleUpgrade(req, socket, head, (ws) => {
            owner(req, ws, access, identityInput.input);
          });
        } catch (error) {
          reject(
            denied(error) ? '401 Unauthorized' : '503 Service Unavailable',
          );
        } finally {
          clearTimeout(timer);
          admissions.delete(admission);
        }
      });
    },
    close() {
      if (closing) return closing;
      stopping = true;
      for (const admission of admissions) admission.stop();
      const active = [...owners];
      for (const state of active) state.stop();
      closing = (async () => {
        const results = await Promise.allSettled([
          work.drain(),
          ...active.map((state) => state.done),
        ]);
        await new Promise((resolve) => wss.close(resolve));
        if (
          cleanupFailed ||
          results.some((result) => result.status === 'rejected')
        )
          throw Error('TERMINAL_GATEWAY_CLEANUP_UNCONFIRMED');
      })();
      return closing;
    },
  };
}
