import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({
  start: vi.fn(),
  heartbeat: vi.fn(),
  append: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  finish: vi.fn(),
  isolation: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock('@allrice/database', () => ({
  QueueError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  startClaimedJob: ports.start,
  heartbeatJob: ports.heartbeat,
  appendJobEvent: ports.append,
  completeJob: ports.complete,
  failJob: ports.fail,
  finishJobDrain: ports.finish,
}));
vi.mock('./isolation.js', () => ({
  prepareExecutionIsolation: ports.isolation,
}));
vi.mock('./workflow-engine.js', () => ({
  WorkflowPaused: class extends Error {},
}));
import { runClaimedJob, type ClaimedJobRunnerInput } from './job-runner.js';

/** Worker orchestration seam only. Real lease/receipt authorization is tested
 * separately against isolated PostgreSQL and an actual native DSH process. */
describe('Worker canceled-handler receipt finalization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    ports.start.mockResolvedValue({
      context: {
        organizationId: 'org',
        workspaceId: 'workspace',
        runId: 'run',
      },
      job: { id: 'job', ownerId: 'owner', attempt: 1 },
      payload: { type: 'synthetic' },
    });
    ports.isolation.mockResolvedValue({ cleanup: ports.cleanup });
    ports.heartbeat.mockResolvedValue({
      active: false,
      canceled: true,
      draining: true,
    });
    for (const p of [
      ports.append,
      ports.complete,
      ports.fail,
      ports.finish,
      ports.cleanup,
    ])
      p.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());
  function input(stopping = () => false) {
    let abort = () => {};
    const value: ClaimedJobRunnerInput = {
      workerId: 'worker',
      jobId: 'job',
      leaseToken: 'lease',
      leaseMs: 30000,
      heartbeatMs: 10,
      executionRoot: '/synthetic',
      stopping,
      onAbortReady: (value) => {
        abort = value;
      },
    };
    return { value, abort: () => abort() };
  }
  it('finishes a canceled Job only after its handler has returned and isolation is cleaned', async () => {
    const f = input();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = runClaimedJob(f.value, async ({ signal }) => {
      started();
      return new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve('late return'), {
          once: true,
        }),
      );
    });
    await ready;
    await vi.advanceTimersByTimeAsync(10);
    await run;
    expect(ports.complete).not.toHaveBeenCalled();
    expect(ports.fail).not.toHaveBeenCalled();
    expect(ports.cleanup).toHaveBeenCalledTimes(1);
    expect(ports.finish).toHaveBeenCalledTimes(1);
    expect(ports.cleanup.mock.invocationCallOrder[0]).toBeLessThan(
      ports.finish.mock.invocationCallOrder[0]!,
    );
  });
  it('joins the original in-flight heartbeat before cleanup and prevents overlapping heartbeats', async () => {
    let release!: (value: unknown) => void;
    ports.heartbeat.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const f = input();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = runClaimedJob(f.value, async ({ signal }) => {
      started();
      return new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve('late'), { once: true }),
      );
    });
    await ready;
    await vi.advanceTimersByTimeAsync(40);
    expect(ports.heartbeat).toHaveBeenCalledTimes(1);
    f.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(ports.cleanup).not.toHaveBeenCalled();
    expect(ports.finish).not.toHaveBeenCalled();
    release({ active: false, canceled: true });
    await run;
    expect(ports.finish).toHaveBeenCalledTimes(1);
  });
  it('retains existing lease-recovery semantics on a global Worker shutdown', async () => {
    let stopping = false;
    const f = input(() => stopping);
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = runClaimedJob(f.value, async ({ signal }) => {
      started();
      return new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve('stopping'), {
          once: true,
        }),
      );
    });
    await ready;
    stopping = true;
    f.abort();
    await run;
    expect(ports.cleanup).toHaveBeenCalledOnce();
    expect(ports.finish).not.toHaveBeenCalled();
    expect(ports.complete).not.toHaveBeenCalled();
  });
  it('a stuck heartbeat cannot prevent local cleanup or authorize concurrent finalization', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let release!: (value: unknown) => void;
    ports.heartbeat.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const f = input();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = runClaimedJob(f.value, async ({ signal }) => {
      started();
      return new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve('stopped'), {
          once: true,
        }),
      );
    });
    await ready;
    await vi.advanceTimersByTimeAsync(10);
    f.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    await run;
    expect(ports.cleanup).toHaveBeenCalledOnce();
    expect(ports.finish).not.toHaveBeenCalled();
    release({ active: false, canceled: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(ports.finish).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
