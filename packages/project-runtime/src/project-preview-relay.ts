import {
  request as dockerRequest,
  request as httpRequest,
  Agent,
} from 'node:http';
import { Duplex } from 'node:stream';
import WebSocket from 'ws';
import {
  ProjectPreviewServerFrameSchema,
  projectServiceLimits,
  type ProjectPreviewServerFrame,
  type ProjectPreviewClientFrame,
  type ProjectServiceTarget,
} from '@allrice/contracts';
import { RuntimeCommandError } from './errors.js';
export type ProjectPreviewRelayAdapter = {
  api: {
    socketPath: string;
    json<T>(
      method: string,
      path: string,
      body?: unknown,
      timeoutMs?: number,
    ): Promise<T>;
  };
  alive: (target: ProjectServiceTarget) => boolean;
  assertTarget: (target: ProjectServiceTarget) => Promise<void>;
  onError?: (error: unknown) => void;
};

/** A duplex to one fixed container loopback port. Docker stdout is decoded
 * before becoming a socket; no host port, DNS resolution or arbitrary exec. */
/** Internal transport, exported here for deterministic stream boundary checks. */
export class ContainerLoopback extends Duplex {
  private pending = Buffer.alloc(0);
  private incoming = 0;
  private socketEnded = false;
  private readEnded = false;
  private idleTimeout?: ReturnType<typeof setTimeout>;
  private timer: ReturnType<typeof setInterval>;
  private constructor(
    private socket: Duplex,
    private alive: () => boolean,
  ) {
    super();
    this.timer = setInterval(() => {
      if (!alive()) this.destroy(new Error('PROJECT_PREVIEW_REVOKED'));
    }, 1000);
    socket.on('data', (bytes: Buffer) => {
      this.idleTimeout?.refresh();
      this.pending = Buffer.concat([this.pending, bytes]);
      if (this.pending.length > 1_000_000) {
        this.destroy(new Error('PROJECT_PREVIEW_BACKPRESSURE'));
        return;
      }
      this.drainFrames();
    });
    socket.once('end', () => {
      this.socketEnded = true;
      clearTimeout(this.idleTimeout);
      this.drainFrames();
    });
    socket.once('close', () => {
      if (!this.socketEnded)
        this.destroy(new Error('PROJECT_PREVIEW_INCOMPLETE_STREAM'));
    });
    socket.on('error', (e) => this.destroy(e));
  }
  private drainFrames() {
    while (this.pending.length >= 8) {
      const size = this.pending.readUInt32BE(4);
      if (
        this.pending[0] !== 1 ||
        this.pending.readUIntBE(1, 3) !== 0 ||
        size > 500_000
      ) {
        this.destroy(new Error('PROJECT_PREVIEW_INVALID_STREAM'));
        return;
      }
      if (this.pending.length < 8 + size) break;
      const bytes = Buffer.from(this.pending.subarray(8, 8 + size));
      this.pending = this.pending.subarray(8 + size);
      this.incoming += bytes.length;
      if (this.incoming > projectServiceLimits.maximumHttpBytes + 64_000) {
        this.destroy(new Error('PROJECT_PREVIEW_LIMIT'));
        return;
      }
      if (!this.push(bytes)) {
        this.socket.pause();
        return;
      }
    }
    if (this.socketEnded && !this.readEnded) {
      if (this.pending.length) {
        this.destroy(new Error('PROJECT_PREVIEW_INCOMPLETE_STREAM'));
        return;
      }
      this.readEnded = true;
      this.push(null);
    }
  }
  override _read() {
    this.drainFrames();
    this.socket.resume();
  }
  override _write(
    bytes: Buffer,
    _encoding: BufferEncoding,
    done: (e?: Error | null) => void,
  ) {
    if (!this.alive()) {
      done(new Error('PROJECT_PREVIEW_REVOKED'));
      return;
    }
    this.idleTimeout?.refresh();
    this.socket.write(bytes, done);
  }
  override _final(done: () => void) {
    if (
      this.socket.writableEnded ||
      this.socket.writableFinished ||
      this.socket.destroyed
    )
      done();
    else this.socket.end(done);
  }
  override _destroy(error: Error | null, done: (e?: Error | null) => void) {
    clearInterval(this.timer);
    clearTimeout(this.idleTimeout);
    this.socket.destroy();
    done(error);
  }
  setNoDelay() {
    return this;
  }
  setKeepAlive() {
    return this;
  }
  setTimeout(ms: number, callback?: () => void) {
    if (callback) this.once('timeout', callback);
    clearTimeout(this.idleTimeout);
    if (ms > 0) {
      this.idleTimeout = setTimeout(() => {
        if (!this.destroyed) this.emit('timeout');
      }, ms);
      this.idleTimeout.unref();
    }
    return this;
  }
  static async connect(
    adapter: ProjectPreviewRelayAdapter,
    target: ProjectServiceTarget,
    alive: () => boolean,
  ) {
    // Node is pinned by the existing project toolchain; this trusted relay only
    // moves bytes to 127.0.0.1 inside the exact already-approved container.
    const code =
      "const n=require('node:net');const s=n.connect({host:'127.0.0.1',port:Number(process.argv[1])});const end=()=>{s.destroy();process.exit(0)};process.stdin.once('end',end);process.stdin.once('error',end);s.once('error',end);s.once('close',end);process.stdin.pipe(s);s.pipe(process.stdout);setTimeout(end,Number(process.argv[2])-Date.now()).unref();";
    const exec = await adapter.api.json<{ Id: string }>(
      'POST',
      `/containers/${target.containerId}/exec`,
      {
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: false,
        Tty: false,
        Privileged: false,
        User: '1000:1000',
        WorkingDir: '/tmp',
        Cmd: [
          '/usr/local/bin/node',
          // This byte relay has no compute work. Avoid four V8 worker threads
          // per browser request exhausting the existing 64-process sandbox.
          '--v8-pool-size=1',
          '--eval',
          code,
          String(target.port),
          String(Date.parse(target.hardDeadlineAt)),
        ],
      },
      2000,
    );
    if (!/^[a-f0-9]{64}$/.test(exec.Id) || !alive())
      throw new RuntimeCommandError('EXECUTION_REVOKED');
    return new Promise<ContainerLoopback>((resolve, reject) => {
      const req = dockerRequest({
        socketPath: adapter.api.socketPath,
        path: `/v1.45/exec/${exec.Id}/start`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          connection: 'Upgrade',
          upgrade: 'tcp',
        },
      });
      const timer = setTimeout(
        () => req.destroy(new Error('PROJECT_PREVIEW_TIMEOUT')),
        2500,
      );
      req.once('upgrade', (res, socket, head) => {
        clearTimeout(timer);
        if (res.statusCode !== 101 || !alive()) {
          socket.destroy();
          reject(new Error('PROJECT_PREVIEW_UNAVAILABLE'));
          return;
        }
        const stream = new ContainerLoopback(socket, alive);
        stream.on('error', () => undefined);
        if (head.length) socket.emit('data', head);
        resolve(stream);
      });
      req.once('response', (res) => {
        clearTimeout(timer);
        res.destroy();
        reject(new Error('PROJECT_PREVIEW_UNAVAILABLE'));
      });
      req.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      req.end(JSON.stringify({ Detach: false, Tty: false }));
    });
  }
}
type Sender = (frame: ProjectPreviewClientFrame) => Promise<boolean>;
type Entry = {
  target: ProjectServiceTarget;
  request: Extract<
    ProjectPreviewServerFrame,
    { type: 'preview.open' }
  >['request'];
  send: Sender;
  queue: Promise<void>;
  size: number;
  body: Buffer[];
  end: () => void;
  socket?: WebSocket;
  stream?: ContainerLoopback;
  ready: boolean;
  closed: boolean;
  sequence: number;
  pending?: {
    sequence: number;
    timer: ReturnType<typeof setTimeout>;
    resolve: () => void;
    reject: (error: Error) => void;
  };
};
/** The existing Bridge channel transports HTTP and WS for the existing process
 * manager. Uncertain writes are closed, never moved to HTTP fallback or replayed. */
