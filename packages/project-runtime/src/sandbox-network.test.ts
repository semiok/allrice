import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as tls from 'node:tls';
import { Duplex, PassThrough } from 'node:stream';
import { createServer, connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SandboxHttpsOriginSchema,
  SandboxNetworkLeaseSchema,
} from '@allrice/contracts';
import { SandboxNetworkSession } from './sandbox-network-session.js';
import { sandboxNetworkRelay } from './sandbox-network-relay.js';
import { sandboxNetworkPythonRelay } from './sandbox-network-python-relay.js';
import {
  SandboxDockerStream,
  openSandboxNetwork,
} from './sandbox-network-docker.js';
import {
  sandboxPublicAddress,
  sandboxTlsClientHello,
  assertSandboxDestination,
  SandboxNetworkError,
} from './sandbox-network-policy.js';

const closers: (() => void)[] = [];
const relayRuntimes = ['node', 'python'] as const;
function startRelay(
  runtime: (typeof relayRuntimes)[number],
  port: number,
  deadline: number,
) {
  return spawn(
    runtime === 'python' ? 'python3' : process.execPath,
    [
      ...(runtime === 'python'
        ? ['-I', '-S', '-u', '-c', sandboxNetworkPythonRelay]
        : ['--eval', sandboxNetworkRelay]),
      String(port),
      String(deadline),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
}
afterEach(() => {
  while (closers.length) closers.pop()!();
});
const lease = () =>
  SandboxNetworkLeaseSchema.parse({
    version: 1,
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    runId: randomUUID(),
    operationId: randomUUID(),
    attemptId: randomUUID(),
    target: { kind: 'cloud', targetId: randomUUID() },
    grantId: randomUUID(),
    grantVersion: 1,
    policyDigest: 'sha256:' + 'a'.repeat(64),
    network: {
      mode: 'controlled_https',
      origins: ['https://registry.npmjs.org'],
    },
    expiresAt: new Date(Date.now() + 10_000).toISOString(),
    maximumConnections: 4,
    maximumBytes: 1024 * 1024,
  });
const hello = (hostname: string) => {
  const name = Buffer.from(hostname),
    sni = Buffer.alloc(5);
  sni.writeUInt16BE(name.length + 3);
  sni.writeUInt16BE(name.length, 3);
  const extension = Buffer.alloc(4);
  extension.writeUInt16BE(sni.length + name.length, 2);
  const ext = Buffer.concat([extension, sni, name]);
  const sizes = Buffer.alloc(2);
  sizes.writeUInt16BE(ext.length);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32),
    Buffer.from([0, 0, 2, 0x13, 1, 1, 0]),
    sizes,
    ext,
  ]);
  const handshake = Buffer.alloc(4);
  handshake[0] = 1;
  handshake.writeUIntBE(body.length, 1, 3);
  const record = Buffer.alloc(5);
  record.set([22, 3, 1]);
  record.writeUInt16BE(body.length + 4, 3);
  return Buffer.concat([record, handshake, body]);
};

