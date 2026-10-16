import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  CloudCommandSchema,
  cloudToolchainImageV1,
  sandboxExecutionBudgetSpec,
  startSandboxExecutionBudget,
} from '@allrice/contracts';
import type * as ProjectRuntime from '@allrice/project-runtime';
import { CloudRunnerBackend, type CloudRunResult } from './backend.js';

const boundary = vi.hoisted(() => ({
  renew: vi.fn(async () => {}),
  close: vi.fn(),
  relayLost: undefined as (() => void) | undefined,
}));
vi.mock('./project-service-guard.js', () => ({
  openCloudSandboxExecutionGuard: async () => boundary,
  openCloudProjectServiceGuard: async () => boundary,
}));
vi.mock('@allrice/project-runtime', async (original) => ({
  ...(await original<typeof ProjectRuntime>()),
  openSandboxNetwork: async (
    _api: unknown,
    input: Parameters<typeof ProjectRuntime.openSandboxNetwork>[1],
  ) => {
    boundary.relayLost = () => input.onClosed?.('SANDBOX_NETWORK_REVOKED');
    return {
      close: vi.fn(),
      observation: { sentBytes: 0, receivedBytes: 0, openedConnections: 0 },
    };
  },
}));
afterEach(() => {
  vi.clearAllMocks();
  boundary.relayLost = undefined;
});

function fixture(stats?: 'exited' | 'live') {
  const started = Date.now();
  const spec = sandboxExecutionBudgetSpec(
    { version: 1, kind: 'compute' },
    { version: 1, maxExecutionMs: 600000, sources: [] },
  );
  const initial = startSandboxExecutionBudget(spec, started, started + 600000);
  let running = true;
  const stops = vi.fn(async () => {
    running = false;
    return true;
  });
  class Daemon extends CloudRunnerBackend {
    override async json<T>(_method: string, path: string) {
      if (path.includes('/stats?')) {
        if (stats === 'exited') running = false;
        return {} as T;
      }
      return { Id: 'a'.repeat(64) } as T;
    }
    override async call() {
      return Buffer.alloc(0);
    }
    override async inspect() {
      return {
        Id: 'a'.repeat(64),
        Config: { Labels: {} },
        HostConfig: { Runtime: 'runsc' },
        State: {
          Running: running,
          Status: running ? 'running' : 'exited',
          ExitCode: 137,
          OOMKilled: false,
        },
      };
    }
    override stop = stops;
    override async collect(
      _attempt: string,
      _command: unknown,
      _started: number,
      reason: CloudRunResult['reason'] = 'completed',
    ): Promise<CloudRunResult> {
      return {
        containerId: 'a'.repeat(64),
        stopped: !running,
        exitCode: stops.mock.calls.length ? 137 : 0,
        reason,
        artifacts: [],
        output: '',
        elapsedMs: Date.now() - started,
      };
    }
  }
  const backend = new Daemon();
  const monitor = Reflect.get(backend, 'executeAdmittedPlan').bind(backend) as (
    ...args: unknown[]
  ) => Promise<CloudRunResult>;
  const plan = {
    command: CloudCommandSchema.parse({
      capability: 'cloud.process.execute',
      backend: 'cloud-gvisor-v1',
      runtime: 'runsc',
      imageDigest: cloudToolchainImageV1,
      network: 'none',
      arguments: { script: 'void 0' },
    }),
    config: {},
    executionBudget: initial,
  };
  const options = {
    attemptId: randomUUID(),
    deadlineAt: new Date(initial.hardDeadlineAt).toISOString(),
    maintainLease: vi.fn(async () => true),
    sandboxExecution: { spec, exchange: vi.fn(async () => initial) },
    observe: vi.fn(),
  };
  return {
    plan,
    options,
    stops,
    finish: () => (running = false),
    started,
    run: (changedPlan = plan, changedOptions = options) =>
      monitor(changedPlan, changedOptions, started, initial.hardDeadlineAt),
  };
}

it('cancels in-flight staging on relay loss before releasing tenant input', async () => {
  const f = fixture();
  let released = false;
  const result = await f.run(
    {
      ...f.plan,
      afterStart: async (_id: string, signal: AbortSignal) => {
        const lost = new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        boundary.relayLost!();
        await lost;
        signal.throwIfAborted();
        released = true;
      },
    } as typeof f.plan,
    { ...f.options, networkLease: {} } as typeof f.options,
  );
  expect(released).toBe(false);
  expect(f.options.observe).not.toHaveBeenCalled();
  expect(f.stops).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    reason: 'canceled',
    stopped: true,
    errorCode: 'SANDBOX_NETWORK_REVOKED',
  });
});

it('stops staging when an authority check stalls, without waiting for tenant startup', async () => {
  const f = fixture();
  let staged = false;
  f.options.maintainLease.mockImplementation(() =>
    staged ? new Promise<boolean>(() => {}) : Promise.resolve(true),
  );
  const result = await f.run({
    ...f.plan,
    afterStart: async (_id: string, signal: AbortSignal) => {
      staged = true;
      await delay(10000, undefined, { signal });
      throw Error('tenant input must not be released');
    },
  } as typeof f.plan);
  expect(result).toMatchObject({
    reason: 'failed',
    stopped: true,
    errorCode: 'SANDBOX_EXECUTION_AUTHORITY_UNCONFIRMED',
  });
  expect(f.stops).toHaveBeenCalledTimes(1);
  expect(f.options.observe).not.toHaveBeenCalled();
  expect(result.elapsedMs).toBeLessThan(5000);
});

it('uses the physical controller heartbeat instead of heartbeating on each exit poll', async () => {
  const f = fixture();
  const completion = setTimeout(f.finish, 1400);
  try {
    const result = await f.run();
    expect(result.reason).toBe('completed');
    expect(f.stops).not.toHaveBeenCalled();
    expect(boundary.renew.mock.calls.length).toBeGreaterThanOrEqual(4);
    // Two start checks, then the initial and periodic physical heartbeats.
    expect(f.options.maintainLease.mock.calls.length).toBeLessThanOrEqual(5);
  } finally {
    clearTimeout(completion);
  }
});

it('still stops promptly on a later revoked authority, with no cached approval', async () => {
  const f = fixture();
  f.options.observe.mockImplementation(() =>
    f.options.maintainLease.mockResolvedValue(false),
  );
  const result = await f.run();
  expect(result).toMatchObject({
    reason: 'canceled',
    stopped: true,
    errorCode: 'SANDBOX_EXECUTION_REVOKED',
  });
  expect(f.stops).toHaveBeenCalledTimes(1);
  expect(result.elapsedMs).toBeLessThan(3000);
});

it.each(['exited', 'live'] as const)(
  'reconciles empty Docker statistics against the original %s process',
  async (state) => {
    const f = fixture(state);
    const clock = vi.spyOn(Date, 'now');
    f.options.observe.mockImplementation(() =>
      clock.mockReturnValue(f.started + 45001),
    );
    try {
      const result = await f.run();
      expect(f.options.sandboxExecution.exchange).not.toHaveBeenCalled();
      if (state === 'exited') {
        expect(result).toMatchObject({ reason: 'completed', exitCode: 0 });
        expect(result.errorCode).toBeUndefined();
        expect(f.stops).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({
          reason: 'failed',
          errorCode: 'SANDBOX_EXECUTION_PROGRESS_UNCONFIRMED',
          stopped: true,
        });
        expect(f.stops).toHaveBeenCalledTimes(1);
      }
    } finally {
      clock.mockRestore();
    }
  },
);
