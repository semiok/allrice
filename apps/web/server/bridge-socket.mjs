import { Buffer } from 'node:buffer';
import { request as httpRequest } from 'node:http';
import {
  clearInterval,
  clearTimeout,
  setInterval,
  setTimeout,
} from 'node:timers';
import { URL } from 'node:url';

import {
  BridgeSocketRequestSchema,
  bridgeSocketMaximumBufferedBytes,
  bridgeSocketMaximumFrameBytes,
  bridgeSocketOperationPath,
  bridgeSocketPath,
  bridgeSocketProtocol,
  ProjectPreviewClientFrameSchema,
  ProjectPreviewServerFrameSchema,
} from '@allrice/contracts';
import { WebSocketServer, WebSocket } from 'ws';
import { createPendingWork } from './pending-work.mjs';

/** Fixed loopback adapter. Caller controls only a strict RPC action, never a URL or headers. */
export function createBridgeLoopbackDispatch(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('INVALID_LOOPBACK_PORT');
  return (token, frame, host) =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(frame.body ?? {});
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: bridgeSocketOperationPath(frame),
          method: 'POST',
          headers: {
            host,
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(data),
          },
        },
        (res) => {
          const chunks = [];
          let bytes = 0;
          res.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > bridgeSocketMaximumFrameBytes - 1024) {
              res.destroy();
              req.destroy(new Error('RESPONSE_TOO_LARGE'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () => {
            try {
              resolve({
                status: res.statusCode ?? 502,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              });
            } catch {
              reject(new Error('INVALID_OPERATION_RESPONSE'));
            }
          });
        },
      );
      const timer = setTimeout(
        () => req.destroy(new Error('OPERATION_RESPONSE_TIMEOUT')),
        10_000,
      );
      req.on('close', () => clearTimeout(timer));
      req.on('error', reject);
      req.end(data);
    });
}