export class ContainerProjectPreviewRelay {
  private entries = new Map<string, Entry>();
  constructor(private adapter: ProjectPreviewRelayAdapter) {}
  receive(raw: ProjectPreviewServerFrame, send: Sender) {
    const frame = ProjectPreviewServerFrameSchema.parse(raw);
    if (frame.type === 'preview.open') {
      if (this.entries.has(frame.id) || this.entries.size >= 8) {
        void send({
          version: 1,
          type: 'preview.end',
          id: frame.id,
          error: true,
        });
        return;
      }
      const e: Entry = {
        target: frame.target,
        request: frame.request,
        send,
        queue: Promise.resolve(),
        size: 0,
        body: [],
        end: () => undefined,
        ready: false,
        closed: false,
        sequence: 0,
      };
      e.end = () => {
        if (e.closed) return;
        e.closed = true;
        if (e.pending) {
          clearTimeout(e.pending.timer);
          e.pending.reject(Error('PROJECT_PREVIEW_CLOSED'));
          e.pending = undefined;
        }
        this.entries.delete(frame.id);
        e.socket?.terminate();
        e.stream?.destroy();
      };
      if (e.request.flowControl === 'consumed-ack-v1') {
        e.send = async (outgoing) => {
          if (outgoing.type !== 'preview.data') return send(outgoing);
          if (e.closed || e.pending || !this.alive(e.target))
            throw Error('PROJECT_PREVIEW_UNAVAILABLE');
          const sequence = ++e.sequence;
          // Register before send; ws.send only confirms local enqueue, not that
          // Web has authorized and consumed bytes. One waiter per channel.
          let resolveAck!: () => void, rejectAck!: (error: Error) => void;
          const ack = new Promise<void>((resolve, reject) => {
            resolveAck = resolve;
            rejectAck = reject;
          });
          const remaining = Math.min(
            6500,
            Date.parse(e.target.hardDeadlineAt) - Date.now(),
          );
          const pending = {
            sequence,
            resolve: resolveAck,
            reject: rejectAck,
            timer: setTimeout(
              () => rejectAck(Error('PROJECT_PREVIEW_ACK_TIMEOUT')),
              Math.max(0, remaining),
            ),
          };
          e.pending = pending;
          try {
            await Promise.all([
              Promise.resolve()
                .then(() => send({ ...outgoing, sequence }))
                .then((ok) => {
                  if (!ok) throw Error('PROJECT_PREVIEW_BACKPRESSURE');
                }),
              ack,
            ]);
            return true;
          } finally {
            if (e.pending === pending) {
              clearTimeout(pending.timer);
              pending.reject(Error('PROJECT_PREVIEW_CLOSED'));
              e.pending = undefined;
            }
          }
        };
      }
      this.entries.set(frame.id, e);
      e.queue = this.open(frame.id, e).catch((error) => {
        this.adapter.onError?.(error);
        void send({
          version: 1,
          type: 'preview.end',
          id: frame.id,
          error: true,
        });
        e.end();
      });
      return;
    }
    const e = this.entries.get(frame.id);
    if (!e) return;
    // This must run outside e.queue: HTTP/WS send waits for this ACK inside
    // that queue. Closing an id drops late ACKs without replay or resurrection.
    if (frame.type === 'preview.ack') {
      if (
        !e.pending ||
        frame.sequence !== e.pending.sequence ||
        !this.alive(e.target)
      ) {
        void send({
          version: 1,
          type: 'preview.end',
          id: frame.id,
          error: true,
        });
        e.end();
        return;
      }
      const pending = e.pending;
      e.pending = undefined;
      clearTimeout(pending.timer);
      pending.resolve();
      return;
    }
    if (frame.type === 'preview.end' && frame.error) {
      e.end();
      return;
    }
    if (frame.type === 'preview.data') {
      e.size += Buffer.byteLength(frame.data, 'base64');
      if (
        e.size >
        (e.request.websocket
          ? 16_000_000
          : projectServiceLimits.maximumHttpBytes)
      ) {
        e.end();
        return;
      }
    }
    e.queue = e.queue
      .then(async () => {
        if (e.closed) return;
        if (!this.alive(e.target)) throw Error('PROJECT_PREVIEW_REVOKED');
        if (frame.type === 'preview.data') {
          const bytes = Buffer.from(frame.data, 'base64');
          if (e.request.websocket) {
            if (!e.ready || !e.socket) throw Error('PROJECT_PREVIEW_NOT_READY');
            await new Promise<void>((resolve, reject) =>
              e.socket!.send(
                bytes,
                { binary: frame.binary === true },
                (error) => (error ? reject(error) : resolve()),
              ),
            );
          } else e.body.push(bytes);
        } else if (e.request.websocket) e.end();
        else await this.fetch(frame.id, e);
      })
      .catch((error) => {
        this.adapter.onError?.(error);
        void send({
          version: 1,
          type: 'preview.end',
          id: frame.id,
          error: true,
        });
        e.end();
      });
  }
  private alive(target: ProjectServiceTarget) {
    return this.adapter.alive(target);
  }
  private async open(id: string, e: Entry) {
    await this.adapter.assertTarget(e.target);
    if (!this.alive(e.target)) throw Error('PROJECT_PREVIEW_REVOKED');
    e.stream = await ContainerLoopback.connect(
      this.adapter,
      e.target,
      () => !e.closed && this.alive(e.target),
    );
    if (!e.request.websocket) return;
    const ws = new WebSocket(
      `ws://${e.request.host}${e.request.path}`,
      e.request.protocol ? [e.request.protocol] : [],
      {
        createConnection: () => e.stream!,
        headers: e.request.headers,
        followRedirects: false,
        perMessageDeflate: false,
        maxPayload: projectServiceLimits.maximumSocketBytes,
        handshakeTimeout: 3000,
      },
    );
    e.socket = ws;
    // Vite sends its initial "connected" message immediately after upgrade.
    // Listen before awaiting the handshake, and hold bounded frames until the
    // public gateway has accepted the 101 response.
    let releaseResponse: () => void = () => undefined;
    let queue = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      }),
      pending = 0;
    ws.on('message', (data, binary) => {
      const bytes = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as ArrayBuffer);
      pending += bytes.length;
      if (pending > 1_000_000) {
        e.end();
        return;
      }
      queue = queue
        .then(async () => {
          if (
            !e.closed &&
            this.alive(e.target) &&
            !(await e.send({
              version: 1,
              type: 'preview.data',
              id,
              data: bytes.toString('base64'),
              binary,
            }))
          )
            throw Error('PROJECT_PREVIEW_BACKPRESSURE');
        })
        .catch(() => e.end())
        .finally(() => (pending -= bytes.length));
    });
    ws.on('error', () => e.end());
    ws.once('close', (code) => {
      if (code !== 1000 && code !== 1001 && code !== 1005) {
        void e.send({ version: 1, type: 'preview.end', id, error: true });
        e.end();
        return;
      }
      // Normal peer close follows messages already accepted above. Waiting for
      // their bounded consumption must not let end overtake those messages.
      void queue
        .then(async () => {
          if (e.closed) return;
          await e.send({ version: 1, type: 'preview.end', id });
          e.end();
        })
        .catch(() => e.end());
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => {
        res.destroy();
        reject(new Error('PROJECT_PREVIEW_UPGRADE_DENIED'));
      });
    });
    if (!this.alive(e.target)) throw Error('PROJECT_PREVIEW_REVOKED');
    e.ready = true;
    if (
      !(await e.send({
        version: 1,
        type: 'preview.response',
        id,
        status: 101,
        headers: {
          ...(ws.protocol ? { 'sec-websocket-protocol': ws.protocol } : {}),
        },
      }))
    )
      throw Error('PROJECT_PREVIEW_BACKPRESSURE');
    releaseResponse();
  }
  private async fetch(id: string, e: Entry) {
    const agent = new Agent({ keepAlive: false });
    agent.createConnection = () => e.stream!;
    const body = Buffer.concat(e.body);
    e.body = [];
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: e.request.host.split(':')[0],
          port: e.target.port,
          path: e.request.path,
          method: e.request.method,
          agent,
          headers: {
            ...e.request.headers,
            host: e.request.host,
            connection: 'close',
            'accept-encoding': 'identity',
            'content-length': body.length,
          },
        },
        (res) => {
          void (async () => {
            const headers: Record<string, string> = {};
            for (const name of [
              'content-type',
              'cache-control',
              'etag',
              'last-modified',
              'location',
              'vary',
            ]) {
              const v = res.headers[name];
              if (typeof v === 'string') headers[name] = v;
            }
            if (
              !(await e.send({
                version: 1,
                type: 'preview.response',
                id,
                status: res.statusCode ?? 502,
                headers,
              }))
            )
              throw Error('PROJECT_PREVIEW_BACKPRESSURE');
            let total = 0;
            for await (const raw of res) {
              const bytes = Buffer.from(raw);
              total += bytes.length;
              if (
                total > projectServiceLimits.maximumHttpBytes ||
                !this.alive(e.target)
              )
                throw Error('PROJECT_PREVIEW_LIMIT');
              for (let at = 0; at < bytes.length; at += 250_000)
                if (
                  !(await e.send({
                    version: 1,
                    type: 'preview.data',
                    id,
                    data: bytes.subarray(at, at + 250_000).toString('base64'),
                  }))
                )
                  throw Error('PROJECT_PREVIEW_BACKPRESSURE');
            }
            await e.send({ version: 1, type: 'preview.end', id });
            resolve();
          })().catch((error) => {
            res.destroy();
            reject(error);
          });
        },
      );
      e.end = (() => {
        const old = e.end;
        return () => {
          req.destroy();
          agent.destroy();
          old();
        };
      })();
      req.once('error', reject);
      req.setTimeout(10000, () =>
        req.destroy(new Error('PROJECT_PREVIEW_TIMEOUT')),
      );
      req.end(body);
    });
    e.end();
  }
  close() {
    for (const e of this.entries.values()) e.end();
    this.entries.clear();
  }
}
