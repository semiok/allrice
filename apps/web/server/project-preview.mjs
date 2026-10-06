import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  clearInterval,
  clearTimeout,
  setInterval,
  setTimeout,
} from 'node:timers';
import { URL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { projectPreviewHost, projectServiceLimits } from '@allrice/contracts';
import { createPendingWork } from './pending-work.mjs';

/** Same HTTP/WS surface for either executor. The resolver checks the live user
 * session, service authority and exact private target before every transfer. */
export function createProjectPreviewGateway({
  suffix,
  mainOrigin,
  adminOrigin,
  resolveAccess,
  transport,
  secure = true,
  onError = () => undefined,
}) {
  const frameOrigins = [...new Set([mainOrigin, adminOrigin].filter(Boolean))];
  for (const value of frameOrigins) {
    const url = new URL(value);
    if (
      url.origin !== value ||
      url.hostname.includes('*') ||
      url.username ||
      url.password ||
      (url.protocol !== 'https:' && (secure || url.protocol !== 'http:'))
    )
      throw Error('PROJECT_PREVIEW_FRAME_ORIGIN');
  }
  // Production is HTTPS and requires the host-only Secure cookie prefix. The
  // explicit loopback fixture mode cannot use that prefix over plain HTTP.
  const cookieName = secure ? '__Host-allrice_preview' : 'allrice_preview_test';
  const protocol = secure ? 'https:' : 'http:';
  const originFor = (id) => `${protocol}//${projectPreviewHost(id, suffix)}`;
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: projectServiceLimits.maximumSocketBytes,
  });
  const active = new Set();
  let stopping = false,
    closing,
    cleanupFailed = false;
  const matches = (req) =>
    String(req.headers.host ?? '')
      .split(':')[0]
      .startsWith('rice-preview-');
  function identity(req) {
    const host = String(req.headers.host ?? '').toLowerCase(),
      match = /^rice-preview-([a-f0-9-]{36})\./.exec(host);
    if (!match || projectPreviewHost(match[1], suffix) !== host)
      throw Error('PROJECT_PREVIEW_HOST');
    const url = new URL(req.url, originFor(match[1]));
    if (
      url.origin !== originFor(match[1]) ||
      url.username ||
      url.password ||
      url.pathname.length + url.search.length > 4096
    )
      throw Error('PROJECT_PREVIEW_PATH');
    const cookie = String(req.headers.cookie ?? '')
      .split(';')
      .map((x) => x.trim())
      .filter((x) => x.startsWith(cookieName + '='));
    if (cookie.length > 1) throw Error('PROJECT_PREVIEW_COOKIE');
    return {
      id: match[1],
      url,
      token: cookie[0]?.slice(cookieName.length + 1) ?? '',
    };
  }
  const authorize = (id, token) => resolveAccess(id, token);
  const authorizeTarget = async (id, token, target) => {
    const fresh = await authorize(id, token);
    for (const key of [
      'serviceId',
      'organizationId',
      'workspaceId',
      'ownerId',
      'backend',
      'deviceId',
      'operationId',
      'attemptId',
      'containerId',
      'imageDigest',
      'port',
      'hardDeadlineAt',
    ])
      if (fresh[key] !== target[key])
        throw Error('PROJECT_PREVIEW_TARGET_CHANGED');
    return fresh;
  };
  function headers(req, id) {
    const out = {};
    for (const key of [
      'accept',
      'accept-language',
      'content-type',
      'if-none-match',
      'if-modified-since',
      'range',
    ]) {
      const value = req.headers[key];
      if (
        typeof value === 'string' &&
        value.length <= 8192 &&
        !/[\r\n\0]/.test(value)
      )
        out[key] = value;
    }
    if (req.headers.origin !== undefined) {
      if (req.headers.origin !== originFor(id))
        throw Error('PROJECT_PREVIEW_ORIGIN');
      out.origin = originFor(id);
    }
    return out;
  }
  // Reserve before authorization/open. Routing membership is not a lifetime:
  // a disconnected owner remains here until its started work and channel join.
  function reserve(endpointClosed, stopEndpoint) {
    const work = createPendingWork(),
      timers = new Set();
    const state = { closed: false, channel: null, done: null, work };
    let channelCompletion;
    const closeChannel = () => {
      if (!state.channel || channelCompletion) return;
      try {
        channelCompletion = Promise.resolve(state.channel.close());
      } catch (error) {
        channelCompletion = Promise.reject(error);
      }
      // Observe immediately; the owner joins this same result after its work.
      void channelCompletion.catch(() => undefined);
    };
    active.add(state);
    state.requestClose = () => {
      if (state.closed) return;
      state.closed = true;
      for (const timer of timers) {
        clearInterval(timer);
        clearTimeout(timer);
      }
      timers.clear();
      stopEndpoint();
      // Termination can release a backpressured send. Signal now rather than
      // waiting for the work that needs that termination to complete.
      closeChannel();
      state.done = (async () => {
        await endpointClosed;
        await work.drain();
        // A late opener assigned its channel before leaving the tracked body.
        closeChannel();
        await channelCompletion;
      })();
      void state.done.then(
        () => active.delete(state),
        () => {
          cleanupFailed = true;
          active.delete(state);
        },
      );
    };
    state.guard = () => {
      if (state.closed || stopping) throw Error('PROJECT_PREVIEW_CLOSED');
    };
    state.watch = (id, token, target) => {
      if (state.closed || stopping) return;
      let checking = false;
      const timer = setInterval(() => {
        if (checking || state.closed || stopping) return;
        checking = true;
        void work
          .run(() => authorizeTarget(id, token, target))
          .catch(() => {
            state.requestClose();
          })
          .finally(() => {
            checking = false;
          });
      }, 2000);
      timer.unref();
      timers.add(timer);
    };
    state.timeout = (body, ms) => {
      if (state.closed || stopping) return;
      const timer = setTimeout(body, ms);
      timer.unref();
      timers.add(timer);
    };
    return state;
  }
  function waitForDrain(res) {
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        res.removeListener('drain', drained);
        res.removeListener('close', closed);
        res.removeListener('error', failed);
        if (error) reject(error);
        else resolve();
      };
      const drained = () => finish(),
        closed = () => finish(Error('PROJECT_PREVIEW_CLOSED')),
        failed = (error) => finish(error),
        timer = setTimeout(
          () => finish(Error('PROJECT_PREVIEW_BACKPRESSURE')),
          2500,
        );
      res.once('drain', drained);
      res.once('close', closed);
      res.once('error', failed);
      if (res.destroyed) closed();
    });
  }
  return {
    matches,
    request(req, res) {
      const failure = (status) => {
        if (res.destroyed || res.writableEnded) return;
        if (!res.headersSent)
          res.writeHead(status, {
            'cache-control': 'private, no-store',
            'content-type': 'text/plain; charset=utf-8',
            'referrer-policy': 'no-referrer',
          });
        res.end('预览已停止或授权已失效，请回到 AllRice 刷新状态。');
      };
      if (stopping || active.size >= 64) {
        failure(503);
        return Promise.resolve();
      }
      const endpointClosed = new Promise((resolve) => {
        res.once('finish', resolve);
        res.once('close', resolve);
      });
      const state = reserve(endpointClosed, () => {
        if (!res.writableEnded) res.destroy();
        if (!req.complete) req.destroy();
      });
      req.once('aborted', state.requestClose);
      res.once('finish', state.requestClose);
      res.once('close', state.requestClose);
      res.on('error', state.requestClose);
      return state.work.run(async () => {
        try {
          state.guard();
          const { id, url, token } = identity(req),
            bootstrap = url.searchParams.get('_allrice_preview_ticket');
          if (bootstrap) {
            if (
              req.method !== 'GET' ||
              url.searchParams.size !== 1 ||
              url.pathname !== '/'
            )
              throw Error('PROJECT_PREVIEW_BOOTSTRAP');
            const target = await authorize(id, bootstrap);
            state.guard();
            res.writeHead(303, {
              'cache-control': 'private, no-store',
              'referrer-policy': 'no-referrer',
              'set-cookie': `${cookieName}=${bootstrap}; Path=/; HttpOnly; SameSite=Strict; ${secure ? 'Secure; ' : ''}Max-Age=${Math.max(1, Math.min(1800, Math.floor((Date.parse(target.hardDeadlineAt) - Date.now()) / 1000)))}`,
              location: '/',
            });
            res.end();
            return;
          }
          const target = await authorize(id, token),
            forward = headers(req, id);
          state.guard();
          if (
            req.method !== 'GET' &&
            req.method !== 'HEAD' &&
            req.headers.origin !== originFor(id)
          )
            throw Error('PROJECT_PREVIEW_ORIGIN');
          state.watch(id, token, target);
          let ended = false,
            received = 0;
          state.channel = await transport.openPreview({
            id: randomUUID(),
            target,
            request: {
              method: req.method,
              path: url.pathname + url.search,
              // The public Host was authenticated above. This private hop reaches
              // only the bound container's loopback port, including dev servers
              // that do not support Vite's additional-host environment setting.
              host: `127.0.0.1:${target.port}`,
              headers: forward,
              websocket: false,
            },
            onFrame: (frame) =>
              state.work.run(async () => {
                if (state.closed) return;
                await authorizeTarget(id, token, target);
                if (state.closed) return;
                if (frame.type === 'preview.response') {
                  if (res.headersSent || frame.status < 200)
                    throw Error('PROJECT_PREVIEW_RESPONSE');
                  const safe = {};
                  for (const name of [
                    'content-type',
                    'etag',
                    'last-modified',
                    'vary',
                  ])
                    if (frame.headers[name]) safe[name] = frame.headers[name];
                  if (frame.headers.location) {
                    const location = new URL(
                      frame.headers.location,
                      originFor(id),
                    );
                    if (
                      location.origin !== originFor(id) ||
                      location.username ||
                      location.password
                    )
                      throw Error('PROJECT_PREVIEW_REDIRECT');
                    safe.location = location.pathname + location.search;
                  }
                  res.writeHead(frame.status, {
                    ...safe,
                    'cache-control': 'private, no-store',
                    'referrer-policy': 'no-referrer',
                    'x-content-type-options': 'nosniff',
                    'content-security-policy': `default-src 'self' blob: data:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${secure ? 'wss:' : 'ws:'}//${projectPreviewHost(id, suffix)}; img-src 'self' blob: data:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors ${frameOrigins.join(' ')}; sandbox allow-scripts allow-same-origin allow-forms`,
                  });
                } else if (frame.type === 'preview.data') {
                  if (!res.headersSent) throw Error('PROJECT_PREVIEW_RESPONSE');
                  const bytes = Buffer.from(frame.data, 'base64');
                  received += bytes.length;
                  if (received > projectServiceLimits.maximumHttpBytes)
                    throw Error('PROJECT_PREVIEW_LIMIT');
                  if (!res.write(bytes)) await waitForDrain(res);
                } else {
                  if (frame.error) throw Error('PROJECT_PREVIEW_UNCONFIRMED');
                  ended = true;
                  res.end();
                }
              }),
            onClose: () => {
              if (!ended) state.requestClose();
            },
          });
          state.guard();
          let size = 0;
          for await (const raw of req) {
            const bytes = Buffer.from(raw);
            size += bytes.length;
            if (size > projectServiceLimits.maximumHttpBytes)
              throw Error('PROJECT_PREVIEW_LIMIT');
            for (let at = 0; at < bytes.length; at += 250_000) {
              await authorizeTarget(id, token, target);
              if (state.closed) throw Error('PROJECT_PREVIEW_CLOSED');
              if (
                !(await state.channel.send({
                  type: 'preview.data',
                  data: bytes.subarray(at, at + 250_000).toString('base64'),
                }))
              )
                throw Error('PROJECT_PREVIEW_UNAVAILABLE');
              state.guard();
            }
          }
          await authorizeTarget(id, token, target);
          if (state.closed) throw Error('PROJECT_PREVIEW_CLOSED');
          if (!(await state.channel.send({ type: 'preview.end' })))
            throw Error('PROJECT_PREVIEW_UNAVAILABLE');
          // A finite request timeout; a successful HTTP response releases it.
          state.timeout(state.requestClose, 15000);
        } catch (error) {
          onError(error);
          failure(403);
          state.requestClose();
        }
      });
    },
    upgrade(req, socket, head) {
      let ws;
      const reject = () => {
        if (!socket.destroyed)
          socket.end(
            'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
            () => socket.destroy(),
          );
      };
      socket.on('error', () => undefined);
      if (stopping || active.size >= 64) {
        reject();
        return Promise.resolve();
      }
      const endpointClosed = new Promise((resolve) =>
        socket.once('close', resolve),
      );
      const state = reserve(endpointClosed, () => {
        ws?.terminate();
        socket.destroy();
      });
      socket.once('close', state.requestClose);
      let ready;
      const channelReady = new Promise((resolve) => {
        ready = resolve;
      });
      return state.work.run(async () => {
        try {
          state.guard();
          const { id, url, token } = identity(req);
          if (
            req.method !== 'GET' ||
            url.searchParams.has('_allrice_preview_ticket') ||
            req.headers.origin !== originFor(id) ||
            req.headers.upgrade?.toLowerCase() !== 'websocket'
          )
            throw Error('PROJECT_PREVIEW_UPGRADE');
          const protocolHeader = req.headers['sec-websocket-protocol'];
          if (
            protocolHeader !== undefined &&
            (typeof protocolHeader !== 'string' ||
              !/^[a-zA-Z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(protocolHeader))
          )
            throw Error('PROJECT_PREVIEW_PROTOCOL');
          const target = await authorize(id, token);
          state.guard();
          state.watch(id, token, target);
          state.channel = await transport.openPreview({
            id: randomUUID(),
            target,
            request: {
              method: 'GET',
              path: url.pathname + url.search,
              host: `127.0.0.1:${target.port}`,
              headers: headers(req, id),
              websocket: true,
              ...(protocolHeader ? { protocol: protocolHeader } : {}),
            },
            onFrame: (frame) =>
              state.work.run(async () => {
                if (state.closed) return;
                await authorizeTarget(id, token, target);
                if (state.closed) return;
                if (frame.type === 'preview.response') {
                  if (
                    frame.status !== 101 ||
                    ws ||
                    (frame.headers['sec-websocket-protocol'] !==
                      protocolHeader &&
                      !(
                        frame.headers['sec-websocket-protocol'] === undefined &&
                        protocolHeader === undefined
                      ))
                  )
                    throw Error('PROJECT_PREVIEW_UPGRADE');
                  wss.handleUpgrade(req, socket, head, (client) => {
                    ws = client;
                    let pending = 0,
                      queue = Promise.resolve();
                    client.on('error', state.requestClose);
                    client.once('close', state.requestClose);
                    client.on('message', (bytes, binary) => {
                      if (state.closed || stopping) return;
                      pending += bytes.length;
                      if (pending > 1_000_000) {
                        state.requestClose();
                        return;
                      }
                      queue = state.work.track(
                        queue
                          .then(async () => {
                            state.guard();
                            await channelReady;
                            state.guard();
                            await authorizeTarget(id, token, target);
                            if (state.closed)
                              throw Error('PROJECT_PREVIEW_CLOSED');
                            if (
                              !(await state.channel.send({
                                type: 'preview.data',
                                data: Buffer.from(bytes).toString('base64'),
                                binary,
                              }))
                            )
                              throw Error('PROJECT_PREVIEW_UNAVAILABLE');
                            state.guard();
                          })
                          .catch(() => {
                            state.requestClose();
                          })
                          .finally(() => (pending -= bytes.length)),
                      );
                    });
                  });
                } else if (frame.type === 'preview.data') {
                  if (
                    !ws ||
                    ws.readyState !== WebSocket.OPEN ||
                    ws.bufferedAmount > 1_000_000
                  )
                    throw Error('PROJECT_PREVIEW_BACKPRESSURE');
                  await new Promise((resolve, reject) =>
                    ws.send(
                      Buffer.from(frame.data, 'base64'),
                      { binary: frame.binary === true },
                      (error) => (error ? reject(error) : resolve()),
                    ),
                  );
                } else state.requestClose();
              }),
            onClose: state.requestClose,
          });
          ready();
          state.guard();
          state.timeout(() => {
            if (!ws) state.requestClose();
          }, 5000);
        } catch (error) {
          onError(error);
          reject();
          state.requestClose();
        } finally {
          ready();
        }
      });
    },
    close() {
      if (closing) return closing;
      stopping = true;
      const owners = [...active];
      for (const state of owners) state.requestClose();
      closing = (async () => {
        const results = await Promise.allSettled(
          owners.map((state) => state.done),
        );
        await new Promise((resolve) => wss.close(resolve));
        if (
          cleanupFailed ||
          results.some((result) => result.status === 'rejected')
        )
          throw Error('PROJECT_PREVIEW_CLEANUP_UNCONFIRMED');
      })();
      return closing;
    },
  };
}
