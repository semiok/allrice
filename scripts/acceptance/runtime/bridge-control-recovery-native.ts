/** Real Node/Python processes and real HTTP control replies on a leased VM.
 * Faults affect only this fixture's own control endpoint. No user Run is replayed. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuntimeLocalCommandSchema,
  RuntimeLocalPythonPayloadSchema,
  localCommandToolchainImageV1,
  managedPythonPayloadForPlatform,
  resolveSandboxExecutionPolicy,
  sandboxExecutionBudgetSpec,
  startSandboxExecutionBudget,
  renewSandboxExecutionBudget,
  type SandboxExecutionRenewal,
} from '../../../packages/contracts/src/index.js';
import { SandboxExecutionBudgetController } from '../../../packages/project-runtime/src/sandbox-execution-budget.js';
import { LocalCommandRunner } from '../../../apps/rice-bridge/src/local-command-runner.js';
import { LocalPythonRunner } from '../../../apps/rice-bridge/src/local-python-runner.js';
import { BridgeControlRequests } from '../../../apps/rice-bridge/src/control-request.js';

assert.equal(process.env.ALLRICE_SANDBOX_ACCEPTANCE_WINDOW, 'owned');
const output = process.env.ALLRICE_SANDBOX_ACCEPTANCE_OUTPUT;
const socketPath = process.env.ALLRICE_BRIDGE_ACCEPTANCE_SOCKET;
assert.ok(output && socketPath);
const node = new LocalCommandRunner({
  socketPath,
  imageDigest: localCommandToolchainImageV1,
});
const release = managedPythonPayloadForPlatform(`macos-${process.arch}`)!;
const python = new LocalPythonRunner({ socketPath, release });
const profile = await node.preflight();
await python.preflight(AbortSignal.timeout(60000));
const proof = {
  architecture: profile.architecture,
  checks: [] as unknown[],
  passed: false,
};
try {
  for (const runtime of ['node', 'python'] as const) {
    for (const mode of ['recover', 'disconnect', 'rejected'] as const) {
      const root = await mkdtemp(join(tmpdir(), 'allrice-control-native-'));
      const attemptId = randomUUID(),
        operationId = randomUUID();
      const spec = sandboxExecutionBudgetSpec(
        { version: 1, kind: 'compute' },
        resolveSandboxExecutionPolicy([]),
      );
      const now = Date.now(),
        hardDeadlineAt = now + 600000;
      let authority = startSandboxExecutionBudget(spec, now, hardDeadlineAt);
      const initial = authority;
      const renewals: string[] = [];
      let heartbeats = 0,
        droppedHeartbeats = 0,
        uploads = 0;
      const server = createServer((req, res) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (req.url?.endsWith('/budget')) {
            renewals.push(JSON.stringify(body));
            authority = renewSandboxExecutionBudget(
              authority,
              body.renewal as SandboxExecutionRenewal,
              Date.now(),
              hardDeadlineAt,
            );
            if (mode === 'disconnect' || renewals.length === 1) {
              res.destroy();
              return;
            }
            res.end(JSON.stringify(authority));
          } else {
            heartbeats++;
            if (mode === 'rejected' && Date.now() - now > 5000) {
              res.statusCode = 403;
              res.end(
                JSON.stringify({ error: { message: 'test authority denied' } }),
              );
              return;
            }
            if (
              mode === 'recover' &&
              Date.now() - now > 5000 &&
              droppedHeartbeats++ === 0
            ) {
              res.destroy();
              return;
            }
            res.end(JSON.stringify({ allowed: true }));
          }
        })().catch(() => {
          res.statusCode = 500;
          res.end('{}');
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const control = new BridgeControlRequests(undefined, {
        operationId,
        attemptId,
      });
      const base = {
        server: `http://127.0.0.1:${address.port}`,
        method: 'POST' as const,
        maximumResponseBytes: 32768,
      };
      const path = `/api/v1/bridge/device/operations/${operationId}`;
      const budget = new SandboxExecutionBudgetController(
        authority,
        spec,
        (renewal) =>
          control.send('budget', {
            ...base,
            path: path + '/budget',
            body: { renewal },
          }),
      );
      const maintainLease = async () => {
        const ack = await control.send<{ allowed: boolean }>('heartbeat', {
          ...base,
          path: path + '/heartbeat',
          body: { attemptId },
        });
        return ack.allowed;
      };
      const script =
        runtime === 'node'
          ? `console.log('native-start');const until=Date.now()+65000;const timer=setInterval(()=>{const busy=Date.now()+5;while(Date.now()<busy){}if(Date.now()>=until){clearInterval(timer);console.log('native-complete');}},200);`
          : `import time,json\nprint('native-start',flush=True)\nuntil=time.monotonic()+65\nwhile time.monotonic()<until:\n    busy=time.monotonic()+.003\n    while time.monotonic()<busy:pass\n    time.sleep(.1)\nwith open('output/result.json','w') as f:json.dump({'complete':True},f)\nprint('native-complete')\n`;
      const payload = RuntimeLocalPythonPayloadSchema.parse({
        capability: 'local.python.execute',
        executionBudget: spec,
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
          execution: { version: 1, kind: 'compute' },
          limits: {
            timeoutMs: 60000,
            artifactBytes: 1000000,
            outputBytes: 8192,
            memoryMiB: 512,
            cpuMillis: 500,
            pids: 64,
          },
        },
      });
      let id: string | undefined;
      try {
        await writeFile(join(root, 'probe.mjs'), script);
        const result =
          runtime === 'node'
            ? await node.execute(
                root,
                RuntimeLocalCommandSchema.parse({
                  capability: 'local.process.execute',
                  executionBudget: spec,
                  arguments: {
                    executable: '/usr/local/bin/node',
                    args: ['probe.mjs'],
                    path: '.',
                    files: [
                      {
                        path: 'probe.mjs',
                        sha256:
                          'sha256:' +
                          createHash('sha256').update(script).digest('hex'),
                      },
                    ],
                    imageDigest: profile.imageDigest,
                    isolation: 'local-vm-container-v1',
                    network: 'none',
                    execution: { version: 1, kind: 'compute' },
                    limits: {
                      timeoutMs: 60000,
                      outputBytes: 8192,
                      memoryMiB: 128,
                      cpuMillis: 500,
                      pids: 32,
                    },
                  },
                }),
                { attemptId, executionBudget: budget, maintainLease },
              )
            : await python.execute(payload, {
                attemptId,
                executionBudget: budget,
                maintainLease,
                transport: {
                  download: async () => {
                    throw Error('unexpected input');
                  },
                  upload: async (file, metadata, bytes) => {
                    assert.deepEqual(
                      JSON.parse(Buffer.from(bytes).toString()),
                      { complete: true },
                    );
                    uploads++;
                    return { ...file, ...metadata, collected: true };
                  },
                },
              });
        id = result.containerId;
        const elapsedMs = Date.now() - now;
        proof.checks.push({
          runtime,
          mode,
          elapsedMs,
          result,
          renewals,
          heartbeats,
          uploads,
        });
        assert.equal(result.stopped, true);
        assert.equal(result.execution?.startedAt, now);
        assert.equal(result.execution?.hardDeadlineAt, hardDeadlineAt);
        assert.equal((result.stdout.match(/native-start/g) ?? []).length, 1);
        if (mode === 'recover') {
          assert.equal(result.reason, 'exited');
          assert.equal(result.exitCode, 0);
          assert.equal(result.controlFailure, undefined);
          assert.ok(elapsedMs > 60000);
          assert.equal(renewals.length, 2);
          assert.equal(renewals[0], renewals[1]);
          assert.equal(result.execution?.renewalCount, 1);
          assert.equal(authority.deadlineAt, initial.deadlineAt + 60000);
          assert.equal(uploads, runtime === 'python' ? 1 : 0);
        } else {
          assert.equal(result.reason, 'lease_lost');
          assert.equal(uploads, 0);
          assert.equal(result.execution?.renewalCount, 0);
          assert.equal(
            result.controlFailure?.stage,
            mode === 'disconnect' ? 'budget' : 'heartbeat',
          );
          assert.equal(
            result.controlFailure?.kind,
            mode === 'disconnect' ? 'transport' : 'rejected',
          );
          assert.equal(
            result.controlFailure?.attempts,
            mode === 'disconnect' ? 2 : 1,
          );
          assert.ok(elapsedMs < (mode === 'disconnect' ? 60000 : 15000));
          if (mode === 'disconnect') {
            assert.equal(renewals.length, 2);
            assert.equal(renewals[0], renewals[1]);
          }
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        const api = runtime === 'node' ? node.api : python.api;
        const name =
          runtime === 'node'
            ? `allrice-${attemptId}`
            : `allrice-python-${attemptId}`;
        const container = await api
          .json<{
            Id: string;
            State: { Running: boolean };
            Config: { Labels: Record<string, string> };
          }>('GET', `/containers/${id ?? name}/json`)
          .catch(() => null);
        if (container) {
          assert.equal(
            container.Config.Labels[
              runtime === 'node'
                ? 'xyz.bplabs.allrice.attempt'
                : 'xyz.bplabs.allrice.python.attempt'
            ],
            attemptId,
          );
          if (container.State.Running)
            await api.json(
              'POST',
              `/containers/${container.Id}/kill?signal=KILL`,
            );
          if (runtime === 'node') await node.cleanup(attemptId, container.Id);
          else await python.cleanup(attemptId, container.Id, payload);
        }
        await rm(root, { recursive: true, force: true });
      }
    }
  }
  proof.passed = true;
} finally {
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
    checks: proof.checks.length,
  }),
);
