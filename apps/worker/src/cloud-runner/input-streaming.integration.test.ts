import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CloudCommandSchema,
  cloudPythonImageV1,
  type RuntimeInputSource,
} from '@allrice/contracts';
import { CloudRunnerBackend } from './backend.js';
const suite =
  process.env.ALLRICE_RUN_PYTHON_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
function source(path: string, sizeBytes: number): RuntimeInputSource {
  const chunk = Buffer.alloc(65536, 120),
    hash = createHash('sha256');
  for (let n = 0; n < sizeBytes; n += chunk.length)
    hash.update(chunk.subarray(0, Math.min(chunk.length, sizeBytes - n)));
  return {
    path,
    sizeBytes,
    checksum: `sha256:${hash.digest('hex')}`,
    async open(signal) {
      let n = 0;
      return new ReadableStream({
        pull(c) {
          signal.throwIfAborted();
          if (n === sizeBytes) {
            c.close();
            return;
          }
          const bytes = chunk.subarray(
            0,
            Math.min(chunk.length, sizeBytes - n),
          );
          n += bytes.length;
          c.enqueue(bytes);
        },
      });
    },
  };
}
suite('actual gVisor streamed inputs and task-owned disk volume', () => {
  const backend = new CloudRunnerBackend();
  const attempts: string[] = [];
  afterEach(async () => {
    for (const id of attempts.splice(0)) {
      await backend.stop(id);
      const container = await backend.inspect(id);
      const volumes = (container?.Mounts ?? [])
        .filter((m) => m.Destination === '/allrice-input')
        .map((m) => m.Name);
      await backend.cleanup(id);
      expect(await backend.inspect(id)).toBeNull();
      for (const name of volumes) {
        expect(name).toMatch(/^[a-f0-9]{64}$/);
        await expect(backend.json('GET', `/volumes/${name}`)).rejects.toThrow(
          'CLOUD_DAEMON_404',
        );
      }
    }
  });
  async function run(files: RuntimeInputSource[], signal?: AbortSignal) {
    const attemptId = randomUUID();
    attempts.push(attemptId);
    return backend.execute(
      CloudCommandSchema.parse({
        capability: 'cloud.process.execute',
        arguments: {
          language: 'python',
          script:
            "import pathlib,hashlib,json,os\np=pathlib.Path('input');files=sorted(f for f in p.rglob('*') if f.is_file());print(json.dumps({'sizes':[f.stat().st_size for f in files],'sha256':[hashlib.file_digest(f.open('rb'),'sha256').hexdigest() for f in files],'uid':os.getuid(),'host':os.path.exists('/Users/a123')}))",
          inputs: files.map((f) => ({
            path: f.path,
            objectId: randomUUID(),
            checksum: f.checksum,
          })),
        },
        backend: 'cloud-gvisor-v1',
        imageDigest: cloudPythonImageV1,
        runtime: 'runsc',
        network: 'none',
      }),
      files,
      {
        attemptId,
        deadlineAt: new Date(Date.now() + 60000).toISOString(),
        maintainLease: async () => true,
        signal,
      },
    );
  }
  it(
    'reads the two original file sizes, nested CJK paths and exact hashes',
    { tags: ['manual:ALLRICE_RUN_PYTHON_INTEGRATION'], timeout: 70000 },
    async () => {
      const files = [
        source('资料/一.csv', 1651149),
        source('资料/二.csv', 1494177),
      ];
      const result = await run(files);
      expect(result.reason, result.output).toBe('completed');
      const output = JSON.parse(result.output);
      expect(output.sizes.sort((a: number, b: number) => a - b)).toEqual([
        1494177, 1651149,
      ]);
      expect(output.sha256.sort()).toEqual(
        files.map((f) => f.checksum.slice(7)).sort(),
      );
      expect(output).toMatchObject({ uid: 65532, host: false });
    },
  );
  it(
    'streams 40 MiB beyond former control-frame/archive/tmpfs boundaries',
    { tags: ['manual:ALLRICE_RUN_PYTHON_INTEGRATION'], timeout: 70000 },
    async () => {
      const file = source('large.csv', 40 * 1024 * 1024),
        result = await run([file]);
      expect(result.reason, result.output).toBe('completed');
      expect(JSON.parse(result.output)).toMatchObject({
        sizes: [file.sizeBytes],
        sha256: [file.checksum.slice(7)],
      });
    },
  );
  it(
    'stops without running the script on a changed object',
    { tags: ['manual:ALLRICE_RUN_PYTHON_INTEGRATION'], timeout: 70000 },
    async () => {
      const file = source('changed.csv', 5000000);
      file.checksum = 'sha256:' + '0'.repeat(64);
      const result = await run([file]);
      expect(result).toMatchObject({
        reason: 'failed',
        stopped: true,
        errorCode: 'INPUT_VERSION_CHANGED',
        artifacts: [],
      });
      expect(result.output).not.toContain('"sizes"');
    },
  );
  it(
    'cancels a stalled source and releases its reader and volume',
    { tags: ['manual:ALLRICE_RUN_PYTHON_INTEGRATION'], timeout: 70000 },
    async () => {
      const controller = new AbortController();
      let canceled = false;
      const file = source('slow.csv', 4000000);
      file.open = async () =>
        new ReadableStream({
          start(c) {
            c.enqueue(Buffer.alloc(100));
            setTimeout(() => controller.abort(), 150);
          },
          cancel() {
            canceled = true;
          },
        });
      const result = await run([file], controller.signal);
      expect(result).toMatchObject({
        reason: 'canceled',
        stopped: true,
        artifacts: [],
      });
      expect(canceled).toBe(true);
    },
  );
});
