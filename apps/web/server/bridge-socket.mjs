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
} from '@allrice/contracts';
import { WebSocketServer, WebSocket } from 'ws';

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
  const clients = new Set();
  let stopping = false,
    authenticating = 0,
    pendingBytes = 0;
  const terminate = (
    client,
    code = 4009,
    reason = 'CONNECTION_UNAVAILABLE',
  ) => {
    if (client.closing) return;
    client.closing = true;
    client.ws.close(code, reason);
    const timer = setTimeout(() => client.ws.terminate(), 1000);
    timer.unref();
    client.ws.once('close', () => clearTimeout(timer));
  };
  const send = (client, frame) => {
    if (client.closing || client.ws.readyState !== WebSocket.OPEN) return false;
    const data = JSON.stringify(frame);
    if (
      Buffer.byteLength(data) > bridgeSocketMaximumFrameBytes ||
      client.ws.bufferedAmount + Buffer.byteLength(data) >
        bridgeSocketMaximumBufferedBytes ||
      [...clients].reduce((bytes, item) => bytes + item.ws.bufferedAmount, 0) +
        Buffer.byteLength(data) >
        16 * 1024 * 1024
    ) {
      terminate(client, 4013, 'OUTPUT_BACKPRESSURE');
      return false;
    }
    client.ws.send(data, (error) => {
      if (error) terminate(client);
    });
    return true;
  };
  const current = async (client, renew = false) => {
    if (stopping || !enabled() || client.closing) return false;
    let timeout;
    try {
      return await Promise.race([
        authority.current(client.connection, renew),
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve(false), 2500);
        }),
      ]);
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  };
  // NOTIFY accelerates changes, but every RPC and heartbeat rechecks PostgreSQL.
  const unsubscribe = await authority.subscribe((deviceId, kind) => {
    for (const client of clients)
      if (client.connection.deviceId === deviceId) {
        if (kind === 'work') {
          if (!client.wakeupPending) {
            client.wakeupPending = true;
            void current(client)
              .then((ok) => {
                if (ok) send(client, { version: 1, type: 'wakeup' });
                else terminate(client);
              })
              .finally(() => {
                client.wakeupPending = false;
              });
          }
        } else {
          void current(client).then((ok) => {
            if (!ok) terminate(client);
          });
        }
      }
  });
  const timer = setInterval(() => {
    for (const client of clients) {
      if (client.checking) continue;
      client.checking = true;
      void (async () => {
        if (!client.alive || !(await current(client, true))) {
          terminate(client);
          return;
        }
        client.alive = false;
        client.ws.ping();
      })()
        .catch(() => terminate(client))
        .finally(() => {
          client.checking = false;
        });
    }
  }, heartbeatMs);
  timer.unref();

  return {
    matches(request) {
      return request.url?.split('?')[0] === bridgeSocketPath;
    },
    async upgrade(request, socket, head) {
      const reject = (status) => {
        if (!socket.destroyed)
          socket.end(
            `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
          );
      };
      socket.on('error', () => undefined);
      if (stopping || !enabled()) {
        reject('404 Not Found');
        return;
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
        return;
      }
      const auth = request.headers.authorization;
      const token =
        typeof auth === 'string' && /^Bearer [^\s]{1,256}$/.test(auth)
          ? auth.slice(7)
          : null;
      if (!token) {
        reject('401 Unauthorized');
        return;
      }
      if (
        clients.size + authenticating >= maximumConnections ||
        authenticating >= 32
      ) {
        reject('503 Service Unavailable');
        return;
      }
      authenticating++;
      let connection;
      const timeout = setTimeout(
        () => socket.destroy(),
        authenticationTimeoutMs,
      );
      try {
        connection = await authority.register(token);
        if (
          socket.destroyed ||
          stopping ||
          !enabled() ||
          !(await authority.current(connection))
        ) {
          await authority.release(connection);
          reject('503 Service Unavailable');
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          const client = {
            ws,
            connection,
            alive: true,
            checking: false,
            closing: false,
            pending: 0,
            pendingBytes: 0,
            requestIds: new Set(),
            queue: Promise.resolve(),
            wakeupPending: false,
          };
          clients.add(client);
          ws.on('error', () => terminate(client));
          ws.on('pong', () => {
            client.alive = true;
          });
          ws.on('close', () => {
            clients.delete(client);
            void authority.release(connection).catch(() => undefined);
          });
          ws.on('message', (data, isBinary) => {
            if (client.closing) return;
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
            client.queue = client.queue
              .then(async () => {
                if (!(await current(client))) {
                  terminate(client);
                  return;
                }
                // Do not replay failed/ambiguous dispatches or starts. The client owns retry semantics.
                let result;
                try {
                  result = await dispatch(token, frame, request.headers.host);
                } catch {
                  terminate(client, 4011, 'OPERATION_RESPONSE_UNAVAILABLE');
                  return;
                }
                if (!(await current(client))) {
                  terminate(client);
                  return;
                }
                send(client, {
                  version: 1,
                  type: 'response',
                  id: frame.id,
                  ...result,
                });
              })
              .catch(() => terminate(client))
              .finally(() => {
                client.pending--;
                client.pendingBytes -= data.length;
                pendingBytes -= data.length;
                client.requestIds.delete(frame.id);
              });
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
        if (connection)
          await authority.release(connection).catch(() => undefined);
        reject(
          error?.code === 'device_unauthorized'
            ? '401 Unauthorized'
            : '503 Service Unavailable',
        );
      } finally {
        clearTimeout(timeout);
        authenticating--;
      }
    },
    async close() {
      stopping = true;
      clearInterval(timer);
      await unsubscribe();
      await Promise.all(
        [...clients].map(async (client) => {
          client.closing = true;
          client.ws.terminate();
          await authority.release(client.connection).catch(() => undefined);
        }),
      );
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}
