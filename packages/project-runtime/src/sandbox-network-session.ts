import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  SandboxNetworkLeaseSchema,
  type SandboxNetworkLease,
  type SandboxNetworkErrorCode,
} from '@allrice/contracts';
import {
  assertSandboxDestination,
  resolveSandboxDestination,
  sandboxTlsClientHello,
  SandboxNetworkError,
} from './sandbox-network-policy.js';

type Peer = {
  hostname: string;
  address?: { address: string; family: number };
  socket?: Socket;
  hello: Buffer;
  busy: boolean;
  opening: boolean;
  pending?: Buffer;
  waiting?: boolean;
  ended?: boolean;
};
type Options = {
  lease: SandboxNetworkLease;
  /** Rechecks current owner, attempt, grant, root cancellation and expiry. */
  assertCurrent: () => Promise<void>;
  onError?: (code: SandboxNetworkErrorCode) => void;
  onClosed?: (code: SandboxNetworkErrorCode) => void;
  /** Resolver injection is for deterministic tests; production uses public DNS pinning. */
  resolve?: typeof resolveSandboxDestination;
  connect?: (address: { host: string; family: number; port: number }) => Socket;
};

/** One authority-bound multiplexed connection. No TCP listener on the host,
 * no bearer credentials in the sandbox and no replay on reconnect. */
export class SandboxNetworkSession {
  private readonly lease: SandboxNetworkLease;
  private readonly peers = new Map<string, Peer>();
  private readonly seen = new Set<string>();
  private pending = Buffer.alloc(0);
  private bytes = 0;
  private sentBytes = 0;
  private receivedBytes = 0;
  private openedConnections = 0;
  private closed = false;
  private checking = false;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readySeen = false;
  private readonly timer: ReturnType<typeof setInterval>;
  readonly ready: Promise<void>;

  /** Transport observations only, never proof of a remote API's outcome. */
  get observation() {
    return {
      sentBytes: this.sentBytes,
      receivedBytes: this.receivedBytes,
      openedConnections: this.openedConnections,
    };
  }

  constructor(
    private readonly transport: Duplex,
    private readonly options: Options,
  ) {
    this.lease = SandboxNetworkLeaseSchema.parse(options.lease);
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // The caller may still be attaching the Docker transport when it fails.
    void this.ready.catch(() => undefined);
    transport.on('data', (chunk: Buffer) => this.receive(chunk));
    transport.on('error', () => this.close('SANDBOX_NETWORK_UNAVAILABLE'));
    transport.once('close', () => this.close('SANDBOX_NETWORK_UNAVAILABLE'));
    transport.once('end', () => this.close('SANDBOX_NETWORK_UNAVAILABLE'));
    const started = Date.now();
    this.timer = setInterval(() => {
      if (Date.now() >= Date.parse(this.lease.expiresAt))
        return this.close('SANDBOX_NETWORK_REVOKED');
      if (!this.readySeen && Date.now() - started > 5000)
        return this.close('SANDBOX_NETWORK_UNAVAILABLE');
      if (this.checking || this.closed) return;
      this.checking = true;
      const timeout = setTimeout(
        () => this.close('SANDBOX_NETWORK_REVOKED'),
        2000,
      );
      void options
        .assertCurrent()
        .catch(() => this.close('SANDBOX_NETWORK_REVOKED'))
        .finally(() => {
          clearTimeout(timeout);
          this.checking = false;
        });
    }, 500);
    this.timer.unref();
  }

