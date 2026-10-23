import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  TerminalNativeFrameSchema,
  bridgeSocketMaximumFrameBytes,
  type BridgeTerminalClientFrame,
  type BridgeTerminalServerFrame,
  type TerminalInput,
  type TerminalRequest,
  type TerminalTarget,
} from '@allrice/contracts';
import { HumanTerminalHost } from './human-terminal-host.js';
import { HumanTerminalRelay } from './human-terminal-relay.js';
import type { BridgeConfig } from './config.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

async function eventually<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  label = 'terminal',
) {
  const deadline = performance.now() + 7_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (performance.now() >= deadline) throw Error(`Timed out: ${label}`);
    await delay(5);
  }
}

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-human-terminal-')),
  );
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const target: TerminalTarget = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    loginSessionId: randomUUID(),
    sessionId: randomUUID(),
    deviceId: randomUUID(),
    grantId: randomUUID(),
    grantVersion: 1,
    rootFingerprint: createHash('sha256').update(root).digest('hex'),
    label: '测试授权目录',
  };
  const config: BridgeConfig = {
    server: 'https://example.invalid',
    deviceId: target.deviceId,
    deviceName: 'Test Mac',
    grants: [
      {
        id: target.grantId,
        label: target.label,
        rootPath: root,
        rootFingerprint: target.rootFingerprint,
      },
    ],
  };
  let authorized: 'current' | 'revoked' | 'unknown' = 'current';
  const authority = vi.fn(async () => authorized);
  const host = new HumanTerminalHost({
    server: config.server,
    deviceId: config.deviceId,
    currentConfig: async () => config,
    authorizeTarget: authority,
    terminal: {
      shell: { path: '/bin/zsh', name: 'zsh', args: ['-f', '-i'] },
      unattendedTimeoutMs: 0,
    },
  });
  const relay = new HumanTerminalRelay(host);
  cleanup.push(() => relay.dispose());
  const frames: BridgeTerminalClientFrame[] = [];
  const received: BridgeTerminalServerFrame[] = [];
  const modes = new Map<string, 'pull' | 'push'>();
  const send = async (frame: BridgeTerminalClientFrame) => {
    frames.push(frame);
    return true;
  };
  const receive = (frame: BridgeTerminalServerFrame) => {
    received.push(frame);
    relay.receive(frame, send);
  };
  async function open(scope = target, streamMode?: 'pull' | 'push') {
    const id = randomUUID();
    modes.set(id, streamMode ?? 'pull');
    receive({
      version: 1,
      type: 'terminal.open',
      id,
      target: scope,
      ...(streamMode ? { streamMode } : {}),
    });
    await eventually(
      () =>
        frames.find(
          (frame) =>
            frame.id === id &&
            (frame.type === 'terminal.ready' ||
              frame.type === 'terminal.ended'),
        ),
      Boolean,
      'channel ready',
    );
    expect(frames.find((frame) => frame.id === id)?.type).toBe(
      'terminal.ready',
    );
    return id;
  }
  async function rpc(
    id: string,
    action: TerminalRequest['action'],
    args: unknown = {},
  ) {
    const requestId = randomUUID();
    receive({
      version: 1,
      type: 'terminal.request',
      id,
      requestId,
      action,
      args,
    });
    const result = await eventually(
      () =>
        frames.find(
          (frame) =>
            frame.type === 'terminal.result' &&
            frame.id === id &&
            frame.requestId === requestId,
        ),
      Boolean,
      action,
    );
    if (result?.type !== 'terminal.result') throw Error('Missing result');
    return result.result;
  }
  function stream(
    id: string,
    terminalId: string,
    action: 'attach' | 'retain' = 'attach',
  ) {
    const requestId = randomUUID();
    receive({
      version: 1,
      type: 'terminal.request',
      id,
      requestId,
      action,
      args: { id: terminalId },
    });
    let cursor = frames.length;
    return {
      requestId,
      send(input: TerminalInput) {
        receive({ version: 1, type: 'terminal.input', id, requestId, input });
      },
      async next() {
        if (modes.get(id) !== 'push')
          receive({ version: 1, type: 'terminal.next', id, requestId });
        const first = await eventually(
          () =>
            frames
              .slice(cursor)
              .find(
                (frame) =>
                  'requestId' in frame && frame.requestId === requestId,
              ),
          Boolean,
          'stream credit',
        );
        if (!first || !('requestId' in first))
          throw Error('Missing stream frame');
        if (first.type === 'terminal.fragment') {
          const fragments = await eventually(
            () =>
              frames
                .slice(cursor)
                .filter(
                  (
                    frame,
                  ): frame is Extract<
                    BridgeTerminalClientFrame,
                    { type: 'terminal.fragment' }
                  > =>
                    frame.type === 'terminal.fragment' &&
                    frame.requestId === requestId,
                ),
            (items) => items.length === first.total,
            'snapshot fragments',
          );
          cursor = frames.lastIndexOf(fragments.at(-1)!) + 1;
          expect(fragments.map((part) => part.index)).toEqual(
            Array.from({ length: first.total }, (_, index) => index),
          );
          for (const part of fragments)
            expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThan(
              bridgeSocketMaximumFrameBytes,
            );
          return TerminalNativeFrameSchema.parse(
            JSON.parse(fragments.map((part) => part.data).join('')),
          );
        }
        cursor = frames.indexOf(first) + 1;
        if (first.type === 'terminal.finished')
          throw Error(first.error?.message ?? 'Terminal stream finished');
        if (first.type !== 'terminal.frame')
          throw Error('Unexpected stream frame');
        return first.frame;
      },
    };
  }
  async function create(
    id: string,
    terminalId = 'native-terminal',
    cols = 100,
    rows = 30,
  ) {
    const result = await rpc(id, 'create', {
      request: { id: terminalId, cols, rows },
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return terminalId;
  }
  return {
    root,
    target,
    config,
    host,
    relay,
    frames,
    received,
    receive,
    open,
    rpc,
    stream,
    create,
    authority,
    authorize(value: typeof authorized) {
      authorized = value;
    },
  };
}

function controlledStream(values: unknown[] = []) {
  const queued = [...values];
  let closed = false;
  let waiting: ((value: IteratorResult<unknown>) => void) | undefined;
  const iterator: AsyncIterableIterator<unknown> & {
    push(value: unknown): void;
  } = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: vi.fn(async () => {
      if (closed) return { done: true as const, value: undefined };
      if (queued.length) return { done: false as const, value: queued.shift() };
      if (waiting) throw Error('Concurrent native read');
      return await new Promise<IteratorResult<unknown>>((resolve) => {
        waiting = resolve;
      });
    }),
    return: vi.fn(async () => {
      closed = true;
      waiting?.({ done: true, value: undefined });
      waiting = undefined;
      return { done: true as const, value: undefined };
    }),
    push(value) {
      if (closed) throw Error('Native stream is closed');
      if (waiting) {
        const resolve = waiting;
        waiting = undefined;
        resolve({ done: false, value });
      } else queued.push(value);
    },
  };
  return iterator;
}

