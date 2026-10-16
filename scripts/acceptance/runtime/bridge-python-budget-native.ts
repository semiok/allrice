/** Explicit, isolated component checks on an idle native VM. No user pairing,
 * files, model Run, application installation or deployment is changed. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RuntimeLocalPythonPayloadSchema,
  managedPythonPayloadForPlatform,
  resolveSandboxExecutionPolicy,
  sandboxExecutionBudgetSpec,
  startSandboxExecutionBudget,
  renewSandboxExecutionBudget,
  type RuntimeLocalPythonPayload,
} from '../../../packages/contracts/src/index.js';
import { SandboxExecutionBudgetController } from '../../../packages/project-runtime/src/sandbox-execution-budget.js';
import { LocalPythonRunner } from '../../../apps/rice-bridge/src/local-python-runner.js';

assert.equal(process.env.ALLRICE_SANDBOX_ACCEPTANCE_WINDOW, 'owned');
const output = process.env.ALLRICE_SANDBOX_ACCEPTANCE_OUTPUT;
const socketPath = process.env.ALLRICE_BRIDGE_ACCEPTANCE_SOCKET;
assert.ok(output && socketPath);
const release = managedPythonPayloadForPlatform(`macos-${process.arch}`)!;
const runner = new LocalPythonRunner({ socketPath, release });
const profile = await runner.preflight(AbortSignal.timeout(60000));
const proof = {
  architecture: release.architecture,
  image: release.imageId,
  profile,
  checks: {} as Record<string, unknown>,
  passed: false,
};
const retained = new Map<string, RuntimeLocalPythonPayload>();
try {
  for (const mode of ['legacy', 'renewed', 'revoked'] as const) {
    const execution = { version: 1 as const, kind: 'compute' as const };
    const spec = sandboxExecutionBudgetSpec(
      execution,
      resolveSandboxExecutionPolicy([]),
    );
    const started = Date.now(),
      rootDeadline = started + 600000;
    let authority = startSandboxExecutionBudget(spec, started, rootDeadline);
    const renewals: unknown[] = [];
    const budget = new SandboxExecutionBudgetController(
      authority,
      spec,
      async (request) => {
        if (mode === 'renewed') await new Promise((r) => setTimeout(r, 6500));
        authority = renewSandboxExecutionBudget(
          authority,
          request,
          Date.now(),
          rootDeadline,
        );
        renewals.push(request);
        return authority;
      },
    );
    const script = `import json,time,os
until=time.monotonic()+${mode === 'legacy' ? '0' : '65'}
while time.monotonic()<until:
    busy=time.monotonic()+.003
    while time.monotonic()<busy: pass
    time.sleep(.1)
with open('output/result.json','w') as f: json.dump({'uid':os.getuid(),'complete':True},f)
print('managed Python complete')
`;
    const payload = RuntimeLocalPythonPayloadSchema.parse({
      capability: 'local.python.execute',
      ...(mode === 'legacy' ? {} : { executionBudget: spec }),
      arguments: {
        path: '.',
        purpose: 'python_charts',
        origin: {
          toolName: 'python.execute',
          callId: randomUUID(),
          argumentsDigest:
            'sha256:' + createHash('sha256').update(script).digest('hex'),
        },
        script,
        inputs: [],
        outputs: [
          {
            path: 'result.json',
            fileName: 'result.json',
            format: 'json',
            mediaType: 'application/json',
            objectId: randomUUID(),
          },
        ],
        profileVersion: 1,
        imageId: release.imageId,
        architecture: release.architecture,
        isolation: 'local-vm-container-v1',
        network: 'none',
        ...(mode === 'legacy' ? {} : { execution }),
        limits: {
          timeoutMs: 1000,
          inputBytes: 2000000,
          artifactBytes: 1000000,
          outputBytes: 8192,
          memoryMiB: 512,
          cpuMillis: 500,
          pids: 64,
        },
      },
    });
    const attemptId = randomUUID();
    retained.set(attemptId, payload);
    let uploads = 0;
    const result = await runner.execute(payload, {
      attemptId,
      ...(mode === 'legacy' ? {} : { executionBudget: budget }),
      maintainLease: async () => {
        if (mode === 'renewed') await new Promise((r) => setTimeout(r, 3500));
        return mode !== 'revoked' || Date.now() - started < 3000;
      },
      transport: {
        download: async () => {
          throw Error('unexpected input');
        },
        upload: async (file, metadata, bytes) => {
          assert.deepEqual(JSON.parse(Buffer.from(bytes).toString()), {
            uid: 65532,
            complete: true,
          });
          const c = await runner.api.json<{ State: { Running: boolean } }>(
            'GET',
            `/containers/allrice-python-${attemptId}/json`,
          );
          assert.equal(
            c.State.Running,
            false,
            'collect only after physical exit',
          );
          uploads++;
          return { ...file, ...metadata, collected: true };
        },
      },
    });
    const elapsedMs = Date.now() - started;
    assert.equal(result.stopped, true);
    if (mode === 'revoked') {
      assert.equal(result.reason, 'lease_lost');
      assert.ok(elapsedMs < 12000);
      assert.equal(uploads, 0);
    } else {
      assert.equal(result.reason, 'exited');
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(uploads, 1);
      if (mode === 'renewed') {
        assert.ok(elapsedMs > 60000);
        assert.ok(renewals.length >= 1);
        assert.equal(result.execution?.startedAt, started);
        assert.equal(result.execution?.hardDeadlineAt, rootDeadline);
      } else assert.equal(result.execution, undefined);
    }
    proof.checks[mode] = { elapsedMs, uploads, result, renewals };
    await runner.cleanup(attemptId, result.containerId, payload);
    retained.delete(attemptId);
  }
  proof.passed = true;
} finally {
  for (const [attempt, payload] of retained) {
    const c = await runner.api
      .json<{
        Id: string;
        Config: { Labels: Record<string, string> };
        State: { Running: boolean };
      }>('GET', `/containers/allrice-python-${attempt}/json`)
      .catch(() => null);
    if (!c) continue;
    assert.equal(c.Config.Labels['xyz.bplabs.allrice.python.attempt'], attempt);
    if (c.State.Running)
      await runner.api.json('POST', `/containers/${c.Id}/kill?signal=KILL`);
    await runner.cleanup(attempt, c.Id, payload);
  }
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify(proof, null, 2) + '\n',
    { mode: 0o600 },
  );
}
console.log(
  JSON.stringify({
    passed: proof.passed,
    architecture: proof.architecture,
    checks: Object.keys(proof.checks),
  }),
);
