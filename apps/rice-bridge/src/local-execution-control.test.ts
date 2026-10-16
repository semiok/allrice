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
  await f.control.finish();
});
it('stops a live revoked attempt without another control grant', async () => {
  const f = fixture();
  f.maintainLease.mockResolvedValue(false);
  await f.control.start();
  expect(f.stop).toHaveBeenCalledWith('lease_lost');
  expect(f.socket.send).not.toHaveBeenCalled();
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
  await vi.advanceTimersByTimeAsync(3100);
  await start;
  expect(f.stop).toHaveBeenCalledWith('lease_lost');
  resolve(true);
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.socket.send).not.toHaveBeenCalled();
  await f.control.finish();
});
it('rejects missing live CPU evidence instead of renewing from heartbeats alone', async () => {
  const f = fixture();
  vi.setSystemTime(1045000);
  f.state.cpu = undefined;
  await f.control.start();
  expect(f.exchange).not.toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledWith('lease_lost');
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