function validHost(value) {
  if (
    typeof value !== 'string' ||
    value.length > 255 ||
    /[\s/@\\?#]/.test(value)
  )
    return false;
  try {
    return new URL(`http://${value}`).host === value.toLowerCase();
  } catch {
    return false;
  }
}

/** Transport-only gateway; all claims, starts, output and receipts reuse the existing HTTP authority. */
export async function createBridgeSocketGateway({
  authority,
  dispatch,
  enabled = () => false,
  heartbeatMs = 5000,
  maximumConnections = 256,
  authenticationTimeoutMs = 5000,
}) {
  if (
    !Number.isInteger(heartbeatMs) ||
    heartbeatMs < 100 ||
    heartbeatMs > 10_000
  )
    throw new Error('INVALID_SOCKET_HEARTBEAT');
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    perMessageDeflate: false,
    maxPayload: bridgeSocketMaximumFrameBytes,
    handleProtocols: (protocols) =>
      protocols.has(bridgeSocketProtocol) ? bridgeSocketProtocol : false,
  });

  const clients = new Set(),
    ownedClients = new Set(),
    previews = new Map(),
    ownedPreviews = new Set(),
    admissions = new Set(),
    work = createPendingWork();
  let stopping = false,
    closing,
    cleanupFailed = false,
    authenticating = 0,
    pendingBytes = 0;
  const observeCleanup = (done, remove) => {
    void done.then(remove, () => {
      cleanupFailed = true;
      remove();
    });
  };
  // Signal without returning the drain: queue/error callbacks must not await
  // the completion that includes themselves.
  const terminate = (
    client,
    code = 4009,
    reason = 'CONNECTION_UNAVAILABLE',
  ) => {
    if (client.closing) return;
    client.closing = true;
    clients.delete(client);
    const entries = [...client.previews];
    for (const entry of entries) entry.requestClose();
    client.ws.close(code, reason);
    const timer = setTimeout(() => client.ws.terminate(), 1000);
    timer.unref();
    client.ws.once('close', () => clearTimeout(timer));
    client.done = (async () => {
      await client.socketClosed;
      await client.work.drain();
      const results = await Promise.allSettled(
        entries.map((entry) => entry.done),
      );
      // Includes current()/renew promises that lost their decision timeout.
      // Never release early and then let a late renewal resurrect the lease.
      await authority.release(client.connection);
      if (results.some((result) => result.status === 'rejected'))
        throw Error('BRIDGE_PREVIEW_CLEANUP_UNCONFIRMED');
    })();
    observeCleanup(client.done, () => ownedClients.delete(client));
  };
  const sendAsync = (client, frame) => {
    if (stopping || client.closing || client.ws.readyState !== WebSocket.OPEN)
      return Promise.resolve(false);
    const data = JSON.stringify(frame),
      length = Buffer.byteLength(data);
    if (
      length > bridgeSocketMaximumFrameBytes ||
      client.ws.bufferedAmount + length > bridgeSocketMaximumBufferedBytes ||
      [...clients].reduce((bytes, item) => bytes + item.ws.bufferedAmount, 0) +
        length >
        16 * 1024 * 1024
    ) {
      terminate(client, 4013, 'OUTPUT_BACKPRESSURE');
      return Promise.resolve(false);
    }
    return client.work.run(async () => {
      if (stopping || client.closing || client.ws.readyState !== WebSocket.OPEN)
        return false;
      return new Promise((resolve) =>
        client.ws.send(data, (error) => {
          if (error) terminate(client);
          resolve(!error);
        }),
      );
    });
  };
  const send = (client, frame) => {
    void sendAsync(client, frame);
  };
  const current = async (client, renew = false) => {
    if (stopping || !enabled() || client.closing) return false;
    let timeout;
    try {
      const pending = client.work.run(() =>
        authority.current(client.connection, renew),
      );
      const ok = await Promise.race([
        pending,
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve(false), 2500);
        }),
      ]);
      return ok && !stopping && enabled() && !client.closing;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  };
  const unsubscribe = await authority.subscribe((deviceId, kind) => {
    if (stopping) return;
    for (const client of clients) {
      if (client.connection.deviceId !== deviceId || client.closing) continue;
      if (kind === 'work') {
        if (client.wakeupPending) continue;
        client.wakeupPending = true;
        void client.work
          .run(async () => {
            if (await current(client))
              send(client, { version: 1, type: 'wakeup' });
            else terminate(client);
          })
          .finally(() => {
            client.wakeupPending = false;
          });
      } else {
        void client.work.run(async () => {
          if (!(await current(client))) terminate(client);
        });
      }
    }
  });
  const timer = setInterval(() => {
    if (stopping) return;
    for (const client of clients) {
      if (client.checking || client.closing) continue;
      client.checking = true;
      void client.work
        .run(async () => {
          if (!client.alive || !(await current(client, true))) {
            terminate(client);
            return;
          }
          if (stopping || client.closing) return;
          client.alive = false;
          client.ws.ping();
        })
        .catch(() => {
          terminate(client);
        })
        .finally(() => {
          client.checking = false;
        });
    }
  }, heartbeatMs);
  timer.unref();

  function previewOwner(client, id, onFrame, onClose) {
    const entry = {
      client,
      id,
      onFrame,
      work: createPendingWork(),
      queue: Promise.resolve(),
      bytes: 0,
      closed: false,
      terminal: false,
      done: null,
    };
    ownedPreviews.add(entry);
    client.previews.add(entry);
    previews.set(id, entry);
    entry.requestClose = () => {
      if (entry.closed) return;
      entry.closed = true;
      previews.delete(id);
      if (!entry.terminal && !client.closing)
        entry.work.track(
          sendAsync(client, {
            version: 1,
            type: 'preview.end',
            id,
            error: true,
          }),
        );
      entry.done = (async () => {
        await entry.work.drain();
        await onClose?.();
      })();
      observeCleanup(entry.done, () => {
        ownedPreviews.delete(entry);
        client.previews.delete(entry);
      });
    };
    entry.close = () => {
      entry.requestClose();
      return entry.done;
    };
    return entry;
  }

  return {
    openPreview(input) {
      if (stopping || !enabled())
        return Promise.reject(Error('PROJECT_PREVIEW_UNAVAILABLE'));
      const { target, request, id, onFrame, onClose } = input;
      const client = [...clients].find(
        (c) =>
          c.connection.deviceId === target.deviceId &&
          c.connection.organizationId === target.organizationId &&
          c.connection.workspaceId === target.workspaceId &&
          !c.closing,
      );
      if (
        !client ||
        ownedPreviews.size >= 64 ||
        client.previews.size >= 8 ||
        previews.has(id)
      )
        return Promise.reject(Error('PROJECT_PREVIEW_UNAVAILABLE'));
      // Reserve before current(), so parallel openers cannot evade capacity.
      const entry = previewOwner(client, id, onFrame, onClose);
      return work.run(() =>
        entry.work.run(async () => {
          try {
            if (!(await current(client)) || stopping || entry.closed)
              throw Error('PROJECT_PREVIEW_UNAVAILABLE');
            if (
              !(await sendAsync(
                client,
                ProjectPreviewServerFrameSchema.parse({
                  version: 1,
                  type: 'preview.open',
                  id,
                  target,
                  request,
                }),
              ))
            )
              throw Error('PROJECT_PREVIEW_UNAVAILABLE');
            if (stopping || client.closing || entry.closed)
              throw Error('PROJECT_PREVIEW_UNAVAILABLE');
            return {
              send: (frame) => {
                if (entry.closed || client.closing || stopping)
                  return Promise.resolve(false);
                return entry.work.run(async () => {
                  if (!(await current(client))) {
                    terminate(client);
                    return false;
                  }
                  if (entry.closed || client.closing || stopping) return false;
                  return sendAsync(
                    client,
                    ProjectPreviewServerFrameSchema.parse({
                      ...frame,
                      version: 1,
                      id,
                    }),
                  );
                });
              },
              close: entry.close,
            };
          } catch (error) {
            entry.requestClose();
            throw error;
          }
        }),
      );
    },
    matches(request) {
      return request.url?.split('?')[0] === bridgeSocketPath;
    },
    upgrade(request, socket, head) {
      const reject = (status) => {
        if (!socket.destroyed)
          socket.end(
            'HTTP/1.1 ' +
              status +
              '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
            () => socket.destroy(),
          );
      };
      socket.on('error', () => undefined);
      if (stopping || !enabled()) {
        reject('404 Not Found');
        return Promise.resolve();
      }
      if (
        request.url !== bridgeSocketPath ||
        request.method !== 'GET' ||
        request.headers.upgrade?.toLowerCase() !== 'websocket' ||
        request.headers.origin !== undefined ||
        !validHost(request.headers.host) ||
        request.headers['sec-websocket-version'] !== '13' ||
        typeof request.headers['sec-websocket-key'] !== 'string' ||
        !/^[+/0-9A-Za-z]{22}==$/.test(request.headers['sec-websocket-key']) ||
        request.headers['sec-websocket-protocol'] !== bridgeSocketProtocol
      ) {
        reject('400 Bad Request');
        return Promise.resolve();
      }
      const auth = request.headers.authorization,
        token =
          typeof auth === 'string' && /^Bearer [^\s]{1,256}$/.test(auth)
            ? auth.slice(7)
            : null;
      if (!token) {
        reject('401 Unauthorized');
        return Promise.resolve();
      }
      if (
        ownedClients.size + authenticating >= maximumConnections ||
        authenticating >= 32
      ) {
        reject('503 Service Unavailable');
        return Promise.resolve();
      }
      authenticating++;
      const admission = { stop: () => socket.destroy() };
      admissions.add(admission);
      const socketClosed = new Promise((resolve) =>
        socket.once('close', resolve),
      );
      const timeout = setTimeout(admission.stop, authenticationTimeoutMs);
      let connection,
        handedOff = false;
      return work.run(async () => {
        try {
          connection = await authority.register(token);
          if (socket.destroyed || stopping || !enabled())
            throw Error('BRIDGE_STOPPING');
          const ok = await authority.current(connection);
          if (!ok || socket.destroyed || stopping || !enabled())
            throw Error('BRIDGE_STOPPING');
          wss.handleUpgrade(request, socket, head, (ws) => {
            if (stopping || socket.destroyed || !enabled()) {
              ws.terminate();
              return;
            }
            handedOff = true;
            const client = {
              ws,
              connection,
              socketClosed,
              work: createPendingWork(),
              previews: new Set(),
              alive: true,
              checking: false,
              closing: false,
              done: null,
              pending: 0,
              pendingBytes: 0,
              requestIds: new Set(),
              queue: Promise.resolve(),
              wakeupPending: false,
            };
            clients.add(client);
            ownedClients.add(client);
            ws.on('error', () => terminate(client));
            ws.on('pong', () => {
              client.alive = true;
            });
            ws.once('close', () => terminate(client));
            ws.on('message', (data, isBinary) => {
              if (stopping || client.closing) return;
              if (!isBinary && data.length <= bridgeSocketMaximumFrameBytes) {
                let parsed;
                try {
                  parsed = JSON.parse(data.toString('utf8'));
                } catch {
                  /* strict RPC path below */
                }
                if (
                  typeof parsed?.type === 'string' &&
                  parsed.type.startsWith('preview.')
                ) {
                  let frame;
                  try {
                    frame = ProjectPreviewClientFrameSchema.parse(parsed);
                  } catch {
                    terminate(client, 4000, 'INVALID_PREVIEW_FRAME');
                    return;
                  }
                  const entry = previews.get(frame.id);
                  if (!entry) return;
                  if (entry.client !== client) {
                    terminate(client, 4000, 'PREVIEW_IDENTITY');
                    return;
                  }
                  entry.bytes += data.length;
                  if (entry.bytes > bridgeSocketMaximumBufferedBytes) {
                    terminate(client, 4013, 'PREVIEW_BACKPRESSURE');
                    return;
                  }
                  entry.queue = entry.work.track(
                    entry.queue
                      .then(async () => {
                        if (stopping || entry.closed || client.closing) return;
                        if (!(await current(client))) {
                          terminate(client);
                          return;
                        }
                        if (stopping || entry.closed || client.closing) return;
                        // A normal terminal notification must not become an abort
                        // when the public endpoint finishes inside onFrame.
                        if (frame.type === 'preview.end' && !frame.error)
                          entry.terminal = true;
                        await entry.onFrame(frame);
                        if (frame.type === 'preview.end') entry.requestClose();
                      })
                      .catch(() => {
                        entry.requestClose();
                      })
                      .finally(() => {
                        entry.bytes -= data.length;
                      }),
                  );
                  return;
                }
              }
              if (
                isBinary ||
                client.pending >= 8 ||
                client.pendingBytes + data.length >
                  bridgeSocketMaximumBufferedBytes ||
                pendingBytes + data.length > 8 * 1024 * 1024
              ) {
                terminate(client, 4013, 'INPUT_BACKPRESSURE');
                return;
              }
              let frame;
              try {
                frame = BridgeSocketRequestSchema.parse(
                  JSON.parse(data.toString('utf8')),
                );
              } catch {
                terminate(client, 4000, 'INVALID_FRAME');
                return;
              }
              if (client.requestIds.has(frame.id)) {
                terminate(client, 4000, 'DUPLICATE_PENDING_REQUEST');
                return;
              }
              client.pending++;
              client.pendingBytes += data.length;
              pendingBytes += data.length;
              client.requestIds.add(frame.id);
              client.queue = client.work.track(
                client.queue
                  .then(async () => {
                    if (!(await current(client))) {
                      terminate(client);
                      return;
                    }
                    if (stopping || client.closing) return;
                    let result;
                    try {
                      result = await dispatch(
                        token,
                        frame,
                        request.headers.host,
                      );
                    } catch {
                      terminate(client, 4011, 'OPERATION_RESPONSE_UNAVAILABLE');
                      return;
                    }
                    if (!(await current(client))) {
                      terminate(client);
                      return;
                    }
                    if (stopping || client.closing) return;
                    send(client, {
                      version: 1,
                      type: 'response',
                      id: frame.id,
                      ...result,
                    });
                  })
                  .catch(() => {
                    terminate(client);
                  })
                  .finally(() => {
                    client.pending--;
                    client.pendingBytes -= data.length;
                    pendingBytes -= data.length;
                    client.requestIds.delete(frame.id);
                  }),
              );
            });
            send(client, {
              version: 1,
              type: 'welcome',
              connectionId: connection.connectionId,
              deviceId: connection.deviceId,
              epoch: connection.epoch,
              heartbeatMs,
              maximumFrameBytes: bridgeSocketMaximumFrameBytes,
            });
          });
        } catch (error) {
          reject(
            error?.code === 'device_unauthorized'
              ? '401 Unauthorized'
              : '503 Service Unavailable',
          );
        } finally {
          clearTimeout(timeout);
          try {
            if (!handedOff) {
              socket.destroy();
              // Retain capacity through raw close and the once-only release.
              await socketClosed;
              if (connection) {
                await authority.release(connection);
              }
            }
          } catch {
            cleanupFailed = true;
            // The raw upgrade was already rejected. close() retains this
            // unknown cleanup result instead of reporting success.
          } finally {
            // An unknown cleanup remains latched even after its bounded
            // in-memory admission record retires.
            authenticating--;
            admissions.delete(admission);
          }
        }
      });
    },
    close() {
      if (closing) return closing;
      stopping = true;
      clearInterval(timer);
      for (const admission of admissions) admission.stop();
      const entries = [...ownedPreviews],
        owners = [...ownedClients];
      for (const entry of entries) entry.requestClose();
      for (const client of owners) terminate(client);
      closing = (async () => {
        const results = await Promise.allSettled([
          Promise.resolve().then(unsubscribe),
          work.drain(),
          ...entries.map((entry) => entry.done),
          ...owners.map((client) => client.done),
        ]);
        await new Promise((resolve) => wss.close(resolve));
        if (
          cleanupFailed ||
          results.some((result) => result.status === 'rejected')
        )
          throw Error('BRIDGE_SOCKET_CLEANUP_UNCONFIRMED');
      })();
      return closing;
    },
  };
}
