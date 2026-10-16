/** Explicit component validation on a leased, idle native VM. This does not
 * create model Runs, pair devices, replace apps, or change the running release. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  RuntimeLocalCommandSchema,
  localCommandToolchainImageV1,
  managedPythonPayloadForPlatform,
  resolveSandboxExecutionPolicy,
  sandboxExecutionBudgetSpec,
  startSandboxExecutionBudget,
  renewSandboxExecutionBudget,
} from '../../../packages/contracts/src/index.js';
import { SandboxExecutionBudgetController } from '../../../packages/project-runtime/src/sandbox-execution-budget.js';
import {
  nodeSandboxExecutionControl,
  pythonSandboxExecutionControl,
} from '../../../packages/project-runtime/src/sandbox-execution-control.js';
import { LocalCommandRunner } from '../../../apps/rice-bridge/src/local-command-runner.js';
import { LocalServiceControl } from '../../../apps/rice-bridge/src/local-service-control.js';

assert.equal(process.env.ALLRICE_SANDBOX_ACCEPTANCE_WINDOW, 'owned');
const output = process.env.ALLRICE_SANDBOX_ACCEPTANCE_OUTPUT;
const socketPath = process.env.ALLRICE_BRIDGE_ACCEPTANCE_SOCKET;
assert.ok(output && socketPath);
const runner = new LocalCommandRunner({
  socketPath,
  imageDigest: localCommandToolchainImageV1,
});
const api = runner.api;
const profile = await runner.preflight();
const proof: Record<string, unknown> = {
  architecture: profile.architecture,
  nodeImage: profile.imageDigest,
  passed: false,
  checks: {},
};
const checks = proof.checks as Record<string, unknown>;
const attempts = new Map<string, string>();
const roots: string[] = [];
try {
  for (const mode of ['legacy', 'renewed', 'revoked'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'allrice-budget-native-'));
    roots.push(root);
    const source =
      mode === 'legacy'
        ? 'console.log("legacy unchanged")'
        : `
      const until=Date.now()+65000;
      const timer=setInterval(()=>{const busy=Date.now()+5;while(Date.now()<busy){}if(Date.now()>=until){clearInterval(timer);console.log('native budget completed');}},200);
    `;
    await writeFile(join(root, 'probe.mjs'), source);
    const spec = sandboxExecutionBudgetSpec(
      { version: 1, kind: 'compute' },
      resolveSandboxExecutionPolicy([]),
    );
    const now = Date.now(),
      rootDeadline = now + 600000;
    let authority = startSandboxExecutionBudget(spec, now, rootDeadline);
    const renewals: unknown[] = [];
    const budget = new SandboxExecutionBudgetController(
      authority,
      spec,
      async (request) => {
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
    const command = RuntimeLocalCommandSchema.parse({
      capability: 'local.process.execute',
      ...(mode === 'legacy' ? {} : { executionBudget: spec }),
      arguments: {
        executable: '/usr/local/bin/node',
        args: ['probe.mjs'],
        path: '.',
        files: [
          {
            path: 'probe.mjs',
            sha256:
              'sha256:' + createHash('sha256').update(source).digest('hex'),
          },
        ],
        imageDigest: profile.imageDigest,
        isolation: 'local-vm-container-v1',
        network: 'none',
        ...(mode === 'legacy'
          ? {}
          : { execution: { version: 1, kind: 'compute' } }),
        limits: {
          timeoutMs: 60000,
          outputBytes: 8192,
          memoryMiB: 128,
          cpuMillis: 500,
          pids: 32,
        },
      },
    });
    const attemptId = randomUUID();
    const result = await runner.execute(root, command, {
      attemptId,
      ...(mode === 'legacy' ? {} : { executionBudget: budget }),
      maintainLease: async () => mode !== 'revoked' || Date.now() - now < 3000,
    });
    attempts.set(attemptId, result.containerId);
    const elapsedMs = Date.now() - now;
    assert.equal(result.stopped, true);
    if (mode === 'revoked') {
      assert.equal(result.reason, 'lease_lost');
      assert.ok(elapsedMs < 12000);
    } else {
      assert.equal(result.reason, 'exited');
      assert.equal(result.exitCode, 0);
      if (mode === 'renewed') {
        assert.ok(elapsedMs > 60000);
        assert.ok(renewals.length >= 1);
        assert.equal(result.execution?.startedAt, now);
        assert.equal(result.execution?.hardDeadlineAt, rootDeadline);
      } else assert.equal(result.execution, undefined);
    }
    checks[mode] = { elapsedMs, result, renewals };
    await runner.cleanup(attemptId, result.containerId);
    attempts.delete(attemptId);
  }
  for (const runtime of ['node', 'python'] as const) {
    const attemptId = randomUUID(),
      now = Date.now();
    const config = {
      deadlineUnixMs: now + 60000,
      executionControl: { version: 1, attemptId, hardDeadlineAt: now + 600000 },
    };
    const image =
      runtime === 'node'
        ? profile.imageDigest
        : managedPythonPayloadForPlatform(`macos-${process.arch}`)!.imageId;
    const source =
      runtime === 'node'
        ? `const end=(reason,code)=>process.exit(code);${nodeSandboxExecutionControl}\ninstallSandboxExecutionControl(${JSON.stringify(config)});setInterval(()=>{},1000);`
        : `import os,sys,time,json\n${pythonSandboxExecutionControl}\ninstall_sandbox_execution_control(json.loads(${JSON.stringify(JSON.stringify(config))}))\ntime.sleep(120)`;
    const c = await api.json<{ Id: string }>(
      'POST',
      `/containers/create?name=allrice-budget-control-${attemptId}`,
      {
        Image: image,
        User: '0:0',
        OpenStdin: true,
        StdinOnce: false,
        Tty: false,
        Entrypoint:
          runtime === 'node'
            ? ['/usr/local/bin/node', '--input-type=module', '--eval', source]
            : ['/usr/local/bin/python3', '-I', '-S', '-u', '-c', source],
        Labels: { 'xyz.bplabs.allrice.attempt': attemptId },
        HostConfig: {
          NetworkMode: 'none',
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          Memory: 128 * 1024 ** 2,
          NanoCpus: 250000000,
          PidsLimit: 16,
          RestartPolicy: { Name: 'no' },
        },
      },
    );
    attempts.set(attemptId, c.Id);
    await api.json('POST', `/containers/${c.Id}/start`);
    const control = await LocalServiceControl.connect(socketPath, c.Id);
    await control.send({
      type: 'execution_renew',
      attemptId,
      sequence: 1,
      deadlineAt: config.deadlineUnixMs,
      leaseDeadlineAt: Date.now() + 1500,
    });
    // Stop sending without asking Docker to kill: PID 1 must expire by itself.
    const started = Date.now();
    let state: { Running: boolean; ExitCode: number };
    do {
      await delay(100);
      state = (
        await api.json<{ State: typeof state }>(
          'GET',
          `/containers/${c.Id}/json`,
        )
      ).State;
      assert.ok(
        Date.now() - started < 6000,
        'physical lease did not stop process',
      );
    } while (state.Running);
    control.close();
    assert.equal(state.ExitCode, 124);
    checks[`${runtime}-controller-silent`] = {
      elapsedMs: Date.now() - started,
      exitCode: state.ExitCode,
      image,
    };
    await api.json('DELETE', `/containers/${c.Id}`);
    attempts.delete(attemptId);
  }
  proof.passed = true;
} finally {
  for (const [attemptId, id] of attempts) {
    const c = await api.json<{
      Config: { Labels: Record<string, string> };
      State: { Running: boolean };
    }>('GET', `/containers/${id}/json`);
    assert.equal(c.Config.Labels['xyz.bplabs.allrice.attempt'], attemptId);
    if (c.State.Running)
      await api.json('POST', `/containers/${id}/kill?signal=KILL`);
    await api.json('DELETE', `/containers/${id}`);
  }
  for (const root of roots) await rm(root, { recursive: true, force: true });
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify(proof, null, 2) + '\n',
    { mode: 0o600 },
  );
}
console.log(
  JSON.stringify({
    passed: proof.passed,
    architecture: profile.architecture,
    checks: Object.keys(checks),
  }),
);
