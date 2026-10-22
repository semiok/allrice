import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
  const send = async (frame: BridgeTerminalClientFrame) => {
    frames.push(frame);
    return true;
  };
  const receive = (frame: BridgeTerminalServerFrame) =>
    relay.receive(frame, send);
  async function open(scope = target) {
    const id = randomUUID();
    receive({ version: 1, type: 'terminal.open', id, target: scope });
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
