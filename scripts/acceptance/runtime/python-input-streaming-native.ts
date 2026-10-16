/** Explicit native component acceptance; uses only attempt-owned volumes/files. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  RuntimeLocalPythonPayloadSchema,
  managedPythonPayloadForPlatform,
} from '../../../packages/contracts/src/index.js';
import { LocalPythonRunner } from '../../../apps/rice-bridge/src/local-python-runner.js';
assert.equal(process.env.ALLRICE_SANDBOX_ACCEPTANCE_WINDOW, 'owned');
const socketPath = process.env.ALLRICE_BRIDGE_ACCEPTANCE_SOCKET!,
  out = process.env.ALLRICE_SANDBOX_ACCEPTANCE_OUTPUT!;
assert.ok(socketPath && out);
const release = managedPythonPayloadForPlatform(`macos-${process.arch}`)!,
  runner = new LocalPythonRunner({ socketPath, release });
const profile = await runner.preflight(AbortSignal.timeout(60000));
assert.equal(profile.inputStreamingVersion, 1);
const before = (await readdir(tmpdir()))
  .filter((p) => p.startsWith('allrice-python-input-'))
  .sort();
const report = {
  architecture: process.arch,
  profile,
  checks: [] as unknown[],
  passed: false,
};
const chunk = Buffer.alloc(65536, 120),
  sha = (size: number) => {
    const h = createHash('sha256');
    for (let n = 0; n < size; n += chunk.length)
      h.update(chunk.subarray(0, Math.min(chunk.length, size - n)));
    return `sha256:${h.digest('hex')}`;
  };
try {
  for (const mode of ['original', 'large', 'corrupt', 'canceled'] as const) {
    const sizes = mode === 'original' ? [1651149, 1494177] : [40 * 1024 * 1024];
    const payload = RuntimeLocalPythonPayloadSchema.parse({
      capability: 'local.python.execute',
      arguments: {
        path: '.',
        purpose: 'python_charts',
        origin: {
          toolName: 'python.execute',
          callId: randomUUID(),
          argumentsDigest: sha(1),
        },
        inputTransfer: 'stream-v1',
        script:
          "import pathlib,hashlib,json,os\nfiles=sorted(f for f in pathlib.Path('input').rglob('*') if f.is_file());print(json.dumps({'sizes':[f.stat().st_size for f in files],'sha256':[hashlib.file_digest(f.open('rb'),'sha256').hexdigest() for f in files],'uid':os.getuid()}))",
        inputs: sizes.map((sizeBytes, i) => ({
          path: `资料/${i}.csv`,
          objectId: randomUUID(),
          checksum: sha(sizeBytes),
          sizeBytes,
          mediaType: 'text/csv',
        })),
        outputs: [],
        profileVersion: 1,
        imageId: release.imageId,
        architecture: release.architecture,
        isolation: 'local-vm-container-v1',
        network: 'none',
        limits: {
          timeoutMs: 60000,
          inputBytes: sizes.reduce((a, b) => a + b, 0),
          artifactBytes: 4000000,
          outputBytes: 8192,
          memoryMiB: 512,
          cpuMillis: 1000,
          pids: 64,
        },
      },
    });
    const attemptId = randomUUID(),
      abort = new AbortController(),
      start = Date.now();
    try {
      const result = await runner.execute(payload, {
        attemptId,
        signal: abort.signal,
        maintainLease: async () => true,
        transport: {
          download: async (file, signal, receive) => {
            assert.ok(receive);
            for (let n = 0; n < file.sizeBytes; n += chunk.length) {
              signal.throwIfAborted();
              await receive!(
                mode === 'corrupt'
                  ? Buffer.alloc(
                      Math.min(chunk.length, file.sizeBytes - n),
                      121,
                    )
                  : chunk.subarray(
                      0,
                      Math.min(chunk.length, file.sizeBytes - n),
                    ),
              );
              if (mode === 'canceled') abort.abort();
            }
            return Buffer.alloc(0);
          },
          upload: async () => {
            throw Error('unexpected output');
          },
        },
      });
      assert.ok(
        mode === 'original' || mode === 'large',
        'invalid input executed',
      );
      assert.equal(result.reason, 'exited', JSON.stringify(result));
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stopped, true);
      assert.deepEqual(JSON.parse(result.stdout), {
        sizes,
        sha256: payload.arguments.inputs.map((f) => f.checksum.slice(7)),
        uid: 65532,
      });
      report.checks.push({
        mode,
        attemptId,
        bytes: sizes.reduce((a, b) => a + b, 0),
        elapsedMs: Date.now() - start,
        passed: true,
      });
    } catch (e) {
      if (mode === 'original' || mode === 'large') throw e;
      assert.match(
        String(e),
        mode === 'corrupt' ? /INPUT_VERSION_CHANGED/ : /EXECUTION_REVOKED/,
      );
      report.checks.push({ mode, notExecuted: true, passed: true });
    } finally {
      const containers = await runner.api.json<{ Id: string }[]>(
        'GET',
        `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [`xyz.bplabs.allrice.python.attempt=${attemptId}`] }))}`,
      );
      if (containers.length) {
        const c = await runner.api.json<{ State: { Running: boolean } }>(
          'GET',
          `/containers/${containers[0]!.Id}/json`,
        );
        if (c.State.Running)
          await runner.api.json(
            'POST',
            `/containers/${containers[0]!.Id}/kill?signal=KILL`,
          );
        await runner.cleanup(attemptId, containers[0]!.Id, payload);
      }
      await assert.rejects(
        runner.api.json('GET', `/containers/allrice-python-${attemptId}/json`),
        /DAEMON_HTTP_404/,
      );
      await assert.rejects(
        runner.api.json('GET', `/volumes/allrice-python-${attemptId}`),
        /DAEMON_HTTP_404/,
      );
    }
  }
  assert.deepEqual(
    (await readdir(tmpdir()))
      .filter((p) => p.startsWith('allrice-python-input-'))
      .sort(),
    before,
  );
  report.passed = true;
} finally {
  await writeFile(out, JSON.stringify(report, null, 2) + '\n');
}