describe('sandbox outbound boundary', () => {
  it.each(relayRuntimes)(
    'keeps %s exec isolated and never retries through a different runtime',
    async (runtime) => {
      const attempts: unknown[] = [];
      const failure = new Error('original exec failure');
      const api = {
        socketPath: '/unused-sandbox-network-test.sock',
        async json<T>(
          _method: string,
          _path: string,
          body?: unknown,
        ): Promise<T> {
          attempts.push(body);
          throw failure;
        },
      };
      const input = {
        containerId: 'a'.repeat(64),
        signal: new AbortController().signal,
        lease: lease(),
        assertCurrent: async () => {},
        assertContainer: async () => {},
      };
      await expect(
        openSandboxNetwork(api, {
          ...input,
          ...(runtime === 'python' ? { relayRuntime: runtime } : {}),
        }),
      ).rejects.toBe(failure);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        Privileged: false,
        User: '65532:65532',
        WorkingDir: '/tmp',
        Cmd:
          runtime === 'python'
            ? [
                '/usr/local/bin/python3',
                '-I',
                '-S',
                '-u',
                '-c',
                sandboxNetworkPythonRelay,
                '3139',
                String(Date.parse(input.lease.expiresAt)),
              ]
            : [
                '/usr/local/bin/node',
                '--v8-pool-size=1',
                '--eval',
                sandboxNetworkRelay,
                '3139',
                String(Date.parse(input.lease.expiresAt)),
              ],
      });
      await expect(
        openSandboxNetwork(api, {
          ...input,
          relayRuntime: 'unavailable' as never,
        }),
      ).rejects.toThrow('SANDBOX_NETWORK_DENIED');
      expect(attempts).toHaveLength(1);
    },
  );
  it('binds cloud without a device, Bridge with one, and exact canonical HTTPS origins', () => {
    expect(lease().target.kind).toBe('cloud');
    for (const origin of [
      'http://registry.npmjs.org',
      'https://registry.npmjs.org/',
      'https://registry.npmjs.org:444',
      'https://x:secret@registry.npmjs.org',
      'https://*.npmjs.org',
      'https://127.0.0.1',
      'https://a.local',
      'https://a..org',
    ])
      expect(SandboxHttpsOriginSchema.safeParse(origin).success, origin).toBe(
        false,
      );
    expect(
      SandboxNetworkLeaseSchema.safeParse({
        ...lease(),
        target: { kind: 'bridge', targetId: randomUUID() },
      }).success,
    ).toBe(false);
    expect(
      SandboxNetworkLeaseSchema.safeParse({
        ...lease(),
        target: {
          kind: 'cloud',
          targetId: randomUUID(),
          deviceId: randomUUID(),
        },
      }).success,
    ).toBe(false);
    expect(() =>
      assertSandboxDestination(lease(), 'registry.npmjs.org.evil.org'),
    ).toThrow('DENIED');
    expect(() =>
      assertSandboxDestination(
        lease(),
        'registry.npmjs.org',
        Date.now() + 20_000,
      ),
    ).toThrow('REVOKED');
  });
  it('blocks private, metadata, mapped, transition and special addresses in both families', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '172.17.0.1',
      '192.168.1.1',
      '100.64.1.1',
      '0.0.0.0',
      '224.0.0.1',
      '198.18.0.1',
      '::1',
      '::ffff:127.0.0.1',
      'fc00::1',
      'fe80::1',
      '2002:7f00:1::',
      '2001:db8::1',
      '2606:4700::1111%en0',
    ])
      expect(sandboxPublicAddress(address), address).toBe(false);
    expect(sandboxPublicAddress('1.1.1.1')).toBe(true);
    expect(sandboxPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('requires bounded TLS ClientHello to the authorized SNI, including split records', () => {
    const bytes = hello('registry.npmjs.org');
    for (let i = 0; i < bytes.length; i++)
      expect(
        sandboxTlsClientHello(bytes.subarray(0, i), 'registry.npmjs.org'),
      ).toBe('pending');
    expect(sandboxTlsClientHello(bytes, 'registry.npmjs.org')).toBe('valid');
    expect(() => sandboxTlsClientHello(bytes, 'other.example')).toThrow(
      'PROTOCOL',
    );
    expect(() =>
      sandboxTlsClientHello(
        Buffer.from('GET / HTTP/1.1\r\n'),
        'registry.npmjs.org',
      ),
    ).toThrow('PROTOCOL');
    expect(() =>
      sandboxTlsClientHello(Buffer.alloc(70_000), 'registry.npmjs.org'),
    ).toThrow('PROTOCOL');
    const payload = bytes.subarray(5),
      first = Buffer.from(bytes.subarray(0, 5)),
      second = Buffer.from(first);
    first.writeUInt16BE(17, 3);
    second.writeUInt16BE(payload.length - 17, 3);
    expect(
      sandboxTlsClientHello(
        Buffer.concat([
          first,
          payload.subarray(0, 17),
          second,
          payload.subarray(17),
        ]),
        'registry.npmjs.org',
      ),
    ).toBe('valid');
  });
  it('does not treat stderr or truncated Docker frames as protocol messages', async () => {
    const incoming = new PassThrough(),
      outgoing = new PassThrough();
    const socket = Duplex.from({ readable: incoming, writable: outgoing }),
      stream = new SandboxDockerStream(socket);
    closers.push(() => stream.destroy());
    const failure = new Promise<Error>((resolve) =>
      stream.once('error', resolve),
    );
    incoming.write(Buffer.from([2, 0, 0, 0, 0, 0, 0, 1, 65]));
    expect((await failure).message).toContain('PROTOCOL');
  });
  it.each(relayRuntimes)(
    'runs the real %s loopback relay, denies unauthorized CONNECT before resolving, and closes on lost authority',
    async (runtime) => {
      const probe = createServer();
      await new Promise<void>((resolve) =>
        probe.listen(0, '127.0.0.1', resolve),
      );
      const port = (probe.address() as { port: number }).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      const child = startRelay(runtime, port, Date.now() + 10_000);
      closers.push(() => child.kill());
      let authorized = true,
        resolved = 0;
      let relayFrames = '';
      child.stdout.on('data', (b: Buffer) => (relayFrames += b.toString()));
      const stream = Duplex.from({
        readable: child.stdout,
        writable: child.stdin,
      });
      const session = new SandboxNetworkSession(stream, {
        lease: lease(),
        assertCurrent: async () => {
          if (!authorized) throw Error('revoked');
        },
        resolve: async () => {
          resolved++;
          throw new SandboxNetworkError('SANDBOX_NETWORK_DNS');
        },
      });
      closers.push(() => session.close());
      await session.ready;
      const socket = connect({ host: '127.0.0.1', port });
      let response = '';
      socket.on('data', (b) => (response += b.toString()));
      socket.on('error', () => {});
      closers.push(() => socket.destroy());
      const closed = new Promise<void>((resolve) =>
        socket.once('close', () => resolve()),
      );
      socket.write(
        'CONNECT private.example:443 HTTP/1.1\r\nHost: private.example:443\r\n\r\n',
      );
      await closed;
      expect(resolved).toBe(0);
      expect(response).toBe(
        'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );
      // Exercise the actual Node proxy client: after one denied CONNECT and a
      // caught fetch error it must exit, not spin/reconnect until task timeout.
      const client = spawn(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          "try{await fetch('https://private.example',{signal:AbortSignal.timeout(1500)});process.exitCode=2}catch{console.log('denied')}",
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            HTTPS_PROXY: `http://127.0.0.1:${port}`,
            NO_PROXY: '',
            NODE_USE_ENV_PROXY: '1',
          },
        },
      );
      closers.push(() => client.kill());
      let output = '';
      client.stdout.on('data', (b: Buffer) => (output += b.toString()));
      const timeout = setTimeout(() => client.kill(), 4000);
      const exit = await new Promise<number | null>((resolve) =>
        client.once('exit', resolve),
      );
      clearTimeout(timeout);
      expect(exit).toBe(0);
      expect(output).toContain('denied');
      expect(resolved).toBe(0);
      expect(
        relayFrames
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { type: string })
          .filter((frame) => frame.type === 'open'),
      ).toHaveLength(2);
      authorized = false;
      await new Promise<void>((resolve) =>
        stream.once('close', () => resolve()),
      );
      expect(stream.destroyed).toBe(true);
    },
  );
  it.each(
    relayRuntimes.flatMap((runtime) =>
      (['complete', 'revoked', 'transport_lost'] as const).map((mode) => ({
        runtime,
        mode,
      })),
    ),
  )(
    '$runtime carries verified TLS and handles $mode without losing tail bytes or leaving sockets',
    async ({ runtime, mode }) => {
      const directory = mkdtempSync(join(tmpdir(), 'allrice-relay-test-'));
      closers.push(() => rmSync(directory, { recursive: true, force: true }));
      const certPath = join(directory, 'cert.pem'),
        keyPath = join(directory, 'key.pem');
      execFileSync(
        '/usr/bin/openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          keyPath,
          '-out',
          certPath,
          '-days',
          '1',
          '-subj',
          '/CN=registry.npmjs.org',
        ],
        { stdio: 'ignore' },
      );
      const cert = readFileSync(certPath);
      const body = Buffer.alloc(400_000, 97);
      const server = tls.createServer(
        { cert, key: readFileSync(keyPath) },
        (socket) => {
          socket.on('error', () => {});
          socket.once('data', (request) => {
            expect(request.toString()).toContain('GET /synthetic');
            socket.write(
              `HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
            );
            if (mode === 'complete') socket.end(body);
            else socket.write(body.subarray(0, 32));
          });
        },
      );
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const destination = (server.address() as { port: number }).port;
      closers.push(() => server.close());
      const probe = createServer();
      await new Promise<void>((resolve) =>
        probe.listen(0, '127.0.0.1', resolve),
      );
      const port = (probe.address() as { port: number }).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      const child = startRelay(runtime, port, Date.now() + 15_000);
      closers.push(() => child.kill());
      const stream = Duplex.from({
        readable: child.stdout,
        writable: child.stdin,
      });
      let authorized = true;
      let stoppedCode: string | undefined;
      const session = new SandboxNetworkSession(stream, {
        lease: lease(),
        assertCurrent: async () => {
          if (!authorized) throw Error('revoked');
        },
        onClosed: (code) => {
          stoppedCode = code;
        },
        resolve: async () => ({ address: '1.1.1.1', family: 4 }),
        connect: (address) => {
          expect(address).toEqual({ host: '1.1.1.1', family: 4, port: 443 });
          return connect({ host: '127.0.0.1', port: destination });
        },
      });
      closers.push(() => session.close());
      await session.ready;
      const tunnel = connect({ host: '127.0.0.1', port });
      closers.push(() => tunnel.destroy());
      tunnel.on('error', () => {});
      const connected = new Promise<void>((resolve, reject) => {
        tunnel.once('error', reject);
        tunnel.once('data', (value) => {
          if (
            value.toString() !== 'HTTP/1.1 200 Connection Established\r\n\r\n'
          )
            reject(Error('bad tunnel'));
          else resolve();
        });
      });
      tunnel.write(
        'CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n',
      );
      await connected;
      const secure = tls.connect({
        socket: tunnel,
        servername: 'registry.npmjs.org',
        ca: cert,
      });
      closers.push(() => secure.destroy());
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        secure.on('error', (error) => {
          if (mode === 'complete') reject(error);
        });
        secure.on('data', (data: Buffer) => {
          chunks.push(data);
          if (mode === 'revoked') authorized = false;
          if (mode === 'transport_lost') stream.destroy();
        });
        secure.once(mode === 'complete' ? 'end' : 'close', resolve);
        secure.once('secureConnect', () =>
          secure.write(
            'GET /synthetic HTTP/1.1\r\nHost: registry.npmjs.org\r\nConnection: close\r\n\r\n',
          ),
        );
      });
      const response = Buffer.concat(chunks),
        end = response.indexOf('\r\n\r\n');
      expect(response.subarray(0, end).toString()).toContain('200 OK');
      if (mode === 'complete') expect(response.subarray(end + 4)).toEqual(body);
      else {
        expect(response.subarray(end + 4).length).toBeLessThan(body.length);
        expect(stream.destroyed).toBe(true);
        expect(stoppedCode).toBe(
          mode === 'revoked'
            ? 'SANDBOX_NETWORK_REVOKED'
            : 'SANDBOX_NETWORK_UNAVAILABLE',
        );
      }
      expect(session.observation.sentBytes).toBeGreaterThan(0);
      expect(session.observation.receivedBytes).toBeGreaterThan(0);
      expect(session.observation.openedConnections).toBe(1);
    },
    20_000,
  );
});
