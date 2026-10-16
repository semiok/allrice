import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { sandboxNetworkPythonRelay } from './sandbox-network-python-relay.js';

type Frame = { type: string; id?: string; data?: string };
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function relay(duration = 20_000) {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const child = spawn(
    'python3',
    [
      '-I',
      '-S',
      '-u',
      '-c',
      sandboxNetworkPythonRelay,
      String(port),
      String(Date.now() + duration),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (value: Buffer) => (stderr += value.toString()));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await exited;
  });
  const frames: Frame[] = [];
  const readers: ((frame: Frame) => void)[] = [];
  let pending = '';
  child.stdout.on('data', (bytes: Buffer) => {
    pending += bytes.toString('utf8');
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const value = JSON.parse(pending.slice(0, end)) as Frame;
      pending = pending.slice(end + 1);
      const reader = readers.shift();
      if (reader) reader(value);
      else frames.push(value);
    }
  });
  async function next() {
    if (frames.length) return frames.shift()!;
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error('relay frame missing: ' + stderr)),
        3000,
      );
      readers.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }
  const send = (value: unknown) =>
    child.stdin.write(JSON.stringify(value) + '\n');
  expect(await next()).toEqual({ type: 'ready' });
  const socket = connect({ host: '127.0.0.1', port });
  cleanup.push(() => {
    socket.destroy();
  });
  const socketClosed = new Promise<void>((resolve) =>
    socket.once('close', () => resolve()),
  );
  socket.on('error', () => {});
  const connected = new Promise<Buffer>((resolve) =>
    socket.once('data', resolve),
  );
  socket.write(
    'CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n',
  );
  const open = await next();
  expect(open).toMatchObject({
    type: 'open',
    id: '1',
    hostname: 'registry.npmjs.org',
  });
  send({ type: 'opened', id: open.id });
  expect((await connected).toString()).toBe(
    'HTTP/1.1 200 Connection Established\r\n\r\n',
  );
  return {
    child,
    exited,
    next,
    send,
    socket,
    socketClosed,
    stderr: () => stderr,
  };
}

it.each(['control_eof', 'invalid_json', 'oversized_frame', 'invalid_base64'])(
  'closes accepted sockets promptly on %s without waiting for the hard deadline',
  async (failure) => {
    const f = await relay();
    if (failure === 'control_eof') f.child.stdin.end();
    if (failure === 'invalid_json') f.child.stdin.write('null\n');
    if (failure === 'oversized_frame')
      f.child.stdin.write('x'.repeat(50_001) + '\n');
    if (failure === 'invalid_base64')
      f.send({ type: 'data', id: '1', data: 'YQ===' });
    await f.socketClosed;
    expect(await f.exited).toBe(0);
    expect(f.stderr()).toBe('');
  },
  5000,
);

it('enforces the hard deadline while the host control channel remains open', async () => {
  const f = await relay(1200);
  await f.socketClosed;
  expect(await f.exited).toBe(0);
  expect(f.stderr()).toBe('');
}, 5000);

it('carries an upload larger than its read buffer through bounded acknowledged frames', async () => {
  const f = await relay();
  const upload = Buffer.alloc(200_000);
  for (let i = 0; i < upload.length; i++) upload[i] = i % 251;
  f.socket.write(upload);
  const received: Buffer[] = [];
  let size = 0;
  while (size < upload.length) {
    const frame = await f.next();
    expect(frame.type).toBe('data');
    expect(frame.id).toBe('1');
    const bytes = Buffer.from(frame.data!, 'base64');
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.length).toBeLessThanOrEqual(16_384);
    received.push(bytes);
    size += bytes.length;
    f.send({ type: 'ack', id: frame.id });
  }
  expect(Buffer.concat(received)).toEqual(upload);
  f.child.stdin.end();
  await f.socketClosed;
  expect(await f.exited).toBe(0);
});
