import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { expect, it } from 'vitest';
import { CloudCommandSchema, cloudPythonImageV1 } from '@allrice/contracts';
import { CloudRunnerBackend } from './backend.js';

it.each(['INPUT_VERSION_CHANGED', 'CLOUD_INPUT_STORAGE_FULL'])(
  'settles %s after physical stop without releasing the tenant start message',
  async (code) => {
    const id = 'a'.repeat(64),
      attempt = randomUUID();
    let running = false,
      sent = 0;
    class Backend extends CloudRunnerBackend {
      override async json<T>() {
        return { Id: id } as T;
      }
      override async call(method: string, path: string) {
        if (method === 'POST' && path.endsWith('/start')) running = true;
        if (method === 'POST' && path.includes('/kill')) running = false;
        return Buffer.alloc(0);
      }
      override async inspect() {
        return {
          Id: id,
          Config: { Labels: {}, Image: cloudPythonImageV1 },
          HostConfig: { Runtime: 'runsc' },
          State: {
            Running: running,
            Status: running ? 'running' : 'exited',
            ExitCode: 137,
            OOMKilled: false,
          },
        };
      }
    }
    const backend = new Backend();
    Reflect.set(
      backend,
      'attachInput',
      async () =>
        new Duplex({
          read() {},
          write(_chunk, _encoding, cb) {
            sent++;
            cb();
          },
        }),
    );
    const command = CloudCommandSchema.parse({
      capability: 'cloud.process.execute',
      arguments: { language: 'python', script: 'print(1)' },
      backend: 'cloud-gvisor-v1',
      runtime: 'runsc',
      network: 'none',
      imageDigest: cloudPythonImageV1,
    });
    const execute = Reflect.get(backend, 'executeAdmittedPlan').bind(backend);
    const result = await execute(
      {
        command,
        encoded: 'start\n',
        config: { Labels: { 'xyz.bplabs.allrice.cloud.input': 'stream-v1' } },
        afterStart: async () => {
          throw Error(code);
        },
      },
      {
        attemptId: attempt,
        deadlineAt: new Date(Date.now() + 5000).toISOString(),
        maintainLease: async () => true,
      },
      Date.now(),
      Date.now() + 5000,
    );
    expect(sent).toBe(0);
    expect(result).toMatchObject({
      reason: 'failed',
      stopped: true,
      errorCode: code,
      artifacts: [],
    });
    expect(running).toBe(false);
  },
);