  close(code?: SandboxNetworkErrorCode) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const peer of this.peers.values()) peer.socket?.destroy();
    this.peers.clear();
    this.transport.destroy();
    this.readyReject(
      new SandboxNetworkError(code ?? 'SANDBOX_NETWORK_UNAVAILABLE'),
    );
    if (code) {
      try {
        this.options.onError?.(code);
        this.options.onClosed?.(code);
      } catch {
        /* reporting cannot retain sockets */
      }
    }
  }

  private send(value: Record<string, unknown>) {
    if (this.closed) return;
    if (this.transport.writableLength > 1_048_576)
      return this.close('SANDBOX_NETWORK_LIMIT');
    this.transport.write(JSON.stringify(value) + '\n');
  }
  private current(id: string, peer: Peer) {
    return !this.closed && this.peers.get(id) === peer;
  }
  private drop(id: string, code?: SandboxNetworkErrorCode) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    peer.socket?.destroy();
    this.send({
      type: code ? 'error' : 'close',
      id,
      ...(code ? { code } : {}),
    });
    if (code) {
      try {
        this.options.onError?.(code);
      } catch {
        /* diagnostic only */
      }
    }
  }
  private count(size: number) {
    this.bytes += size;
    if (this.bytes > this.lease.maximumBytes) {
      this.close('SANDBOX_NETWORK_LIMIT');
      return false;
    }
    return true;
  }

  private receive(chunk: Buffer) {
    if (this.closed) return;
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.pending.length > 262_144)
      return this.close('SANDBOX_NETWORK_LIMIT');
    let end: number;
    while ((end = this.pending.indexOf(10)) >= 0 && !this.closed) {
      if (end > 50_000) return this.close('SANDBOX_NETWORK_PROTOCOL');
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(this.pending.subarray(0, end).toString('utf8'));
      } catch {
        return this.close('SANDBOX_NETWORK_PROTOCOL');
      }
      this.pending = this.pending.subarray(end + 1);
      if (!value || typeof value !== 'object')
        return this.close('SANDBOX_NETWORK_PROTOCOL');
      if (
        value.type === 'ready' &&
        !this.readySeen &&
        Object.keys(value).length === 1
      ) {
        this.readySeen = true;
        this.readyResolve();
        continue;
      }
      if (
        !this.readySeen ||
        typeof value.id !== 'string' ||
        !/^[1-9]\d{0,4}$/.test(value.id)
      )
        return this.close('SANDBOX_NETWORK_PROTOCOL');
      const id = value.id;
      if (value.type === 'open') {
        if (
          this.seen.has(id) ||
          this.seen.size >= 10_000 ||
          this.peers.size >= this.lease.maximumConnections ||
          typeof value.hostname !== 'string'
        )
          return this.close('SANDBOX_NETWORK_LIMIT');
        this.seen.add(id);
        const peer: Peer = {
          hostname: value.hostname,
          hello: Buffer.alloc(0),
          busy: false,
          opening: true,
        };
        this.peers.set(id, peer);
        void this.open(id, peer);
        continue;
      }
      const peer = this.peers.get(id);
      if (!peer) continue; // Late close/ACK for an already fenced connection.
      if (value.type === 'close') {
        this.drop(id);
        continue;
      }
      if (value.type === 'end') {
        peer.socket?.end();
        continue;
      }
      if (value.type === 'ack' && peer.waiting) {
        peer.waiting = false;
        this.flush(id, peer);
        continue;
      }
      if (
        value.type !== 'data' ||
        peer.opening ||
        peer.busy ||
        typeof value.data !== 'string' ||
        value.data.length > 21_848
      )
        return this.close('SANDBOX_NETWORK_PROTOCOL');
      const bytes = Buffer.from(value.data, 'base64');
      if (
        !bytes.length ||
        bytes.length > 16_384 ||
        bytes.toString('base64') !== value.data
      )
        return this.close('SANDBOX_NETWORK_PROTOCOL');
      if (!this.count(bytes.length)) return;
      peer.busy = true;
      void this.write(id, peer, bytes).catch((error: unknown) =>
        this.drop(
          id,
          error instanceof SandboxNetworkError
            ? error.code
            : 'SANDBOX_NETWORK_CONNECT_FAILED',
        ),
      );
    }
  }

  private async open(id: string, peer: Peer) {
    try {
      assertSandboxDestination(this.lease, peer.hostname);
      await this.options.assertCurrent();
      peer.address = await (this.options.resolve ?? resolveSandboxDestination)(
        this.lease,
        peer.hostname,
      );
      await this.options.assertCurrent();
      assertSandboxDestination(this.lease, peer.hostname);
      if (!this.current(id, peer)) return;
      peer.opening = false;
      this.send({ type: 'opened', id });
    } catch (error) {
      this.drop(
        id,
        error instanceof SandboxNetworkError
          ? error.code
          : 'SANDBOX_NETWORK_REVOKED',
      );
    }
  }

  private async write(id: string, peer: Peer, bytes: Buffer) {
    if (!peer.socket) {
      peer.hello = Buffer.concat([peer.hello, bytes]);
      if (sandboxTlsClientHello(peer.hello, peer.hostname) === 'pending') {
        peer.busy = false;
        this.send({ type: 'ack', id });
        return;
      }
      await this.options.assertCurrent();
      assertSandboxDestination(this.lease, peer.hostname);
      if (!this.current(id, peer)) return;
      const socket = (this.options.connect ?? connect)({
        host: peer.address!.address,
        family: peer.address!.family,
        port: 443,
      });
      peer.socket = socket;
      this.openedConnections++;
      socket.setNoDelay();
      socket.on('error', () => this.drop(id, 'SANDBOX_NETWORK_CONNECT_FAILED'));
      socket.on('close', () => {
        if (!peer.ended) this.drop(id);
      });
      socket.on('end', () => {
        peer.ended = true;
        this.flush(id, peer);
      });
      socket.on('data', (data: Buffer) => {
        socket.pause();
        if (peer.pending?.length || peer.waiting || data.length > 65_536)
          return this.close('SANDBOX_NETWORK_LIMIT');
        if (!this.count(data.length)) return;
        this.receivedBytes += data.length;
        peer.pending = data;
        this.flush(id, peer);
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new SandboxNetworkError('SANDBOX_NETWORK_CONNECT_TIMEOUT'));
          socket.destroy();
        }, 5000);
        socket.once('connect', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        socket.once('close', () => {
          clearTimeout(timer);
          reject(new SandboxNetworkError('SANDBOX_NETWORK_UNAVAILABLE'));
        });
      });
      bytes = peer.hello;
      peer.hello = Buffer.alloc(0);
    }
    if (!this.current(id, peer)) return;
    // Count before write: a failed callback cannot prove that no bytes left.
    this.sentBytes += bytes.length;
    await new Promise<void>((resolve, reject) =>
      peer.socket!.write(bytes, (error) => (error ? reject(error) : resolve())),
    );
    if (!this.current(id, peer)) return;
    peer.busy = false;
    this.send({ type: 'ack', id });
  }

  private flush(id: string, peer: Peer) {
    if (!this.current(id, peer) || peer.waiting) return;
    if (!peer.pending?.length) {
      peer.pending = undefined;
      if (peer.ended) {
        this.peers.delete(id);
        this.send({ type: 'end', id });
        return;
      }
      peer.socket?.resume();
      return;
    }
    const bytes = peer.pending.subarray(0, 16_384);
    peer.pending = peer.pending.subarray(bytes.length);
    peer.waiting = true;
    this.send({ type: 'data', id, data: bytes.toString('base64') });
  }
}
