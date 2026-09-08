import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  BridgeSocketMessageSchema,
  BridgeSocketRequestSchema,
  bridgeSocketMaximumBufferedBytes,
  bridgeSocketMaximumFrameBytes,
  bridgeSocketPath,
  bridgeSocketProtocol,
  type BridgeSocketRequest,
} from '@allrice/contracts';
import {
  bridgeRequest,
  BridgeClientError,
  type BridgeRequestInput,
} from './client.js';

class SocketUnavailable extends Error {
  constructor(readonly sent: boolean) {
    super(
      sent
        ? 'Bridge response unavailable; execution is not replayed'
        : 'Bridge socket unavailable',
    );
  }
}
type Pending = {
  resolve: (value: { status: number; body: unknown }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** WSS is an optional delivery accelerator. PostgreSQL + the device journal own
 * effects and facts. In particular, a sent start with lost ACK is NEVER replayed.
 */
export class BridgeDualTransport {
  private socket: WebSocket | null = null;
  private ready = false;
  private closed = false;
  private connecting: Promise<boolean> | null = null;
  private nextConnectAt = 0;
  private failures = 0;
  private pending = new Map<string, Pending>();
  private wakeups = new Set<() => void>();
  private credentialRejected = false;
  readonly origin: string;
  constructor(
    private readonly config: {
      server: string;
      deviceId: string;
      token: string;
      enabled?: boolean;
      // Transport timing only. Tests still use real network sockets.
      retryBaseMs?: number;
      handshakeTimeoutMs?: number;
    },
  ) {
    const url = new URL(config.server);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['127.0.0.1', '[::1]'].includes(url.hostname)
        ))
    )
      throw new Error('BRIDGE_TRANSPORT_ORIGIN_INVALID');
    if (!/^[^\s]{1,256}$/.test(config.token))
      throw new Error('BRIDGE_TRANSPORT_CREDENTIAL_INVALID');
    this.origin = url.origin;
  }

  private async connect() {
    if (this.credentialRejected)
      throw new BridgeClientError('DEVICE_UNAUTHORIZED', 401);
    if (this.closed || this.config.enabled === false) return false;
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) return true;
    if (this.connecting) return this.connecting;
    if (Date.now() < this.nextConnectAt) return false;
    this.connecting = new Promise<boolean>((resolve) => {
      const url = new URL(bridgeSocketPath, this.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url, bridgeSocketProtocol, {
        headers: { authorization: `Bearer ${this.config.token}` },
        followRedirects: false,
        perMessageDeflate: false,
        maxPayload: bridgeSocketMaximumFrameBytes,
        rejectUnauthorized: true,
        handshakeTimeout: this.config.handshakeTimeoutMs ?? 2500,
      });
      this.socket = socket;
      let settled = false;
      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        settle(false);
        socket.terminate();
      }, this.config.handshakeTimeoutMs ?? 2500);
      const failed = () => {
        if (this.socket !== socket) return;
        this.ready = false;
        this.socket = null;
        const base = this.config.retryBaseMs ?? 1000;
        this.nextConnectAt =
          Date.now() +
          Math.min(30000, base * 2 ** Math.min(5, this.failures++)) *
            (0.75 + Math.random() * 0.5);
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new SocketUnavailable(true));
          this.pending.delete(id);
        }
        settle(false);
      };
      socket.on('error', () => {
        failed();
        socket.terminate();
      });
      socket.on('close', failed);
      socket.on('unexpected-response', (_request, response) => {
        if (response.statusCode === 401 || response.statusCode === 403)
          this.credentialRejected = true;
        response.destroy();
        failed();
        socket.terminate();
      });
      socket.on('message', (data, binary) => {
        try {
          const bytes = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.isBuffer(data)
              ? data
              : Buffer.from(data);
          if (binary || bytes.length > bridgeSocketMaximumFrameBytes)
            throw Error();
          const frame = BridgeSocketMessageSchema.parse(
            JSON.parse(bytes.toString('utf8')),
          );
          if (this.socket !== socket) return;
          if (frame.type === 'welcome') {
            if (
              this.ready ||
              frame.deviceId !== this.config.deviceId ||
              socket.protocol !== bridgeSocketProtocol
            )
              throw Error();
            this.ready = true;
            this.failures = 0;
            this.nextConnectAt = 0;
            settle(true);
          } else {
            if (!this.ready) throw Error();
            if (frame.type === 'wakeup')
              for (const wake of this.wakeups) wake();
            else {
              const p = this.pending.get(frame.id);
              if (!p) return; // a late response never authorizes another request
              this.pending.delete(frame.id);
              clearTimeout(p.timer);
              p.resolve(frame);
            }
          }
        } catch {
          failed();
          socket.terminate();
        }
      });
    }).finally(() => {
      this.connecting = null;
    });
    const connected = await this.connecting;
    if (this.credentialRejected)
      throw new BridgeClientError('DEVICE_UNAUTHORIZED', 401);
    return connected;
  }

  private async rpc(frame: BridgeSocketRequest, timeoutMs: number) {
    if (!(await this.connect()) || this.closed || !this.socket || !this.ready)
      throw new SocketUnavailable(false);
    const socket = this.socket,
      text = JSON.stringify(frame);
    if (Buffer.byteLength(text) > bridgeSocketMaximumFrameBytes)
      throw new BridgeClientError('BODY_TOO_LARGE', 413);
    if (
      this.pending.size >= 8 ||
      socket.bufferedAmount + Buffer.byteLength(text) >
        bridgeSocketMaximumBufferedBytes
    )
      throw new SocketUnavailable(false); // unsent; bounded HTTP call still uses authority
    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(frame.id);
        reject(new SocketUnavailable(true));
        socket.terminate();
      }, timeoutMs);
      this.pending.set(frame.id, { resolve, reject, timer });
      try {
        socket.send(text, (error) => {
          if (error) socket.terminate();
        });
      } catch {
        clearTimeout(timer);
        this.pending.delete(frame.id);
        reject(new SocketUnavailable(true));
        socket.terminate();
      }
    });
  }

  readonly request: typeof bridgeRequest = async <T>(
    input: BridgeRequestInput,
  ): Promise<T> => {
    if (this.closed) throw new SocketUnavailable(false);
    if (
      new URL(input.server).origin !== this.origin ||
      input.token !== this.config.token
    )
      throw new Error('BRIDGE_TRANSPORT_IDENTITY_MISMATCH');
    const match =
      /^\/api\/v1\/bridge\/device\/operations\/(?:(next)|([a-f0-9-]{36})\/(start|heartbeat|output|receipts|service))$/.exec(
        input.path,
      );
    if (input.method !== 'POST' || !match || this.config.enabled === false)
      return bridgeRequest<T>(input);
    if (this.closed) throw new SocketUnavailable(false);
    const action =
      `operation.${match[1] ?? match[3]}` as BridgeSocketRequest['action'];
    const frame = BridgeSocketRequestSchema.parse({
      version: 1,
      type: 'request',
      id: randomUUID(),
      action,
      ...(match[2] ? { operationId: match[2] } : {}),
      body: input.body ?? {},
    });
    try {
      const response = await this.rpc(frame, input.timeoutMs ?? 10000);
      if (
        Buffer.byteLength(JSON.stringify(response.body)) >
        (input.maximumResponseBytes ?? bridgeSocketMaximumFrameBytes)
      )
        throw new BridgeClientError('Bridge response exceeded its limit', 413);
      if (response.status < 200 || response.status >= 300) {
        const code = (response.body as { error?: { code?: unknown } })?.error
          ?.code;
        throw new BridgeClientError(
          typeof code === 'string' && /^[A-Z_]{1,80}$/.test(code)
            ? code
            : `Bridge API returned HTTP ${response.status}`,
          response.status,
        );
      }
      return response.body as T;
    } catch (error) {
      if (!(error instanceof SocketUnavailable)) throw error;
      if (this.closed) throw error;
      // Side effects may already have started despite the transport error. Only
      // identical durable evidence/current-state queries are retryable after send.
      const recoverableNext =
        action === 'operation.next' &&
        (input.body as { supportsClaimRecovery?: boolean })
          ?.supportsClaimRecovery === true;
      if (
        error.sent &&
        !recoverableNext &&
        ![
          'operation.output',
          'operation.receipts',
          'operation.heartbeat',
          'operation.service',
        ].includes(action)
      )
        throw error;
      return bridgeRequest<T>(input);
    }
  };

  async waitForWork(maximumMs = 750) {
    if (this.closed) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakeups.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(30000, Math.max(1, maximumMs)));
      this.wakeups.add(done);
    });
  }

  close() {
    this.closed = true;
    for (const wake of this.wakeups) wake();
    this.socket?.terminate();
  }
}
