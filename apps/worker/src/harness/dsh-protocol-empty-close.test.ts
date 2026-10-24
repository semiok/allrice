import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DshCloseObservationDetails } from '@allrice/database';
import {
  DshProtocolClient,
  type DshNeverCreatedCloseReceipt,
} from './dsh-protocol-client.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

const empty: DshNeverCreatedCloseReceipt = {
  version: 2,
  kind: 'never_created',
  initializeStarted: false,
  moduleLoadStarted: false,
  sdkCreated: false,
  rootCreated: false,
  priorFramesFlushed: true,
};
const active = {
  version: 1,
  sdkShutdown: true,
  rootDisposed: true,
  priorFramesFlushed: true,
};
interface Frame {
  id: number;
  method: string;
}
interface Options {
  proof?: unknown;
  observeClose?: (details: DshCloseObservationDetails) => Promise<void>;
  holdInitialize?: boolean;
  initializeError?: boolean;
  missingAck?: boolean;
  holdClose?: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}
const fixtures: Array<{
  client: DshProtocolClient;
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  finish(code: number | null, signal: NodeJS.Signals | null): void;
  closed(): boolean;
}> = [];
function fixture(options: Options = {}) {
  const frames: Frame[] = [];
  const child = new EventEmitter();
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  let closed = false;
  function finish(
    code: number | null = options.exitCode ?? 0,
    signal: NodeJS.Signals | null = options.signal ?? null,
  ) {
    if (closed) return;
    closed = true;
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  }
  const reply = (id: number, result: unknown) =>
    stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      const frame = JSON.parse(String(chunk)) as Frame;
      frames.push(frame);
      callback();
      queueMicrotask(() => {
        if (frame.method === 'initialize' && !options.holdInitialize) {
          if (options.initializeError)
            stdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: frame.id,
                error: { code: -32603, message: 'fixture initialize denied' },
              }) + '\n',
            );
          else
            reply(frame.id, {
              serverInfo: {
                name: 'deepseek-harness-sdk-runtime',
                version: 'fixture',
              },
            });
        }
        if (frame.method === 'shutdown') {
          if (!options.missingAck)
            reply(frame.id, {
              allriceClose: Object.hasOwn(options, 'proof')
                ? options.proof
                : empty,
            });
          if (!options.holdClose)
            queueMicrotask(() =>
              finish(
                options.exitCode === undefined ? 0 : options.exitCode,
                options.signal ?? null,
              ),
            );
        }
      });
    },
  });
  const kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    finish(null, signal);
    return true;
  });
  Object.assign(child, { pid: 31337, stdout, stderr, stdin, kill });
  mocks.spawn.mockReturnValue(child);
  const client = new DshProtocolClient({
    command: 'mock-only-no-os-child',
    args: [],
    cwd: '/mock-only',
    environment: {},
    requestTimeoutMs: 5000,
    ...(options.observeClose ? { observeClose: options.observeClose } : {}),
  });
  const value = {
    client,
    frames,
    child,
    stdout,
    stderr,
    stdin,
    kill,
    finish,
    closed: () => closed,
  };
  fixtures.push(value);
  return value;
}
beforeEach(() => mocks.spawn.mockReset());
afterEach(async () => {
  for (const f of fixtures) if (!f.closed()) f.finish(null, 'SIGTERM');
  await Promise.allSettled(fixtures.map((f) => f.client.close()));
  for (const f of fixtures.splice(0)) {
    f.stdin.destroy();
    f.stdout.destroy();
    f.stderr.destroy();
  }
  vi.useRealTimers();
});

