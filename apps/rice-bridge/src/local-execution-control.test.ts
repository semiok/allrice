import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  resolveSandboxExecutionPolicy,
  sandboxExecutionBudgetSpec,
  startSandboxExecutionBudget,
  renewSandboxExecutionBudget,
} from '@allrice/contracts';
import { SandboxExecutionBudgetController } from '@allrice/project-runtime';
import { LocalExecutionControl } from './local-execution-control.js';
import { LocalServiceControl } from './local-service-control.js';
import type { LocalDockerApi } from './local-docker-api.js';
import { BridgeControlError, controlFailure } from './control-request.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function fixture(preparationReadBytes = 0) {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
  const spec = sandboxExecutionBudgetSpec(
    { version: 1, kind: 'compute' },
    resolveSandboxExecutionPolicy([]),
  );
  const initial = startSandboxExecutionBudget(
    spec,
    Date.now(),
    Date.now() + 600000,
  );
  let authority = initial;
  const exchange = vi.fn(
    async (request) =>
      (authority = renewSandboxExecutionBudget(
        authority,
        request,
        Date.now(),
        initial.hardDeadlineAt,
      )),
  );
  const budget = new SandboxExecutionBudgetController(initial, spec, exchange);
  const attemptId = randomUUID(),
    containerId = 'a'.repeat(64);
  const state = { running: true, cpu: 2000000 as number | undefined };
  const api = {
    socketPath: '/test/docker.sock',
    json: vi.fn(async (_method: string, path: string) =>
      path.includes('/stats?')
        ? { cpu_stats: { cpu_usage: { total_usage: state.cpu } } }
        : {
            Id: containerId,
            Config: { Labels: { 'xyz.bplabs.allrice.attempt': attemptId } },
            State: {
              Running: state.running,
              Status: state.running ? 'running' : 'exited',
            },
          },
    ),
  } as unknown as LocalDockerApi;
  const socket = { send: vi.fn(async () => {}), close: vi.fn() };
  vi.spyOn(LocalServiceControl, 'connect').mockResolvedValue(
    socket as unknown as LocalServiceControl,
  );
  const maintainLease = vi.fn(async () => true),
    stop = vi.fn(async () => {});
  const control = new LocalExecutionControl({
    api,
    containerId,
    attemptId,
    budget,
    preparationReadBytes,
    maintainLease,
    stop,
  });
  return { state, api, socket, budget, exchange, maintainLease, stop, control };
}
it('uses distinct physical leases while keeping one authority execution clock', async () => {
  const f = fixture();
  await f.control.start();
  await vi.advanceTimersByTimeAsync(46000);
  expect(f.exchange).toHaveBeenCalledTimes(1);
  expect(f.budget.state.startedAt).toBe(1000000);
  expect(f.budget.state.hardDeadlineAt).toBe(1600000);
  expect(f.budget.state.deadlineAt).toBe(1120000);
  expect(f.socket.send.mock.calls.length).toBeGreaterThan(40);
  expect(f.stop).not.toHaveBeenCalled();
  await f.control.finish();
});
it('keeps preparation I/O in the cumulative counters when container renewal takes over', async () => {
  const f = fixture(4096);
  vi.setSystemTime(1045000);
  await f.budget.renew(async () => ({
    cpuNanos: 0,
    readBytes: 4096,
    writtenBytes: 0,
  }));
  vi.setSystemTime(1105000);
  await f.control.start();
  expect(f.exchange).toHaveBeenCalledTimes(2);
  expect(f.budget.state.progress.readBytes).toBe(4096);
  expect(f.budget.state.progress.cpuNanos).toBe(2000000);
  expect(f.budget.state.startedAt).toBe(1000000);
  expect(f.stop).not.toHaveBeenCalled();
  await f.control.finish();
});
it('does not replace a terminal result with a late authority failure', async () => {
  const f = fixture();
  f.maintainLease.mockImplementation(async () => {
    f.state.running = false;
    throw Error('late denial');
  });
  await f.control.start();
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.socket.send).not.toHaveBeenCalled();
  expect(f.socket.close).toHaveBeenCalled();
  expect(f.control.failure).toBeUndefined();
  await f.control.finish();
});
it('stops a live revoked attempt without another control grant', async () => {
  const f = fixture();
  f.maintainLease.mockResolvedValue(false);
  await f.control.start();
  expect(f.stop).toHaveBeenCalledWith('lease_lost');
  expect(f.socket.send).not.toHaveBeenCalled();
  expect(f.control.failure).toMatchObject({
    stage: 'heartbeat',
    kind: 'revoked',
  });
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.stop).toHaveBeenCalledTimes(1);
  await f.control.finish();
});
it('bounds stalled authority and ignores a delayed successful acknowledgement', async () => {
  const f = fixture();
  let resolve!: (v: boolean) => void;
  f.maintainLease.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const start = f.control.start();
  await vi.advanceTimersByTimeAsync(11100);
  await start;
  expect(f.stop).toHaveBeenCalledWith('lease_lost');
  resolve(true);
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.socket.send).not.toHaveBeenCalled();
  expect(f.control.failure).toMatchObject({ stage: 'cycle', kind: 'timeout' });
  await f.control.finish();
});
it('rejects missing live CPU evidence instead of renewing from heartbeats alone', async () => {
  const f = fixture();
  vi.setSystemTime(1045000);
  f.state.cpu = undefined;
  await f.control.start();
  expect(f.exchange).not.toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledWith('lease_lost');
  expect(f.control.failure).toMatchObject({
    stage: 'metrics',
    kind: 'metrics_invalid',
  });
  await f.control.finish();
});

