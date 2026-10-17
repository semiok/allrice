import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { CloudCommandSchema, cloudToolchainImageV1 } from '@allrice/contracts';
import {
  CloudRunnerBackend,
  CloudRunnerError,
  type CloudRunResult,
} from './backend.js';

afterEach(() => vi.restoreAllMocks());

const command = CloudCommandSchema.parse({
  capability: 'cloud.process.execute',
  backend: 'cloud-gvisor-v1',
  runtime: 'runsc',
  imageDigest: cloudToolchainImageV1,
  network: 'none',
  arguments: { script: 'void 0' },
});

function fixture(
  point: 'created' | 'started',
  cause: 'deadline' | 'canceled' | 'daemon' | 'none',
  physical: 'same' | 'missing' | 'replacement' | 'running' | 'created' = 'same',
) {
  let now = 100000,
    running = false;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const controller = new AbortController();
  const interrupt = () => {
    if (cause === 'none') return;
    if (cause === 'daemon') throw Error('CLOUD_DAEMON_TIMEOUT');
    now = cause === 'deadline' ? 101001 : 100500;
    controller.abort(
      cause === 'deadline'
        ? new DOMException('deadline', 'TimeoutError')
        : undefined,
    );
  };
  class Daemon extends CloudRunnerBackend {
    override async json<T>() {
      return { Id: 'a'.repeat(64) } as T;
    }
    override async call() {
      running = true;
      interrupt();
      return Buffer.alloc(0);
    }
    override async inspect() {
      if (physical === 'missing') return null;
      return {
        Id: (physical === 'replacement' ? 'b' : 'a').repeat(64),
        Config: { Labels: {} },
        HostConfig: { Runtime: 'runsc' },
        State: {
          Running: running,
          Status:
            physical === 'created' ? 'created' : running ? 'running' : 'exited',
          ExitCode: 137,
          OOMKilled: false,
        },
      };
    }
    override async stop() {
      if (physical === 'running') return false;
      running = false;
      return true;
    }
    override async collect(
      _attempt: string,
      _command: unknown,
      startedAt: number,
      reason: CloudRunResult['reason'] = 'completed',
    ): Promise<CloudRunResult> {
      return {
        containerId: 'a'.repeat(64),
        stopped: !running,
        exitCode: 137,
        reason,
        artifacts: [],
        output: '',
        elapsedMs: now - startedAt,
      };
    }
  }
  const backend = new Daemon();
  const monitor = Reflect.get(backend, 'executeAdmittedPlan').bind(backend);
  const stage = vi.fn();
  const run = () =>
    monitor(
      { command, config: {}, afterStart: stage },
      {
        attemptId: randomUUID(),
        signal: controller.signal,
        deadlineAt: new Date(101000).toISOString(),
        maintainLease: async () => true,
        onCreated: async () => {
          if (point === 'created') interrupt();
        },
      },
      100000,
      101000,
    ) as Promise<CloudRunResult>;
  return { run, stage, backend };
}

it.each(['started'] as const)(
  'keeps a confirmed deadline after the %s acknowledgement as a failed execution',
  async (point) => {
    const f = fixture(point, 'deadline');
    expect(await f.run()).toMatchObject({
      reason: 'deadline',
      stopped: true,
      elapsedMs: 1001,
    });
    expect(f.stage).not.toHaveBeenCalled();
  },
);
it.each(['started'] as const)(
  'keeps explicit cancellation after the %s acknowledgement separate from timeout',
  async (point) => {
    const f = fixture(point, 'canceled');
    expect(await f.run()).toMatchObject({
      reason: 'canceled',
      stopped: true,
      elapsedMs: 500,
    });
    expect(f.stage).not.toHaveBeenCalled();
  },
);
it.each(['missing', 'replacement', 'running'] as const)(
  'does not fabricate a deadline receipt for a %s container',
  async (physical) => {
    const f = fixture('started', 'deadline', physical);
    await expect(f.run()).rejects.toThrow('CLOUD_RESULT_UNKNOWN');
    expect(f.stage).not.toHaveBeenCalled();
  },
);
it('preserves an uncertain start acknowledgement without a known interruption', async () => {
  const f = fixture('started', 'daemon');
  await expect(f.run()).rejects.toThrow('CLOUD_DAEMON_TIMEOUT');
  expect(f.stage).not.toHaveBeenCalled();
});

it('keeps a created attempt uncertain without a physically exited receipt', async () => {
  const f = fixture('created', 'deadline', 'created');
  await expect(f.run()).rejects.toThrow('CLOUD_EXECUTION_REVOKED');
  expect(f.stage).not.toHaveBeenCalled();
});

it.each([true, false])(
  'only recognizes trusted staging revocation, typed=%s',
  async (typed) => {
    const f = fixture('started', 'none');
    const stop = vi.spyOn(f.backend, 'stop');
    f.stage.mockImplementation(() => {
      throw typed
        ? new CloudRunnerError('CLOUD_EXECUTION_REVOKED')
        : Error('CLOUD_EXECUTION_REVOKED');
    });
    if (typed) {
      expect(await f.run()).toMatchObject({
        reason: 'canceled',
        stopped: true,
        errorCode: 'CLOUD_EXECUTION_REVOKED',
      });
      expect(stop).toHaveBeenCalledTimes(1);
    } else await expect(f.run()).rejects.toThrow('CLOUD_EXECUTION_REVOKED');
  },
);