async function carrierFixture(
  values: unknown[],
  sendFrame: (
    frame: BridgeTerminalClientFrame,
  ) => Promise<boolean> = async () => true,
  streamMode?: 'pull' | 'push',
) {
  const target: TerminalTarget = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    loginSessionId: randomUUID(),
    sessionId: randomUUID(),
    deviceId: randomUUID(),
    grantId: randomUUID(),
    grantVersion: 1,
    rootFingerprint: 'a'.repeat(64),
    label: 'Carrier test',
  };
  const native = controlledStream(values);
  const stream = vi.fn(() => native);
  const owner = { stream, call: vi.fn(async () => undefined) };
  const host = {
    acquire: vi.fn(async () => owner),
    validate: vi.fn(async () => '/carrier-test'),
    release: vi.fn(async () => undefined),
    revalidate: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
  const relay = new HumanTerminalRelay(host as unknown as HumanTerminalHost);
  cleanup.push(() => relay.dispose());
  const frames: BridgeTerminalClientFrame[] = [];
  const send = async (frame: BridgeTerminalClientFrame) => {
    frames.push(frame);
    return await sendFrame(frame);
  };
  const receive = (frame: BridgeTerminalServerFrame) =>
    relay.receive(frame, send);
  const id = randomUUID();
  receive({
    version: 1,
    type: 'terminal.open',
    id,
    target,
    ...(streamMode ? { streamMode } : {}),
  });
  await eventually(
    () => frames.find((frame) => frame.type === 'terminal.ready'),
    Boolean,
  );
  const requestId = randomUUID();
  receive({
    version: 1,
    type: 'terminal.request',
    id,
    requestId,
    action: 'attach',
    args: { id: 'carrier-terminal' },
  });
  await eventually(
    () => stream.mock.calls.length,
    (count) => count === 1,
  );
  return { id, requestId, relay, host, native, frames, receive };
}