it('retains the original transport phase and attempt count through a control cycle', async () => {
  const f = fixture();
  const cause = Object.assign(Error('private details'), { code: 'ECONNRESET' });
  const failure = controlFailure(cause, 'heartbeat', 71, 2);
  f.maintainLease.mockRejectedValue(new BridgeControlError(failure));
  await f.control.start();
  expect(f.control.failure).toEqual(failure);
  expect(f.stop).toHaveBeenCalledExactlyOnceWith('lease_lost');
  expect(f.socket.send).not.toHaveBeenCalled();
  await f.control.finish();
});

it.each(['container_inspect', 'control_write'] as const)(
  'identifies a %s failure without confusing it with HTTP renewal',
  async (stage) => {
    const f = fixture();
    if (stage === 'container_inspect')
      vi.mocked(f.api.json).mockRejectedValue(Error('DAEMON_TIMEOUT'));
    else
      f.socket.send.mockRejectedValue(
        Object.assign(Error('private socket path'), { code: 'EPIPE' }),
      );
    await f.control.start();
    expect(f.control.failure).toMatchObject({
      stage,
      kind: stage === 'container_inspect' ? 'timeout' : 'transport',
    });
    expect(f.stop).toHaveBeenCalledExactlyOnceWith('lease_lost');
    await f.control.finish();
  },
);

it('records an invalid renewed budget separately from a real exhausted deadline', async () => {
  const f = fixture();
  vi.setSystemTime(1045000);
  f.exchange.mockResolvedValue({} as never);
  await f.control.start();
  expect(f.control.failure).toMatchObject({
    stage: 'budget',
    kind: 'invalid_response',
  });
  expect(f.stop).toHaveBeenCalledExactlyOnceWith('lease_lost');
  await f.control.finish();
});

it('keeps an exhausted execution budget a timeout, without another renewal', async () => {
  const f = fixture();
  vi.setSystemTime(1060000);
  await f.control.start();
  expect(f.control.failure).toMatchObject({
    stage: 'budget',
    kind: 'deadline',
  });
  expect(f.exchange).not.toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledExactlyOnceWith('timeout');
  expect(f.socket.send).not.toHaveBeenCalled();
  await f.control.finish();
});

it('records a private control connection failure before any grant is sent', async () => {
  const f = fixture();
  vi.mocked(LocalServiceControl.connect).mockRejectedValue(
    Object.assign(Error('private socket'), { code: 'ECONNREFUSED' }),
  );
  await expect(f.control.start()).rejects.toBeInstanceOf(BridgeControlError);
  expect(f.control.failure).toMatchObject({
    stage: 'control_connect',
    kind: 'transport',
  });
  expect(f.socket.send).not.toHaveBeenCalled();
  await f.control.finish();
});
it('does not fetch metrics or renew an already exited container', async () => {
  const f = fixture();
  vi.setSystemTime(1045000);
  f.state.running = false;
  await f.control.start();
  expect(f.exchange).not.toHaveBeenCalled();
  expect(f.socket.send).not.toHaveBeenCalled();
  expect(f.stop).not.toHaveBeenCalled();
  await f.control.finish();
});

it('accepts slow healthy renewal and heartbeat without overlapping cycles', async () => {
  const f = fixture();
  vi.setSystemTime(1045000);
  f.maintainLease.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 6500));
    return true;
  });
  const exchange = f.exchange.getMockImplementation()!;
  f.exchange.mockImplementation(async (request) => {
    await new Promise((r) => setTimeout(r, 6500));
    return exchange(request);
  });
  const start = f.control.start();
  await vi.advanceTimersByTimeAsync(6600);
  await start;
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.exchange).toHaveBeenCalledTimes(1);
  expect(f.maintainLease).toHaveBeenCalledTimes(1);
  expect(f.budget.state.sequence).toBe(1);
  expect(f.budget.state.hardDeadlineAt).toBe(1600000);
  expect(f.socket.send).toHaveBeenLastCalledWith(
    expect.objectContaining({ deadlineAt: 1120000, leaseDeadlineAt: 1071500 }),
  );
  await f.control.finish();
});
it('never extends the physical lease past the last granted execution deadline', async () => {
  const f = fixture();
  vi.setSystemTime(1044000);
  await f.control.start();
  expect(f.socket.send).toHaveBeenLastCalledWith(
    expect.objectContaining({ deadlineAt: 1060000, leaseDeadlineAt: 1060000 }),
  );
  await f.control.finish();
});
it('does not write a late control grant after close while admission is pending', async () => {
  const f = fixture();
  let resolve!: (v: boolean) => void;
  f.maintainLease.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const start = f.control.start();
  await vi.advanceTimersByTimeAsync(4000);
  f.control.close();
  resolve(true);
  await start;
  expect(f.socket.send).not.toHaveBeenCalled();
  expect(f.stop).not.toHaveBeenCalled();
  await f.control.finish();
});

it('does not wait for a slow budget reply after known revocation', async () => {
  const f = fixture();
  vi.setSystemTime(1045000);
  f.exchange.mockImplementation(() => new Promise(() => {}));
  f.maintainLease.mockResolvedValue(false);
  const start = f.control.start();
  await vi.advanceTimersByTimeAsync(1);
  await start;
  expect(f.stop).toHaveBeenCalledExactlyOnceWith('lease_lost');
  expect(f.socket.send).not.toHaveBeenCalled();
  await f.control.finish();
});
