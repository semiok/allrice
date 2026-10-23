/** Real socket transport with the same iterator consumed by pinned RemoteStream.
 * No synthetic PTY, Agent operation, account, database or Dev service is used. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  workbenchTerminalStreamProtocol,
  type TerminalInput,
  type TerminalNativeFrameSchema,
  type TerminalStreamMode,
} from '@allrice/contracts';
import { TerminalCarrier } from './terminal-transport';

const { WebSocket, WebSocketServer } = createRequire(import.meta.url)('ws');
type Socket = {
  protocol: string;
  on(event: string, listener: (raw: Buffer) => void): void;
  send(data: string): void;
  terminate(): void;
  close(code?: number): void;
};

type NativeFrame = ReturnType<typeof TerminalNativeFrameSchema.parse>;
type Stream = AsyncIterableIterator<NativeFrame> & {
  send(input: TerminalInput): void;
};
type Sent = {
  type: string;
  action?: string;
  requestId: string;
  args?: { id?: string };
  input?: { data?: string };
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});
class CarrierError extends Error {}
const unavailableAuthority = {
  code: 'terminal/unavailable',
  message: 'HUMAN_TERMINAL_AUTHORIZATION_UNAVAILABLE',
};
async function until(check: () => boolean) {
  const end = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > end) throw Error('Terminal socket boundary not reached');
    await delay(5);
  }
}
const info = {
  id: 'native-terminal',
  title: 'zsh',
  cwd: '/authorized',
  shell: { path: '/bin/zsh', args: ['-i'], name: 'zsh' },
  cols: 80,
  rows: 24,
  state: 'running' as const,
  exitCode: null,
};
async function fixture(mode: TerminalStreamMode = 'push') {
  const server = createServer(),
    wss = new WebSocketServer({ server });
  const target = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    loginSessionId: randomUUID(),
    sessionId: randomUUID(),
    deviceId: randomUUID(),
    grantId: randomUUID(),
    grantVersion: 1,
    rootFingerprint: 'a'.repeat(64),
    label: 'Authorized',
  };
  const clients: Socket[] = [],
    sent: Sent[] = [];
  wss.on('connection', (client: Socket) => {
    clients.push(client);
    client.on('error', () => undefined);
    client.on('message', (raw: Buffer) =>
      sent.push(JSON.parse(raw.toString())),
    );
    client.send(
      JSON.stringify({
        version: 1,
        type: 'terminal.ready',
        target,
        deviceName: 'Test Mac',
        ...(mode === 'push' ? { streamMode: 'push' } : {}),
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  vi.stubGlobal('location', { href: origin + '/', protocol: 'http:' });
  vi.stubGlobal('WebSocket', WebSocket);
  const carrier = new TerminalCarrier(
    { ...target },
    { deviceId: target.deviceId, grantId: target.grantId },
    (message) => new CarrierError(message),
  );
  cleanups.push(async () => {
    carrier.dispose();
    for (const client of clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await until(() => carrier.state.getSnapshot().phase === 'connected');
  expect(clients[0]!.protocol).toBe(workbenchTerminalStreamProtocol);
  const send = (value: Record<string, unknown>) =>
    clients.at(-1)!.send(JSON.stringify({ version: 1, ...value }));
  const native = (requestId: string, frame: NativeFrame) =>
    send({ type: 'terminal.frame', requestId, frame });
  const fragmented = (requestId: string, frame: NativeFrame) => {
    const encoded = JSON.stringify(frame),
      chunks = encoded.match(/[\s\S]{1,100000}/g)!;
    chunks.forEach((data, index) =>
      send({
        type: 'terminal.fragment',
        requestId,
        index,
        total: chunks.length,
        data,
      }),
    );
  };
  const open = async (id = info.id) => {
    const previous = sent.filter(
      (frame) => frame.action === 'attach' && frame.args?.id === id,
    ).length;
    const stream = carrier.remote.attach(
      target.sessionId as never,
      id,
    ) as unknown as Stream;
    const first = stream.next();
    await until(
      () =>
        sent.filter(
          (frame) => frame.action === 'attach' && frame.args?.id === id,
        ).length > previous,
    );
    const requestId = sent
      .filter((frame) => frame.action === 'attach' && frame.args?.id === id)
      .at(-1)!.requestId;
    return { stream, first, requestId };
  };
  const barrier = async () => {
    const result = carrier.remote.environment(target.sessionId as never);
    const count = sent.filter((frame) => frame.action === 'environment').length;
    await until(
      () =>
        sent.filter((frame) => frame.action === 'environment').length > count,
    );
    const request = sent
      .filter((frame) => frame.action === 'environment')
      .at(-1)!;
    send({
      type: 'terminal.result',
      requestId: request.requestId,
      result: { ok: true, value: {} },
    });
    expect((await result).ok).toBe(true);
  };
  return {
    carrier,
    clients,
    target,
    sent,
    send,
    native,
    fragmented,
    open,
    barrier,
  };
}
const snapshot = (id = info.id, screen = 'native% '): NativeFrame => ({
  type: 'snapshot',
  sequence: 0,
  screen,
  info: { ...info, id },
  writable: true,
});

it('buffers a continuous native ACK/output burst locally and never issues per-frame next', async () => {
  const f = await fixture(),
    { stream, first, requestId } = await f.open();
  f.native(requestId, snapshot());
  expect((await first).value).toEqual(snapshot());
  const frames: NativeFrame[] = [];
  for (let index = 1; index <= 205; index++) {
    stream.send({
      type: 'write',
      sequence: index,
      data: index === 205 ? '\t\r\x03' : 'x',
    });
    frames.push(
      { type: 'ack', sequence: index },
      { type: 'output', sequence: index, data: 'x' },
    );
  }
  frames.forEach((frame) => f.native(requestId, frame));
  await f.barrier();
  for (const frame of frames)
    expect((await stream.next()).value).toEqual(frame);
  expect(f.sent.some((frame) => frame.type === 'terminal.next')).toBe(false);
  await until(
    () =>
      f.sent.filter((frame) => frame.type === 'terminal.input').length === 205,
  );
  expect(
    f.sent.filter((frame) => frame.type === 'terminal.input').at(-1)!.input
      ?.data,
  ).toBe('\t\r\x03');
  await stream.return!();
  await until(() => f.sent.some((frame) => frame.type === 'terminal.cancel'));
});

it('reassembles pushed fragments without a waiting consumer and drains them before graceful finish', async () => {
  const f = await fixture(),
    { stream, first, requestId } = await f.open();
  f.native(requestId, snapshot());
  await first;
  const large = snapshot(info.id, 'x'.repeat(1_600_000));
  f.fragmented(requestId, large);
  f.native(requestId, { type: 'ack', sequence: 1 });
  f.send({ type: 'terminal.finished', requestId });
  await f.barrier();
  expect((await stream.next()).value).toEqual(large);
  expect((await stream.next()).value).toEqual({ type: 'ack', sequence: 1 });
  expect(await stream.next()).toEqual({ done: true, value: undefined });
  expect(f.sent.some((frame) => frame.type === 'terminal.next')).toBe(false);
});

it('preserves queued frames before an ordered stream error', async () => {
  const f = await fixture(),
    { stream, first, requestId } = await f.open();
  f.native(requestId, snapshot());
  await first;
  f.native(requestId, { type: 'ack', sequence: 1 });
  f.send({
    type: 'terminal.finished',
    requestId,
    error: { code: 'terminal/unavailable', message: 'Native stream failed' },
  });
  await f.barrier();
  expect((await stream.next()).value).toEqual({ type: 'ack', sequence: 1 });
  await expect(stream.next()).rejects.toThrow('Native stream failed');
});

it('fails visibly on a pushed byte-budget overflow instead of dropping frames or replaying input', async () => {
  const f = await fixture(),
    { stream, first, requestId } = await f.open();
  f.native(requestId, snapshot());
  await first;
  for (let sequence = 1; sequence <= 6; sequence++)
    f.native(requestId, { type: 'output', sequence, data: 'x'.repeat(400000) });
  await until(() => f.carrier.state.getSnapshot().phase === 'ended');
  expect(f.carrier.state.getSnapshot().error).toContain('缓冲区已满');
  await expect(stream.next()).rejects.toThrow('缓冲区已满');
  expect(f.clients).toHaveLength(1);
  expect(f.sent.some((frame) => frame.type === 'terminal.input')).toBe(false);
});

it('bounds the number of tiny queued frames as well as their encoded byte size', async () => {
  const f = await fixture(),
    { stream, first, requestId } = await f.open();
  f.native(requestId, snapshot());
  await first;
  for (let sequence = 1; sequence <= 4097; sequence++)
    f.native(requestId, { type: 'ack', sequence });
  await until(() => f.carrier.state.getSnapshot().phase === 'ended');
  await expect(stream.next()).rejects.toThrow('缓冲区已满');
});

it('rejects an incomplete pushed fragment before stream finish instead of losing the partial frame', async () => {
  const f = await fixture(),
    { stream, first, requestId } = await f.open();
  f.native(requestId, snapshot());
  await first;
  f.send({
    type: 'terminal.fragment',
    requestId,
    index: 0,
    total: 2,
    data: '{',
  });
  f.send({ type: 'terminal.finished', requestId });
  await until(() => f.carrier.state.getSnapshot().phase === 'ended');
  await expect(stream.next()).rejects.toThrow('分片未完成');
});

it('releases cancelled inbox bytes before another stream consumes its full screen budget', async () => {
  const f = await fixture(),
    a = await f.open();
  f.native(a.requestId, snapshot());
  await a.first;
  for (let sequence = 1; sequence <= 3; sequence++)
    f.native(a.requestId, {
      type: 'output',
      sequence,
      data: 'x'.repeat(400000),
    });
  await f.barrier();
  await a.stream.return!();
  const b = await f.open('second-native');
  f.native(b.requestId, snapshot('second-native'));
  await b.first;
  const large = snapshot('second-native', 'y'.repeat(1_600_000));
  f.fragmented(b.requestId, large);
  await f.barrier();
  expect((await b.stream.next()).value).toEqual(large);
  expect(f.carrier.state.getSnapshot().phase).toBe('connected');
});

it('keeps legacy one-item credits when ready omits the modern stream mode', async () => {
  const f = await fixture('pull'),
    { stream, first, requestId } = await f.open();
  await until(() => f.sent.some((frame) => frame.type === 'terminal.next'));
  f.native(requestId, snapshot());
  await first;
  const second = stream.next();
  await until(
    () => f.sent.filter((frame) => frame.type === 'terminal.next').length === 2,
  );
  f.native(requestId, { type: 'ack', sequence: 1 });
  expect((await second).value).toEqual({ type: 'ack', sequence: 1 });
});

it('discards stale unread data on disconnect and never replays an old input on reconnection', async () => {
  const f = await fixture(),
    { stream, first, requestId } = await f.open();
  f.native(requestId, snapshot());
  await first;
  stream.send({ type: 'write', sequence: 1, data: 'once' });
  f.native(requestId, { type: 'output', sequence: 1, data: 'old output' });
  await f.barrier();
  f.clients[0]!.close(4009);
  await until(() => f.carrier.state.getSnapshot().phase === 'disconnected');
  await expect(stream.next()).rejects.toThrow('终端连接已断开');
  await until(
    () =>
      f.clients.length === 2 &&
      f.carrier.state.getSnapshot().phase === 'connected',
  );
  expect(
    f.sent.filter((frame) => frame.type === 'terminal.input'),
  ).toHaveLength(1);
  expect(f.sent.filter((frame) => frame.action === 'attach')).toHaveLength(1);
});

it('reauthenticates after temporary authority loss without replaying input or an unfinished RPC', async () => {
  const f = await fixture(),
    { stream, first, requestId } = await f.open();
  f.native(requestId, snapshot());
  await first;
  const previousGeneration = f.carrier.generation.getSnapshot()!.id;
  stream.send({ type: 'write', sequence: 1, data: 'once' });
  f.native(requestId, { type: 'output', sequence: 1, data: 'stale output' });
  const closing = f.carrier.remote.close(f.target.sessionId as never, info.id);
  await until(() => f.sent.some((frame) => frame.action === 'close'));
  await f.barrier();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  f.send({ type: 'terminal.ended', error: unavailableAuthority });
  await until(() => f.carrier.state.getSnapshot().phase !== 'connected');

  expect(f.carrier.state.getSnapshot().phase).toBe('disconnected');
  expect(f.carrier.generation.getSnapshot()).toBeUndefined();
  expect(f.carrier.state.getSnapshot().error).toContain('正在重新验证');
  expect(f.carrier.state.getSnapshot().error).not.toContain('HUMAN_TERMINAL');
  await expect(stream.next()).rejects.toBeInstanceOf(CarrierError);
  expect(await closing).toMatchObject({
    ok: false,
    error: {
      code: 'gateway/internal',
      message: expect.stringContaining('授权'),
    },
  });
  expect(() =>
    stream.send({ type: 'write', sequence: 2, data: 'late' }),
  ).toThrow(CarrierError);

  await vi.advanceTimersByTimeAsync(999);
  expect(f.clients).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  await until(() => f.carrier.state.getSnapshot().phase === 'connected');
  expect(f.clients).toHaveLength(2);
  expect(f.carrier.generation.getSnapshot()!.id).toBeGreaterThan(
    previousGeneration,
  );
  expect(f.carrier.state.getSnapshot().error).toBeUndefined();
  expect(
    f.sent.filter((frame) => frame.type === 'terminal.input'),
  ).toHaveLength(1);
  expect(f.sent.filter((frame) => frame.action === 'close')).toHaveLength(1);
  expect(f.sent.filter((frame) => frame.action === 'attach')).toHaveLength(1);

  const replacement = await f.open();
  f.native(replacement.requestId, snapshot(info.id, 'fresh snapshot'));
  expect((await replacement.first).value).toEqual(
    snapshot(info.id, 'fresh snapshot'),
  );
});

it.each([
  {
    code: 'terminal/unavailable',
    message: 'HUMAN_TERMINAL_AUTHORIZATION_REVOKED',
  },
  { code: 'gateway/internal', message: unavailableAuthority.message },
  { ...unavailableAuthority, message: unavailableAuthority.message + '_OTHER' },
  {
    code: 'terminal/unavailable',
    message: 'HUMAN_TERMINAL_CREDIT_UNAVAILABLE',
  },
])(
  'keeps permanent or unrecognized terminal failure $message ended',
  async (error) => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    f.send({ type: 'terminal.ended', error });
    await until(() => f.carrier.state.getSnapshot().phase === 'ended');
    f.carrier.retryConnection();
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.clients).toHaveLength(1);
    expect(f.carrier.state.getSnapshot().phase).toBe('ended');
    expect(f.carrier.generation.getSnapshot()).toBeUndefined();
  },
);

it('manual retry replaces the backoff once and disposal cannot restart it', async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  f.send({ type: 'terminal.ended', error: unavailableAuthority });
  await until(() => f.carrier.state.getSnapshot().phase === 'disconnected');
  f.carrier.retryConnection();
  f.carrier.retryConnection();
  await until(() => f.carrier.state.getSnapshot().phase === 'connected');
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.clients).toHaveLength(2);
  expect(f.carrier.state.getSnapshot().phase).toBe('connected');

  f.send({ type: 'terminal.ended', error: unavailableAuthority });
  await until(() => f.carrier.state.getSnapshot().phase === 'disconnected');
  f.carrier.dispose();
  f.carrier.retryConnection();
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.clients).toHaveLength(2);
  expect(f.carrier.state.getSnapshot().phase).toBe('ended');
});

it('explicit reauthorization replaces an ended socket without replaying old input', async () => {
  const f = await fixture();
  const old = await f.open();
  f.native(old.requestId, snapshot());
  await old.first;
  old.stream.send({ type: 'write', sequence: 1, data: 'old-input' });
  await until(() => f.sent.some((frame) => frame.type === 'terminal.input'));
  f.clients[0]!.close(4403);
  await until(() => f.carrier.state.getSnapshot().phase === 'ended');
  const sentBefore = f.sent.length;

  f.carrier.reauthorizeConnection();
  f.carrier.reauthorizeConnection();
  await until(() => f.carrier.state.getSnapshot().phase === 'connected');
  expect(f.clients).toHaveLength(2);
  expect(f.carrier.state.getSnapshot().target).toEqual(f.target);
  expect(f.sent.slice(sentBefore)).toEqual([]);
  expect(() =>
    old.stream.send({ type: 'write', sequence: 2, data: 'stale' }),
  ).toThrow();
  expect(f.sent.filter((frame) => frame.action === 'create')).toEqual([]);
  const fresh = await f.open();
  f.native(fresh.requestId, snapshot());
  await fresh.first;
  fresh.stream.send({ type: 'write', sequence: 1, data: 'fresh-input' });
  await until(
    () =>
      f.sent.filter((frame) => frame.type === 'terminal.input').length === 2,
  );
  expect(
    f.sent
      .filter((frame) => frame.type === 'terminal.input')
      .map((frame) => frame.input?.data),
  ).toEqual(['old-input', 'fresh-input']);
});

it('fresh authorization must return the same pinned target before a recovered connection can carry RPC', async () => {
  const f = await fixture();
  f.clients[0]!.close(4403);
  await until(() => f.carrier.state.getSnapshot().phase === 'ended');
  // The real ready gate validates each identity again, even on explicit retry.
  f.target.grantId = randomUUID();
  f.carrier.reauthorizeConnection();
  await until(() => f.clients.length === 2);
  await until(() => f.carrier.state.getSnapshot().phase === 'ended');
  expect(f.carrier.state.getSnapshot().error).toBe('终端连接目标不匹配');
  expect(f.carrier.generation.getSnapshot()).toBeUndefined();
  expect(f.sent).toEqual([]);
});

it('explicit reauthorization cannot revive a disposed terminal owner', async () => {
  const f = await fixture();
  f.carrier.dispose();
  f.carrier.reauthorizeConnection();
  await delay(30);
  expect(f.clients).toHaveLength(1);
  expect(f.carrier.state.getSnapshot().phase).toBe('ended');
  expect(f.carrier.generation.getSnapshot()).toBeUndefined();
});