describe('strict standalone empty transport contract', () => {
  it('accepts exactly seven empty keys without claiming SDK/root cleanup', async () => {
    const f = fixture();
    await expect(f.client.close()).resolves.toBeUndefined();
    const evidence = f.client.closureEvidence();
    expect(evidence).toMatchObject({
      process: {
        state: 'exited',
        stdioClosed: true,
        exitCode: 0,
        signal: null,
      },
      shutdownAcknowledged: true,
      wrapperCleanupConfirmed: false,
      emptyTransportClosed: true,
      terminationAttempted: null,
    });
    expect(evidence?.emptyCloseReceipt).toEqual(empty);
    expect(Object.keys(evidence!.emptyCloseReceipt!)).toHaveLength(7);
    expect(Object.isFrozen(evidence?.emptyCloseReceipt)).toBe(true);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(f.kill).not.toHaveBeenCalled();
  });

  const fields = [
    ['version', 1],
    ['version', 3],
    ['kind', 'initialized'],
    ['initializeStarted', true],
    ['moduleLoadStarted', true],
    ['sdkCreated', true],
    ['rootCreated', true],
    ['priorFramesFlushed', false],
    ['sdkCreated', 'false'],
  ] as const;
  const missingRoot: Partial<DshNeverCreatedCloseReceipt> = { ...empty };
  delete missingRoot.rootCreated;
  it.each([
    ...fields.map(([key, value]) => ({
      label: key + '=' + String(value),
      proof: { ...empty, [key]: value },
    })),
    { label: 'extra fake SDK success', proof: { ...empty, sdkShutdown: true } },
    { label: 'missing rootCreated', proof: missingRoot },
    { label: 'null', proof: null },
    { label: 'array', proof: [] },
    { label: 'missing proof', proof: undefined },
  ])(
    'rejects malformed or contradictory receipt: $label',
    async ({ proof }) => {
      const f = fixture({ proof });
      await expect(f.client.close()).rejects.toMatchObject({
        code: 'DSH_RUNTIME_CLOSE_UNCONFIRMED',
      });
      expect(f.client.closureEvidence()).toMatchObject({
        emptyTransportClosed: false,
        emptyCloseReceipt: null,
        wrapperCleanupConfirmed: false,
      });
      expect(f.closed()).toBe(true);
      expect(f.kill).not.toHaveBeenCalled();
    },
  );

  it('does not turn a durable owner into a semantic confirmation or never_spawned', async () => {
    const observations: DshCloseObservationDetails[] = [];
    const f = fixture({
      observeClose: async (details) => {
        observations.push(details);
      },
    });
    await expect(f.client.close()).rejects.toMatchObject({
      code: 'DSH_RUNTIME_CLOSE_UNCONFIRMED',
    });
    expect(observations.map((x) => x.kind)).toEqual([
      'close_started',
      'close_request',
      'process_closed',
    ]);
    expect(observations.find((x) => x.kind === 'close_request')).toEqual({
      kind: 'close_request',
      acknowledged: true,
      wrapper: null,
    });
    expect(observations.find((x) => x.kind === 'process_closed')).toEqual({
      kind: 'process_closed',
      fact: {
        source: 'child_close',
        stdioClosed: true,
        exitCode: 0,
        signal: null,
        terminationAttempted: null,
      },
    });
    expect(f.client.closureEvidence()).toMatchObject({
      wrapperCleanupConfirmed: false,
      emptyTransportClosed: true,
    });
  });

  it('rejects empty after completed initialize', async () => {
    const f = fixture();
    await f.client.initialize({
      cwd: '/mock-only',
      provider: 'fixture',
      model: 'fixture',
    });
    await expect(f.client.close()).rejects.toMatchObject({
      code: 'DSH_RUNTIME_CLOSE_UNCONFIRMED',
    });
    expect(f.client.closureEvidence()).toMatchObject({
      emptyTransportClosed: false,
      emptyCloseReceipt: null,
    });
  });

  it('fences pending initialize before a response exists', async () => {
    const f = fixture({ holdInitialize: true });
    const initializing = f.client
      .initialize({ cwd: '/mock-only', provider: 'fixture', model: 'fixture' })
      .catch((e: unknown) => e);
    await expect(f.client.close()).rejects.toMatchObject({
      code: 'DSH_RUNTIME_CLOSE_UNCONFIRMED',
    });
    await initializing;
    expect(f.frames.map((x) => x.method)).toEqual(['initialize', 'shutdown']);
    expect(f.client.closureEvidence()).toMatchObject({
      emptyTransportClosed: false,
      emptyCloseReceipt: null,
    });
  });

  it('does not clear the local initialization fence after initialize fails', async () => {
    const f = fixture({ initializeError: true });
    await expect(
      f.client.initialize({
        cwd: '/mock-only',
        provider: 'fixture',
        model: 'fixture',
      }),
    ).rejects.toMatchObject({ code: 'DSH_REQUEST_FAILED' });
    await expect(f.client.close()).rejects.toMatchObject({
      code: 'DSH_RUNTIME_CLOSE_UNCONFIRMED',
    });
    expect(f.client.closureEvidence()).toMatchObject({
      emptyTransportClosed: false,
      emptyCloseReceipt: null,
    });
  });

  it('requires an ACK even when the same child exits normally', async () => {
    const f = fixture({ missingAck: true });
    await expect(f.client.close()).rejects.toMatchObject({
      code: 'DSH_RUNTIME_CLOSE_UNCONFIRMED',
    });
    expect(f.client.closureEvidence()).toMatchObject({
      process: { state: 'exited', exitCode: 0 },
      shutdownAcknowledged: false,
      emptyTransportClosed: false,
    });
  });

  it.each([
    { exitCode: 1, signal: null },
    { exitCode: null, signal: 'SIGTERM' as const },
  ])('rejects abnormal exit $exitCode / $signal', async (options) => {
    const f = fixture(options);
    await expect(f.client.close()).rejects.toMatchObject({
      code: 'DSH_RUNTIME_CLOSE_UNCONFIRMED',
    });
    expect(f.client.closureEvidence()).toMatchObject({
      process: { state: 'exited', stdioClosed: true, ...options },
      emptyTransportClosed: false,
    });
  });

  it('keeps the original two-second exit guard and rejects an escalated close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = fixture({ holdClose: true });
    const result = f.client.close().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toMatchObject({
      code: 'DSH_RUNTIME_CLOSE_UNCONFIRMED',
    });
    expect(f.kill).toHaveBeenCalledTimes(1);
    expect(f.kill).toHaveBeenCalledWith('SIGTERM');
    expect(f.client.closureEvidence()).toMatchObject({
      emptyTransportClosed: false,
      terminationAttempted: 'SIGTERM',
    });
  });

  it('does not accept an ACK arriving after the original two-second request deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = fixture({ missingAck: true, holdClose: true });
    const result = f.client.close().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2000);
    const frame = f.frames.find((x) => x.method === 'shutdown')!;
    f.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: frame.id,
        result: { allriceClose: empty },
      }) + '\n',
    );
    f.finish(0, null);
    expect(await result).toMatchObject({
      code: 'DSH_RUNTIME_CLOSE_UNCONFIRMED',
    });
    expect(f.client.closureEvidence()).toMatchObject({
      shutdownAcknowledged: false,
      emptyTransportClosed: false,
      terminationAttempted: null,
    });
    expect(f.kill).not.toHaveBeenCalled();
  });

  it('preserves the active v1 observation ABI after initialize', async () => {
    const observations: DshCloseObservationDetails[] = [];
    const f = fixture({
      proof: active,
      observeClose: async (details) => {
        observations.push(details);
      },
    });
    await f.client.initialize({
      cwd: '/mock-only',
      provider: 'fixture',
      model: 'fixture',
    });
    await expect(f.client.close()).resolves.toBeUndefined();
    expect(f.client.closureEvidence()).toMatchObject({
      wrapperCleanupConfirmed: true,
      emptyTransportClosed: false,
      emptyCloseReceipt: null,
    });
    expect(observations.find((x) => x.kind === 'close_request')).toEqual({
      kind: 'close_request',
      acknowledged: true,
      wrapper: active,
    });
  });

  it.each(['sdkShutdown', 'rootDisposed', 'priorFramesFlushed'] as const)(
    'does not accept partial v1 cleanup: %s',
    async (key) => {
      const f = fixture({ proof: { ...active, [key]: false } });
      await expect(f.client.close()).rejects.toMatchObject({
        code: 'DSH_RUNTIME_CLOSE_UNCONFIRMED',
      });
      expect(f.client.closureEvidence()?.wrapperCleanupConfirmed).toBe(false);
    },
  );

  it('reaps the child before surfacing observation write failure', async () => {
    const f = fixture({
      proof: active,
      observeClose: async () => {
        throw Error('observation failed');
      },
    });
    await expect(f.client.close()).rejects.toBeInstanceOf(AggregateError);
    expect(f.closed()).toBe(true);
    expect(f.client.closureEvidence()?.wrapperCleanupConfirmed).toBe(true);
  });

  it('joins concurrent close calls and sends exactly one shutdown frame', async () => {
    const f = fixture();
    const first = f.client.close(),
      second = f.client.close();
    expect(first).toBe(second);
    await first;
    expect(f.frames.map((x) => x.method)).toEqual(['shutdown']);
  });
});
