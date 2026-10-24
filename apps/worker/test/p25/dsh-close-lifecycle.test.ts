import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DshCloseObservationDetails } from '@allrice/database';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));
import { DshProtocolClient } from '../../src/harness/dsh-protocol-client.js';

const proof = {
  version: 1,
  sdkShutdown: true,
  rootDisposed: true,
  priorFramesFlushed: true,
};
type Plan = {
  emptyAck?: boolean;
  silent?: boolean;
  exitCode?: number;
  exitOnly?: boolean;
  wrapper?: typeof proof;
  observe?: (details: DshCloseObservationDetails) => Promise<void>;
};
class SyntheticChild extends EventEmitter {
  pid = 30001;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new Writable();
  kill = vi.fn<(signal: NodeJS.Signals) => boolean>();
}
interface Fixture {
  child: SyntheticChild;
  client: DshProtocolClient;
  observations: DshCloseObservationDetails[];
  finish(code?: number | null, signal?: NodeJS.Signals | null): void;
}
const fixtures: Fixture[] = [];
const releases: (() => void)[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  releases.push(resolve);
  return { promise, resolve };
}
function fixture(plan: Plan = {}): Fixture {
  // Real Node streams and actual ProtocolClient; OS spawn is replaced. These
  // synthetic events are never evidence of a real Native/SDK process closing.
  const child = new SyntheticChild();
  let closed = false;
  const observations: DshCloseObservationDetails[] = [];
  const finish = (
    code: number | null = 0,
    signal: NodeJS.Signals | null = null,
  ) => {
    if (closed) return;
    closed = true;
    child.emit('exit', code, signal);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code, signal);
  };
  child.kill.mockImplementation((signal: NodeJS.Signals) => {
    if (signal === 'SIGKILL') queueMicrotask(() => finish(null, signal));
    return true;
  });
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const request = JSON.parse(String(chunk));
      callback();
      if (request.method === 'shutdown' && !plan.silent)
        queueMicrotask(() => {
          child.stdout.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: plan.emptyAck
                ? {}
                : { allriceClose: plan.wrapper ?? proof },
            }) + '\n',
          );
        });
    },
    final(callback) {
      callback();
      if (plan.exitOnly) queueMicrotask(() => child.emit('exit', 0, null));
      else if (!plan.silent) queueMicrotask(() => finish(plan.exitCode ?? 0));
    },
  });
  spawn.mockReturnValueOnce(child);
  const client = new DshProtocolClient({
    command: '/synthetic/unspawned',
    args: [],
    cwd: '/synthetic',
    environment: {},
    requestTimeoutMs: 1000,
    observeClose: async (details) => {
      observations.push(details);
      await plan.observe?.(details);
    },
  });
  const result = { child, client, observations, finish };
  fixtures.push(result);
  return result;
}

afterEach(async () => {
  releases.splice(0).forEach((resolve) => resolve());
  for (const f of fixtures) f.finish(1);
  await Promise.allSettled(fixtures.map((f) => f.client.close()));
  for (const f of fixtures.splice(0)) {
    f.child.stdin.destroy();
    f.child.stdout.destroy();
    f.child.stderr.destroy();
  }
  if (vi.isFakeTimers()) {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  }
  spawn.mockReset();
});

