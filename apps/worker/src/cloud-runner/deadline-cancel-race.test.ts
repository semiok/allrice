import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { CloudCommandSchema, cloudToolchainImageV1 } from '@allrice/contracts';
import { CloudRunnerBackend, type CloudRunResult } from './backend.js';

it.each([true, false])(
  'physical monitor preserves %s deadline fact when the preparation signal also aborts',
  async (expired) => {
    let now = 100000,
      running = true,
      stops = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const controller = new AbortController();
    const command = CloudCommandSchema.parse({
      capability: 'cloud.process.execute',
      backend: 'cloud-gvisor-v1',
      runtime: 'runsc',
      imageDigest: cloudToolchainImageV1,
      network: 'none',
      arguments: { script: 'void 0' },
    });
    class Observed extends CloudRunnerBackend {
      override async json<T>() {
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
            ExitCode: expired ? 124 : 137,
            OOMKilled: false,
          },
        };
      }
      override async stop() {
        stops++;
        running = false;
        return true;
      }
      override async collect(
        _attempt: string,
        _command: unknown,
        _started: number,
        reason: CloudRunResult['reason'] = 'completed',
      ): Promise<CloudRunResult> {
        return {
          containerId: 'a'.repeat(64),
          stopped: true,
          exitCode: expired ? 124 : 137,
          reason,
          artifacts: [],
          output: '',
          elapsedMs: now - 100000,
        };
      }
    }
    try {
      const backend = new Observed();
      // Exercise the actual post-create monitor, with only the daemon boundary
      // substituted. Both deadline and signal become observable in the same tick.
      const monitor = Reflect.get(backend, 'executeAdmittedPlan').bind(
        backend,
      ) as (...args: unknown[]) => Promise<CloudRunResult>;
      const result = await monitor(
        { command, config: {} },
        {
          attemptId: randomUUID(),
          deadlineAt: new Date(101000).toISOString(),
          signal: controller.signal,
          maintainLease: async () => true,
          observe: async () => {
            now = expired ? 101000 : 100999;
            controller.abort(
              expired ? new DOMException('budget', 'TimeoutError') : undefined,
            );
          },
        },
        100000,
        101000,
      );
      expect(result.reason).toBe(expired ? 'deadline' : 'canceled');
      expect(stops).toBe(1);
      expect(result.stopped).toBe(true);
    } finally {
      clock.mockRestore();
    }
  },
);