it('legacy channels read exactly one native frame for each credit', async () => {
  const f = await carrierFixture([
    { type: 'ack', sequence: 1 },
    { type: 'output', sequence: 1, data: 'legacy' },
  ]);
  expect(f.native.next).not.toHaveBeenCalled();
  f.receive({
    version: 1,
    type: 'terminal.next',
    id: f.id,
    requestId: f.requestId,
  });
  await eventually(
    () => f.frames.filter((frame) => frame.type === 'terminal.frame'),
    (frames) => frames.length === 1,
  );
  await delay(20);
  expect(f.native.next).toHaveBeenCalledTimes(1);
  f.receive({
    version: 1,
    type: 'terminal.next',
    id: f.id,
    requestId: f.requestId,
  });
  await eventually(
    () => f.frames.filter((frame) => frame.type === 'terminal.frame'),
    (frames) => frames.length === 2,
  );
  expect(f.native.next).toHaveBeenCalledTimes(2);
});

it('push streams preserve a burst of native ACKs and output without read credits', async () => {
  const values = Array.from({ length: 205 }, (_, index) => [
    { type: 'ack', sequence: index + 1 },
    { type: 'output', sequence: index + 1, data: String(index) },
  ]).flat();
  const f = await carrierFixture(values, undefined, 'push');
  const pushed = await eventually(
    () => f.frames.filter((frame) => frame.type === 'terminal.frame'),
    (frames) => frames.length === values.length,
  );
  expect(
    pushed.map((frame) => frame.type === 'terminal.frame' && frame.frame),
  ).toEqual(values);
  // One idle native read remains pending; it is cancelled by the relay owner.
  expect(f.native.next).toHaveBeenCalledTimes(values.length + 1);
  await f.relay.disconnect();
  expect(f.native.return).toHaveBeenCalledTimes(1);
  expect(f.host.release).toHaveBeenCalledTimes(1);
});

it('push backpressure stops native reads and concurrent disconnects join a cancelled send', async () => {
  let resolveBlocked!: (value: boolean) => void;
  const blocked = new Promise<boolean>((resolve) => {
    resolveBlocked = resolve;
  });
  const f = await carrierFixture(
    [
      { type: 'output', sequence: 1, data: 'first' },
      { type: 'output', sequence: 2, data: 'must stay unread' },
    ],
    async (frame) => (frame.type === 'terminal.frame' ? await blocked : true),
    'push',
  );
  await eventually(
    () => f.frames.some((frame) => frame.type === 'terminal.frame'),
    Boolean,
  );
  expect(f.native.next).toHaveBeenCalledTimes(1);
  f.receive({
    version: 1,
    type: 'terminal.cancel',
    id: f.id,
    requestId: f.requestId,
  });
  await eventually(
    () => vi.mocked(f.native.return!).mock.calls.length,
    Boolean,
  );
  let firstDone = false;
  let secondDone = false;
  const first = f.relay.disconnect().then(() => {
    firstDone = true;
  });
  const second = f.relay.disconnect().then(() => {
    secondDone = true;
  });
  await delay(20);
  expect(firstDone).toBe(false);
  expect(secondDone).toBe(false);
  expect(f.host.release).not.toHaveBeenCalled();
  resolveBlocked(true);
  await Promise.all([first, second]);
  expect(f.native.next).toHaveBeenCalledTimes(1);
  expect(f.host.release).toHaveBeenCalledTimes(1);
  expect(
    f.frames.filter((frame) => frame.type === 'terminal.ended'),
  ).toHaveLength(1);
});

it('a failed push send drains its pump and releases its owner without another native read', async () => {
  const f = await carrierFixture(
    [
      { type: 'output', sequence: 1, data: 'carrier full' },
      { type: 'output', sequence: 2, data: 'must stay unread' },
    ],
    async (frame) => frame.type !== 'terminal.frame',
    'push',
  );
  await eventually(
    () => f.frames.some((frame) => frame.type === 'terminal.ended'),
    Boolean,
  );
  await f.relay.disconnect();
  expect(f.native.next).toHaveBeenCalledTimes(1);
  expect(f.native.return).toHaveBeenCalledTimes(1);
  expect(f.host.release).toHaveBeenCalledTimes(1);
});