describe('DSH close protocol ownership with synthetic streams, no Host or provider', () => {
  it('shares concurrent close and requires true public stages plus normal child close', async () => {
    const f = fixture(),
      first = f.client.close();
    expect(f.client.close()).toBe(first);
    await first;
    expect(f.client.closureEvidence()).toMatchObject({
      shutdownAcknowledged: true,
      wrapperCleanupConfirmed: true,
      terminationAttempted: null,
      process: {
        state: 'exited',
        stdioClosed: true,
        exitCode: 0,
        signal: null,
      },
    });
    expect(f.observations.map((x) => x.kind)).toEqual([
      'close_started',
      'close_request',
      'process_closed',
    ]);
    expect(f.child.kill).not.toHaveBeenCalled();
  });
  it('retains empty-ACK exit0 as physically exited and semantically unconfirmed', async () => {
    const f = fixture({ emptyAck: true });
    await expect(f.client.close()).rejects.toMatchObject({
      code: 'DSH_RUNTIME_CLOSE_UNCONFIRMED',
      evidence: {
        shutdownAcknowledged: true,
        wrapperCleanupConfirmed: false,
        process: { state: 'exited', stdioClosed: true, exitCode: 0 },
      },
    });
    expect(f.observations[1]).toMatchObject({
      kind: 'close_request',
      wrapper: null,
    });
  });
  it('does not infer normal/semantic closure from true stages followed by nonzero exit', async () => {
    const f = fixture({ exitCode: 1 });
    await expect(f.client.close()).rejects.toMatchObject({
      code: 'DSH_RUNTIME_CLOSE_UNCONFIRMED',
      evidence: {
        wrapperCleanupConfirmed: true,
        process: { exitCode: 1, stdioClosed: true },
      },
    });
  });
  it('retains a false public cleanup stage even after normal physical exit', async () => {
    const f = fixture({ wrapper: { ...proof, rootDisposed: false } });
    await expect(f.client.close()).rejects.toMatchObject({
      code: 'DSH_RUNTIME_CLOSE_UNCONFIRMED',
      evidence: {
        wrapperCleanupConfirmed: false,
        process: { exitCode: 0, stdioClosed: true },
      },
    });
  });
  it('does not promote exit alone to child-close or completed stdio', async () => {
    const f = fixture({ exitOnly: true });
    const exited = once(f.child, 'exit');
    let complete = false;
    const closing = f.client.close().then(() => {
      complete = true;
    });
    await exited;
    expect(f.client.processState()).toMatchObject({
      state: 'exited',
      stdioClosed: false,
    });
    expect(complete).toBe(false);
    expect(f.observations.some((x) => x.kind === 'process_closed')).toBe(false);
    f.finish();
    await closing;
    expect(complete).toBe(true);
  });
  it('escalates only the owned synthetic child and awaits its close before failure', async () => {
    vi.useFakeTimers();
    const f = fixture({ silent: true });
    const result = f.client.close().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await result).toMatchObject({
      code: 'DSH_RUNTIME_CLOSE_UNCONFIRMED',
      evidence: {
        terminationAttempted: 'SIGKILL',
        process: { signal: 'SIGKILL', stdioClosed: true },
      },
    });
    expect(f.child.kill.mock.calls.map(([signal]) => signal)).toEqual([
      'SIGTERM',
      'SIGKILL',
    ]);
    expect(f.observations.at(-1)).toMatchObject({
      kind: 'process_closed',
      fact: { source: 'child_close' },
    });
  });
  it('preserves both semantic and durable-write failure without inventing a live child', async () => {
    const failure = Error('durable close write failed');
    const f = fixture({
      emptyAck: true,
      observe: async (details) => {
        if (details.kind === 'process_closed') throw failure;
      },
    });
    const closing = f.client.close(),
      result = await closing.catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([
      expect.objectContaining({ code: 'DSH_RUNTIME_CLOSE_UNCONFIRMED' }),
      failure,
    ]);
    expect(f.client.close()).toBe(closing);
    expect(f.client.processState()).toMatchObject({
      state: 'exited',
      stdioClosed: true,
    });
  });
  it('does not resolve physical exit while its original durable receipt is pending', async () => {
    const held = deferred();
    const f = fixture({
      observe: (details) =>
        details.kind === 'process_closed' ? held.promise : Promise.resolve(),
    });
    const exited = once(f.child, 'close');
    let complete = false;
    const closing = f.client.close().then(() => {
      complete = true;
    });
    await exited;
    expect(f.client.processState()).toMatchObject({
      state: 'exited',
      stdioClosed: true,
    });
    expect(complete).toBe(false);
    held.resolve();
    await closing;
    expect(complete).toBe(true);
  });
});
