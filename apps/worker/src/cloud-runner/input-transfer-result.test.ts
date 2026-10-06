import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CloudCommandSchema, cloudToolchainImageV1 } from '@allrice/contracts';
import { CloudRunnerBackend } from './backend.js';

describe('stopped receiver is reconciled through physical results', () => {
  for (const scenario of ['success', 'failed', 'missing'] as const)
    it(scenario + ' never resends a stalled input', async () => {
      const id = randomUUID(),
        containerId = 'a'.repeat(64);
      const stream = new Duplex({ read() {}, write() {} });
      const bytes = Buffer.from('actual receiver output');
      const data = Buffer.from(
        JSON.stringify({
          type: 'artifact',
          path: 'result.json',
          data: bytes.toString('base64'),
        }) + '\n',
      );
      const header = Buffer.alloc(8);
      header[0] = 1;
      header.writeUInt32BE(data.length, 4);
      let starts = 0,
        creates = 0;
      class Receiver extends CloudRunnerBackend {
        override async json<T>() {
          creates++;
          return { Id: containerId } as T;
        }
        override async call(method: string) {
          if (method === 'POST') {
            starts++;
            return Buffer.alloc(0);
          }
          return Buffer.concat([header, data]);
        }
        override async inspect() {
          if (scenario === 'missing') return null;
          return {
            Id: containerId,
            Config: { Labels: {} },
            HostConfig: { Runtime: 'runsc' },
            State: {
              Running: false,
              Status: 'exited',
              ExitCode: scenario === 'success' ? 0 : 1,
              OOMKilled: false,
            },
          } as unknown as NonNullable<
            Awaited<ReturnType<CloudRunnerBackend['inspect']>>
          >;
        }
      }
      const backend = new Receiver();
      Reflect.set(backend, 'attachInput', async () => stream);
      const command = CloudCommandSchema.parse({
        capability: 'cloud.process.execute',
        arguments: {
          script: 'trusted fixture',
          outputs: [
            { path: 'result.json', fileName: 'result.json', format: 'json' },
          ],
        },
        backend: 'cloud-gvisor-v1',
        imageDigest: cloudToolchainImageV1,
        runtime: 'runsc',
        network: 'none',
      });
      const execute = Reflect.get(backend, 'executeAdmittedPlan').bind(backend);
      const task = execute(
        { command, encoded: 'frozen input\n', config: {} },
        {
          attemptId: id,
          deadlineAt: new Date(Date.now() + 5000).toISOString(),
          maintainLease: async () => true,
        },
        Date.now(),
        Date.now() + 5000,
      );
      if (scenario === 'missing')
        await expect(task).rejects.toThrow('CLOUD_RESULT_UNKNOWN');
      else {
        const result = await task;
        expect(result.reason).toBe(
          scenario === 'success' ? 'completed' : 'failed',
        );
        expect(result.artifacts).toHaveLength(scenario === 'success' ? 1 : 0);
      }
      expect(starts).toBe(1);
      expect(creates).toBe(1);
      expect(stream.destroyed).toBe(true);
    });
});