it('push channels reject read credits and drain the active stream', async () => {
  const f = await carrierFixture([], undefined, 'push');
  f.receive({
    version: 1,
    type: 'terminal.next',
    id: f.id,
    requestId: f.requestId,
  });
  const ended = await eventually(
    () => f.frames.find((frame) => frame.type === 'terminal.ended'),
    Boolean,
  );
  expect(ended).toMatchObject({
    error: { message: 'HUMAN_TERMINAL_CREDIT_UNAVAILABLE' },
  });
  await f.relay.disconnect();
  expect(f.native.return).toHaveBeenCalledTimes(1);
});

it('push output revalidates authority before delivery and drains on revocation', async () => {
  const f = await carrierFixture([], undefined, 'push');
  f.host.validate.mockRejectedValueOnce(
    Error('HUMAN_TERMINAL_AUTHORIZATION_REVOKED'),
  );
  f.native.push({ type: 'output', sequence: 1, data: 'must not be delivered' });
  const ended = await eventually(
    () => f.frames.find((frame) => frame.type === 'terminal.ended'),
    Boolean,
  );
  expect(ended).toMatchObject({
    error: { message: 'HUMAN_TERMINAL_AUTHORIZATION_REVOKED' },
  });
  expect(f.frames.some((frame) => frame.type === 'terminal.frame')).toBe(false);
  expect(f.host.release).toHaveBeenCalledWith(expect.anything(), true);
  await f.relay.disconnect();
  expect(f.native.return).toHaveBeenCalledTimes(1);
});

it('push preserves the cached authorization lease and detaches expired unknown authority without revoking the owner', async () => {
  const authority = await fixture();
  await authority.host.validate(authority.target);
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 400);
  authority.authorize('unknown');
  const f = await carrierFixture([], undefined, 'push');
  f.host.validate.mockImplementation(() =>
    authority.host.validate(authority.target),
  );
  f.native.push({ type: 'output', sequence: 1, data: 'cached authority' });
  await eventually(
    () => f.frames.filter((frame) => frame.type === 'terminal.frame').length,
    (count) => count === 1,
  );
  expect(authority.authority).toHaveBeenCalledTimes(1);

  clock.mockReturnValue(now + 600);
  f.native.push({ type: 'output', sequence: 2, data: 'unexpired lease' });
  await eventually(
    () => f.frames.filter((frame) => frame.type === 'terminal.frame').length,
    (count) => count === 2,
  );
  expect(authority.authority).toHaveBeenCalledTimes(2);

  clock.mockReturnValue(now + 6_000);
  f.native.push({ type: 'output', sequence: 3, data: 'must not be delivered' });
  const ended = await eventually(
    () => f.frames.find((frame) => frame.type === 'terminal.ended'),
    Boolean,
  );
  expect(ended).toMatchObject({
    error: { message: 'HUMAN_TERMINAL_AUTHORIZATION_UNAVAILABLE' },
  });
  expect(
    f.frames.filter((frame) => frame.type === 'terminal.frame'),
  ).toHaveLength(2);
  expect(f.host.release).toHaveBeenCalledWith(expect.anything(), false);
  await f.relay.disconnect();
  expect(f.native.return).toHaveBeenCalledTimes(1);
});

it.skipIf(process.platform !== 'darwin')(
  'push carries a real native character burst and ordered ACKs without credits',
  async () => {
    const f = await fixture();
    const channel = await f.open(f.target, 'push');
    const terminal = await f.create(channel);
    const retention = f.stream(channel, terminal, 'retain');
    expect(await retention.next()).toEqual({ type: 'retained' });
    const stream = f.stream(channel, terminal);
    expect(await stream.next()).toMatchObject({
      type: 'snapshot',
      writable: true,
    });
    const text = '0123456789abcdef'.repeat(12);
    const command = `printf '%s' '${text}' > burst-order; printf '\\nNATIVE_PUSH_DONE\\n'\r`;
    let sequence = 0;
    for (const data of command)
      stream.send({ type: 'write', sequence: ++sequence, data });
    const acknowledgements: number[] = [];
    let output = '';
    while (
      acknowledgements.length !== sequence ||
      !output.includes('NATIVE_PUSH_DONE\r\n')
    ) {
      const frame = await stream.next();
      if (frame.type === 'ack') {
        expect(frame.refusal).toBeUndefined();
        acknowledgements.push(frame.sequence);
      } else if (frame.type === 'output') output += frame.data;
    }
    expect(acknowledgements).toEqual(
      Array.from({ length: sequence }, (_, index) => index + 1),
    );
    expect(await readFile(join(f.root, 'burst-order'), 'utf8')).toBe(text);
    expect(f.received.some((frame) => frame.type === 'terminal.next')).toBe(
      false,
    );
    await f.relay.disconnect();
    const reconnected = await f.open(f.target, 'push');
    expect(await f.rpc(reconnected, 'list')).toMatchObject({
      ok: true,
      value: [{ id: terminal, state: 'running' }],
    });
  },
  15_000,
);

