import { request } from 'node:http';
import { Duplex } from 'node:stream';
import { SandboxNetworkSession } from './sandbox-network-session.js';
import { sandboxNetworkRelay } from './sandbox-network-relay.js';
import { SandboxNetworkError } from './sandbox-network-policy.js';

/** Docker's multiplex headers are transport data, not sandbox frames. */
export class SandboxDockerStream extends Duplex {
  private pending = Buffer.alloc(0);
  private ended = false;
  constructor(private readonly socket: Duplex) {
    super();
    socket.on('data', (chunk: Buffer) => {
      this.pending = Buffer.concat([this.pending, chunk]);
      if (this.pending.length > 262_144)
        this.destroy(new SandboxNetworkError('SANDBOX_NETWORK_LIMIT'));
      else this.drain();
    });
    socket.on('error', (error) => this.destroy(error));
    socket.once('end', () => {
      this.ended = true;
      this.drain();
    });
    socket.once('close', () => {
      if (!this.ended)
        this.destroy(new SandboxNetworkError('SANDBOX_NETWORK_UNAVAILABLE'));
    });
  }
  private drain() {
    while (this.pending.length >= 8) {
      const length = this.pending.readUInt32BE(4);
      if (
        this.pending[0] !== 1 ||
        this.pending.readUIntBE(1, 3) !== 0 ||
        length > 131_072
      ) {
        this.destroy(new SandboxNetworkError('SANDBOX_NETWORK_PROTOCOL'));
        return;
      }
      if (this.pending.length < 8 + length) break;
      const data = Buffer.from(this.pending.subarray(8, 8 + length));
      this.pending = this.pending.subarray(8 + length);
      if (!this.push(data)) {
        this.socket.pause();
        return;
      }
    }
    if (this.ended) {
      if (this.pending.length)
        this.destroy(new SandboxNetworkError('SANDBOX_NETWORK_PROTOCOL'));
      else this.push(null);
    }
  }
  override _read() {
    this.drain();
    this.socket.resume();
  }
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ) {
    this.socket.write(chunk, done);
  }
  override _destroy(error: Error | null, done: (error: Error | null) => void) {
    this.socket.destroy();
    done(error);
  }
}

type Api = {
  socketPath: string;
  json<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T>;
};
export const sandboxProxyPort = 3139;
export const sandboxProxyEnvironment = Object.freeze({
  HTTPS_PROXY: `http://127.0.0.1:${sandboxProxyPort}`,
  https_proxy: `http://127.0.0.1:${sandboxProxyPort}`,
  HTTP_PROXY: `http://127.0.0.1:${sandboxProxyPort}`,
  http_proxy: `http://127.0.0.1:${sandboxProxyPort}`,
  NO_PROXY: '',
  no_proxy: '',
  NODE_USE_ENV_PROXY: '1',
});

/** Attach before sending script input/staging-ready. Tenant processes cannot
 * start until the trusted helper is ready; failed setup never falls back to
 * an unfiltered Docker network or another execution target. */
export async function openSandboxNetwork(
  api: Api,
  input: ConstructorParameters<typeof SandboxNetworkSession>[1] & {
    containerId: string;
    signal: AbortSignal;
    assertContainer: () => Promise<void>;
  },
) {
  if (!/^[a-f0-9]{64}$/.test(input.containerId))
    throw new SandboxNetworkError('SANDBOX_NETWORK_DENIED');
  input.signal.throwIfAborted();
  await input.assertCurrent();
  await input.assertContainer();
  input.signal.throwIfAborted();
  const exec = await api.json<{ Id: string }>(
    'POST',
    `/containers/${input.containerId}/exec`,
    {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: false,
      Tty: false,
      Privileged: false,
      User: '65532:65532',
      WorkingDir: '/tmp',
      Env: ['NODE_OPTIONS=', 'NODE_USE_ENV_PROXY=0'],
      Cmd: [
        '/usr/local/bin/node',
        '--v8-pool-size=1',
        '--eval',
        sandboxNetworkRelay,
        String(sandboxProxyPort),
        String(Date.parse(input.lease.expiresAt)),
      ],
    },
    3000,
  );
  if (!/^[a-f0-9]{64}$/.test(exec.Id))
    throw new SandboxNetworkError('SANDBOX_NETWORK_UNAVAILABLE');
  input.signal.throwIfAborted();
  const stream = await new Promise<SandboxDockerStream>((resolve, reject) => {
    const req = request({
      socketPath: api.socketPath,
      path: `/v1.45/exec/${exec.Id}/start`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        connection: 'Upgrade',
        upgrade: 'tcp',
      },
      signal: input.signal,
    });
    const timer = setTimeout(
      () => req.destroy(new SandboxNetworkError('SANDBOX_NETWORK_UNAVAILABLE')),
      3000,
    );
    req.once('upgrade', (_response, socket, head) => {
      clearTimeout(timer);
      socket.on('error', () => {});
      if (input.signal.aborted) {
        socket.destroy();
        reject(new SandboxNetworkError('SANDBOX_NETWORK_REVOKED'));
        return;
      }
      // Create the decoder before unshifting a possibly coalesced ready frame.
      const decoded = new SandboxDockerStream(socket);
      if (head.length) socket.unshift(head);
      resolve(decoded);
    });
    req.once('response', (response) => {
      clearTimeout(timer);
      response.resume();
      reject(new SandboxNetworkError('SANDBOX_NETWORK_UNAVAILABLE'));
    });
    req.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end(JSON.stringify({ Detach: false, Tty: false }));
  });
  const session = new SandboxNetworkSession(stream, input);
  const stop = () => session.close('SANDBOX_NETWORK_REVOKED');
  input.signal.addEventListener('abort', stop, { once: true });
  stream.once('close', () => input.signal.removeEventListener('abort', stop));
  if (input.signal.aborted) stop();
  try {
    await session.ready;
    await input.assertCurrent();
    return session;
  } catch (error) {
    session.close();
    throw error;
  }
}