it.skipIf(process.platform !== 'darwin')(
  'revocation drains a push attachment and terminates its native background processes',
  async () => {
    const f = await fixture();
    const channel = await f.open(f.target, 'push');
    const terminal = await f.create(channel);
    const stream = f.stream(channel, terminal);
    await stream.next();
    stream.send({
      type: 'write',
      sequence: 1,
      data: "sleep 100 & printf '%s' $! > push-background.pid\r",
    });
    const pid = await eventually(
      () =>
        readFile(join(f.root, 'push-background.pid'), 'utf8').catch(() => ''),
      (value) => /^\d+$/.test(value),
    );
    process.kill(Number(pid), 0);
    f.config.grants[0]!.revokedAt = new Date().toISOString();
    stream.send({
      type: 'write',
      sequence: 2,
      data: 'printf forbidden > push-revoked-input\r',
    });
    const ended = await eventually(
      () =>
        f.frames.find(
          (frame) => frame.id === channel && frame.type === 'terminal.ended',
        ),
      Boolean,
    );
    expect(ended).toMatchObject({
      error: { message: 'HUMAN_TERMINAL_GRANT_UNAVAILABLE' },
    });
    await eventually(() => {
      try {
        process.kill(Number(pid), 0);
        return false;
      } catch {
        return true;
      }
    }, Boolean);
    await expect(
      readFile(join(f.root, 'push-revoked-input')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await f.relay.disconnect();
  },
  15_000,
);

it.skipIf(process.platform !== 'darwin')(
  'native PTY passes TTY, Tab, Ctrl+C, resize and owned background-process cleanup through the typed relay',
  async () => {
    const f = await fixture();
    const channel = await f.open();
    const terminal = await f.create(channel);
    await writeFile(join(f.root, 'completion-proof'), '');
    const stream = f.stream(channel, terminal);
    expect(await stream.next()).toMatchObject({
      type: 'snapshot',
      writable: true,
      info: { cwd: f.root },
    });
    let sequence = 0;
    const output: string[] = [];
    async function command(
      data: string,
      until: (frame: Awaited<ReturnType<typeof stream.next>>) => boolean,
    ) {
      stream.send({ type: 'write', sequence: ++sequence, data });
      for (let count = 0; count < 100; count++) {
        const frame = await stream.next();
        if (frame.type === 'output') output.push(frame.data);
        if (until(frame)) return;
      }
      throw Error('Too many terminal frames');
    }
    await command("test -t 0 && printf 'TTY_PROOF\\n'\r", () =>
      output.join('').includes('TTY_PROOF\r\n'),
    );
    await command(
      'cat completion-\t\r',
      (frame) => frame.type === 'ack' && frame.sequence === sequence,
    );
    await command("printf 'TAB_PROOF\\n'\r", () =>
      output.join('').includes('TAB_PROOF\r\n'),
    );
    expect(output.join('')).toContain('completion-proof');
    stream.send({ type: 'resize', sequence: ++sequence, cols: 88, rows: 25 });
    while (true) {
      const frame = await stream.next();
      if (frame.type === 'ack' && frame.sequence === sequence) break;
    }
    await command(
      'sleep 100\r',
      (frame) => frame.type === 'ack' && frame.sequence === sequence,
    );
    await command(
      '\u0003',
      (frame) => frame.type === 'ack' && frame.sequence === sequence,
    );
    await command("printf 'INTERRUPT_PROOF\\n'\r", () =>
      output.join('').includes('INTERRUPT_PROOF\r\n'),
    );
    await command(
      "sleep 100 & printf '%s' $! > background.pid\r",
      (frame) => frame.type === 'ack' && frame.sequence === sequence,
    );
    const pid = await eventually(
      () => readFile(join(f.root, 'background.pid'), 'utf8').catch(() => ''),
      (value) => /^\d+$/.test(value),
      'background job',
    );
    process.kill(Number(pid), 0);
    await f.relay.disconnect();
    const reconnected = await f.open();
    expect(await f.rpc(reconnected, 'list')).toMatchObject({
      ok: true,
      value: [{ id: terminal, state: 'running' }],
    });
    const recovered = f.stream(reconnected, terminal);
    expect(await recovered.next()).toMatchObject({
      type: 'snapshot',
      writable: true,
    });
    expect(await f.rpc(reconnected, 'close', { id: terminal })).toMatchObject({
      ok: true,
    });
    await eventually(
      () => {
        try {
          process.kill(Number(pid), 0);
          return false;
        } catch {
          return true;
        }
      },
      Boolean,
      'whole terminal process range',
    );
    expect(
      await f.rpc(reconnected, 'create', {
        request: { id: terminal, cols: 100, rows: 30 },
      }),
    ).toMatchObject({ ok: false, error: { code: 'terminal/unavailable' } });
    await f.relay.disconnect();
    const restored = await f.open();
    expect(
      await f.rpc(restored, 'create', {
        request: { id: terminal, cols: 100, rows: 30 },
      }),
    ).toMatchObject({ ok: false, error: { code: 'terminal/unavailable' } });
  },
  25_000,
);

it.skipIf(process.platform !== 'darwin').each([
  {
    name: 'missing locale',
    locale: { LANG: undefined, LC_CTYPE: undefined, LC_ALL: undefined },
    expected: ['en_US.UTF-8', 'en_US.UTF-8', 'unset'],
  },
  {
    name: 'C locale',
    locale: { LANG: 'C', LC_CTYPE: 'C', LC_ALL: 'C' },
    expected: ['C', 'en_US.UTF-8', ''],
  },
  {
    name: 'bare UTF-8 is not a macOS LANG locale',
    locale: { LANG: 'UTF-8', LC_CTYPE: undefined, LC_ALL: undefined },
    expected: ['en_US.UTF-8', 'en_US.UTF-8', 'unset'],
  },
  {
    name: 'bare UTF-8 is not a macOS LC_ALL locale',
    locale: { LANG: 'C', LC_CTYPE: 'C', LC_ALL: 'UTF-8' },
    expected: ['C', 'en_US.UTF-8', ''],
  },
  {
    name: 'existing UTF-8 LANG',
    locale: { LANG: 'zh_CN.UTF-8', LC_CTYPE: undefined, LC_ALL: undefined },
    expected: ['zh_CN.UTF-8', 'unset', 'unset'],
  },
  {
    name: 'UTF-8 LC_CTYPE behind non-UTF-8 LC_ALL',
    locale: { LANG: 'C', LC_CTYPE: 'UTF-8', LC_ALL: 'POSIX' },
    expected: ['C', 'UTF-8', ''],
  },
  {
    name: 'UTF-8 LC_ALL priority over C LC_CTYPE and LANG',
    locale: { LANG: 'C', LC_CTYPE: 'C', LC_ALL: 'ja_JP.UTF-8' },
    expected: ['C', 'C', 'ja_JP.UTF-8'],
  },
  {
    name: 'UTF-8 LC_CTYPE priority over different UTF-8 LANG',
    locale: {
      LANG: 'zh_CN.UTF-8',
      LC_CTYPE: 'ja_JP.UTF-8',
      LC_ALL: 'en_US.ISO8859-1',
    },
    expected: ['zh_CN.UTF-8', 'ja_JP.UTF-8', ''],
  },
  {
    name: 'UTF-8 LANG behind C LC_CTYPE',
    locale: { LANG: 'zh_CN.UTF-8', LC_CTYPE: 'C', LC_ALL: undefined },
    expected: ['zh_CN.UTF-8', 'zh_CN.UTF-8', 'unset'],
  },
])(
  'native PTY preserves Chinese filenames and input bytes with $name',
  async ({ name, locale, expected }) => {
    for (const [key, value] of Object.entries(locale)) vi.stubEnv(key, value);
    const f = await fixture();
    const fileName = '日报-中文-🙂.txt';
    await writeFile(join(f.root, fileName), 'fixture');
    let shellPid: number | undefined;
    let verified: Record<string, unknown> | undefined;
    try {
      const channel = await f.open();
      const terminal = await f.create(channel);
      const stream = f.stream(channel, terminal);
      expect(await stream.next()).toMatchObject({
        type: 'snapshot',
        writable: true,
      });
      let sequence = 0;
      let output = '';
      async function command(data: string, marker: string) {
        stream.send({ type: 'write', sequence: ++sequence, data });
        for (let count = 0; count < 100; count++) {
          const frame = await stream.next();
          if (frame.type === 'output') output += frame.data;
          if (output.includes(`\r\n${marker}\r\n`)) return;
        }
        throw Error('Too many locale terminal frames');
      }
      await command(
        "printf '%s' $$ > locale-shell.pid; printf '%s\\n' \"${LANG-unset}\" \"${LC_CTYPE-unset}\" \"${LC_ALL-unset}\" > locale-values; /usr/bin/locale charmap > locale-charmap; printf '\\nLOCALE_LS_BEGIN\\n'; /bin/ls; printf '\\nLOCALE_LS_END\\n'\r",
        'LOCALE_LS_END',
      );
      shellPid = Number(
        await readFile(join(f.root, 'locale-shell.pid'), 'utf8'),
      );
      expect(Number.isSafeInteger(shellPid) && shellPid > 1).toBe(true);
      const listing = output
        .split('\r\nLOCALE_LS_BEGIN\r\n')[1]!
        .split('\r\nLOCALE_LS_END\r\n')[0]!;
      expect(listing).toContain(fileName);
      expect(listing).not.toContain('\uFFFD');
      expect(
        (await readFile(join(f.root, 'locale-values'), 'utf8'))
          .replace(/\n$/, '')
          .split('\n'),
      ).toEqual(expected);
      expect(
        (await readFile(join(f.root, 'locale-charmap'), 'utf8')).trim(),
      ).toMatch(/^UTF-?8$/i);
      const input = '中文输入-🙂-准确字节';
      output = '';
      await command(
        `printf '%s' '${input}' > locale-input; printf '\\nLOCALE_INPUT_END\\n'\r`,
        'LOCALE_INPUT_END',
      );
      expect(await readFile(join(f.root, 'locale-input'))).toEqual(
        Buffer.from(input, 'utf8'),
      );
      expect(await f.rpc(channel, 'close', { id: terminal })).toMatchObject({
        ok: true,
      });
      verified = {
        locale,
        effectiveLocale: expected,
        listing,
        inputSha256: createHash('sha256').update(input).digest('hex'),
        passed: true,
      };
    } finally {
      await f.relay.dispose();
      const ownedPid = shellPid;
      if (ownedPid)
        await eventually(
          () => {
            try {
              process.kill(ownedPid, 0);
              return false;
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === 'ESRCH';
            }
          },
          Boolean,
          'locale terminal process exit',
        );
      await rm(f.root, { recursive: true, force: true });
      await expect(readFile(join(f.root, fileName))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const proof = {
        name,
        root: f.root,
        shellPid,
        ...verified,
        shellExited: shellPid !== undefined,
        removed: true,
      };
      if (process.env.ALLRICE_TERMINAL_LOCALE_EVIDENCE_PATH)
        await appendFile(
          process.env.ALLRICE_TERMINAL_LOCALE_EVIDENCE_PATH,
          JSON.stringify(proof) + '\n',
          { mode: 0o600 },
        );
    }
  },
  20_000,
);

it.skipIf(process.platform !== 'darwin')(
  'the newest native attachment owns input; an older browser receives a read-only ACK without executing',
  async () => {
    const f = await fixture();
    const first = await f.open();
    const second = await f.open();
    const terminal = await f.create(first);
    const older = f.stream(first, terminal);
    expect(await older.next()).toMatchObject({
      type: 'snapshot',
      writable: true,
    });
    const newer = f.stream(second, terminal);
    expect(await newer.next()).toMatchObject({
      type: 'snapshot',
      writable: true,
    });
    while (true) {
      const frame = await older.next();
      if (frame.type === 'state') {
        expect(frame.writable).toBe(false);
        break;
      }
    }
    older.send({
      type: 'write',
      sequence: 1,
      data: 'printf bad > old-input\r',
    });
    while (true) {
      const frame = await older.next();
      if (frame.type === 'ack') {
        expect(frame).toMatchObject({ sequence: 1, refusal: 'read-only' });
        break;
      }
    }
    await expect(readFile(join(f.root, 'old-input'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    newer.send({
      type: 'write',
      sequence: 1,
      data: 'printf good > new-input\r',
    });
    await eventually(
      () => readFile(join(f.root, 'new-input'), 'utf8').catch(() => ''),
      (value) => value === 'good',
      'new owner input',
    );
    const unrelated = await f.open({
      ...f.target,
      ownerId: randomUUID(),
      loginSessionId: randomUUID(),
      sessionId: randomUUID(),
    });
    const foreign = f.stream(unrelated, terminal);
    await expect(foreign.next()).rejects.toThrow(
      'Terminal no longer exists in this Session',
    );
  },
  15_000,
);

it.skipIf(process.platform !== 'darwin')(
  'expired unknown authority suspends input and preserves the PTY; explicit revocation cleans it up',
  async () => {
    const f = await fixture();
    const channel = await f.open();
    const terminal = await f.create(channel);
    const stream = f.stream(channel, terminal);
    await stream.next();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 6_000);
    f.authorize('unknown');
    stream.send({
      type: 'write',
      sequence: 1,
      data: 'printf bad > stale-authority\r',
    });
    await eventually(
      () =>
        f.frames.find(
          (frame) => frame.id === channel && frame.type === 'terminal.ended',
        ),
      Boolean,
      'expired lease detaches',
    );
    await expect(
      readFile(join(f.root, 'stale-authority')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    f.authorize('current');
    clock.mockReturnValue(now + 7_000);
    const current = await f.open();
    expect(await f.rpc(current, 'list')).toMatchObject({
      ok: true,
      value: [{ id: terminal, state: 'running' }],
    });
    f.authorize('revoked');
    clock.mockReturnValue(now + 8_000);
    await f.relay.revalidate();
    f.receive({
      version: 1,
      type: 'terminal.request',
      id: current,
      requestId: randomUUID(),
      action: 'list',
      args: {},
    });
    // The retained native owner is destroyed even though its old browser was
    // detached; no create/replay is used to recover from permission loss.
    const ended = await eventually(
      () =>
        f.frames.find(
          (frame) => frame.id === current && frame.type === 'terminal.ended',
        ),
      Boolean,
      'explicit revocation ends channel',
    );
    expect(ended).toMatchObject({ error: { code: 'terminal/unavailable' } });
    await expect(f.host.acquire(f.target)).rejects.toThrow(
      'HUMAN_TERMINAL_AUTHORIZATION_REVOKED',
    );
  },
  15_000,
);

it.skipIf(process.platform !== 'darwin')(
  'large native screen snapshots cross bounded fragments without extra stream credits or byte rewriting',
  async () => {
    const f = await fixture();
    const channel = await f.open();
    const terminal = await f.create(channel, 'large-screen', 500, 200);
    const first = f.stream(channel, terminal);
    await first.next();
    first.send({
      type: 'write',
      sequence: 1,
      data: `for i in {1..1250}; do printf '${'😀'.repeat(200)} %s\\n' $i; done; printf done > rendered\r`,
    });
    await eventually(
      () => readFile(join(f.root, 'rendered'), 'utf8').catch(() => ''),
      (value) => value === 'done',
      'native screen population',
    );
    const second = f.stream(channel, terminal);
    const snapshot = await second.next();
    expect(snapshot.type).toBe('snapshot');
    expect(
      f.frames.filter(
        (frame) =>
          frame.type === 'terminal.fragment' &&
          frame.requestId === second.requestId,
      ).length,
    ).toBeGreaterThan(1);
    if (snapshot.type === 'snapshot') {
      expect(snapshot.screen).toContain('😀'.repeat(20));
      expect(snapshot.screen).toContain('1250');
      expect(snapshot.screen).not.toContain('\uFFFD');
      const fragments = f.frames.filter(
        (
          frame,
        ): frame is Extract<
          BridgeTerminalClientFrame,
          { type: 'terminal.fragment' }
        > =>
          frame.type === 'terminal.fragment' &&
          frame.requestId === second.requestId,
      );
      expect(
        fragments.reduce((sum, part) => sum + Buffer.byteLength(part.data), 0),
      ).toBe(Buffer.byteLength(JSON.stringify(snapshot)));
    }
  },
  15_000,
);
