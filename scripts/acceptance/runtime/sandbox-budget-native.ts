/** Real VM budget/short-lease acceptance with synthetic authority. The outer
 * operator owns the shared window, attests/installs/restores the exact guard,
 * and this script touches only its generated attempt IDs. No model calls. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  CloudCommandSchema,
  cloudToolchainImageV1,
  sandboxExecutionBudgetSpec,
  startSandboxExecutionBudget,
  renewSandboxExecutionBudget,
  type SandboxExecutionBudgetState,
} from '../../../packages/contracts/src/index.js';
import { CloudRunnerBackend } from '../../../apps/worker/src/cloud-runner/backend.js';

const directory = process.env.ALLRICE_SANDBOX_ACCEPTANCE_OUTPUT;
assert.ok(
  directory && process.env.ALLRICE_SANDBOX_ACCEPTANCE_WINDOW === 'owned',
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const lock = JSON.parse(
  await readFile('/Users/a123/allrice-dev/.local/qa-validation.lock', 'utf8'),
);
assert.equal(lock.owner, 'met189-native-sandbox');
process.kill(lock.pid, 0);
const backend = new CloudRunnerBackend();
const spec = sandboxExecutionBudgetSpec(
  { version: 1, kind: 'compute' },
  { version: 1, maxExecutionMs: 600000, sources: [] },
);
const checks: Record<string, unknown>[] = [];
const save = (name: string, data: unknown) =>
  writeFile(
    directory + '/' + name + '.json',
    JSON.stringify(data, null, 2) + '\n',
    { mode: 0o600 },
  );
const workload = (duration: number) =>
  `const until=Date.now()+${duration};let n=0;while(Date.now()<until){for(let j=0;j<1000;j++)n=Math.sin(n+j)}console.log('completed:'+n)`;

async function execute(name: string, duration: number, revoke = false) {
  const attemptId = randomUUID();
  const command = CloudCommandSchema.parse({
    capability: 'cloud.process.execute',
    backend: 'cloud-gvisor-v1',
    runtime: 'runsc',
    imageDigest: cloudToolchainImageV1,
    network: 'none',
    executionBudget: spec,
    arguments: {
      script: workload(duration),
      execution: { version: 1, kind: 'compute' },
    },
  });
  let state: SandboxExecutionBudgetState | undefined;
  let valid = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now(),
    rootDeadline = startedAt + 180000;
  try {
    const result = await backend.execute(command, [], {
      attemptId,
      deadlineAt: new Date(rootDeadline).toISOString(),
      maintainLease: async () => valid,
      sandboxExecution: {
        spec,
        exchange: async (request) => {
          assert.ok(valid, 'authority revoked');
          state ??= startSandboxExecutionBudget(spec, Date.now(), rootDeadline);
          if (request)
            state = renewSandboxExecutionBudget(
              state,
              request,
              Date.now(),
              rootDeadline,
            );
          await save(name + '-budget', { attemptId, state });
          return state;
        },
      },
      observe: async (event) => {
        if (event.stage === 'executing') {
          await save(name + '-executing', {
            attemptId,
            pid: process.pid,
            at: Date.now(),
          });
          if (revoke)
            timer = setTimeout(() => {
              valid = false;
            }, 4000);
        }
      },
    });
    await save(name, { attemptId, state, result });
    return { attemptId, state, result };
  } finally {
    if (timer) clearTimeout(timer);
    const observed = await backend.inspect(attemptId);
    if (observed?.State.Running) await backend.stop(attemptId);
    await backend.cleanup(attemptId);
    assert.equal(await backend.inspect(attemptId), null);
  }
}

const childMode = process.env.ALLRICE_SANDBOX_CONTROLLER_CHILD;
if (childMode) {
  await execute(childMode, 90000);
} else {
  assert.equal(lock.pid, process.ppid);
  try {
    const extended = await execute('renewed-compute', 72000);
    assert.equal(extended.result.reason, 'completed');
    assert.equal(extended.result.exitCode, 0);
    assert.ok(extended.result.output.includes('completed:'));
    assert.ok(extended.result.elapsedMs > 65000);
    assert.ok(extended.state && extended.state.sequence > 0);
    assert.ok(extended.state.deadlineAt <= extended.state.hardDeadlineAt);
    checks.push({
      name: 'real command beyond 65 seconds; persisted progress renewal',
      passed: true,
      ...extended,
    });
    await save('report', { checks });

    const revoked = await execute('revoked-compute', 90000, true);
    assert.equal(revoked.result.reason, 'canceled');
    assert.equal(revoked.result.stopped, true);
    assert.ok(revoked.result.elapsedMs < 15000);
    checks.push({
      name: 'revocation stops original process',
      passed: true,
      ...revoked,
    });
    await save('report', { checks });

    for (const signal of ['SIGSTOP', 'SIGKILL'] as const) {
      const name = 'controller-' + signal.toLowerCase();
      const child = spawn(
        process.execPath,
        [...process.execArgv, fileURLToPath(import.meta.url)],
        {
          env: { ...process.env, ALLRICE_SANDBOX_CONTROLLER_CHILD: name },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let childOutput = '';
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (b: Buffer) => {
          childOutput = (childOutput + b).slice(-10000);
        });
      const ended = once(child, 'exit');
      let ownAttempt: string | undefined;
      try {
        const readyUntil = Date.now() + 20000;
        while (Date.now() < readyUntil) {
          try {
            const ready = JSON.parse(
              await readFile(
                directory + '/' + name + '-executing.json',
                'utf8',
              ),
            );
            assert.equal(ready.pid, child.pid);
            ownAttempt = ready.attemptId;
            break;
          } catch {
            if (child.exitCode !== null) break;
            await delay(100);
          }
        }
        assert.ok(ownAttempt, childOutput);
        assert.equal((await backend.inspect(ownAttempt))?.State.Running, true);
        const lostAt = Date.now();
        assert.ok(child.kill(signal));
        let stopped = false;
        while (Date.now() - lostAt < 9000) {
          const observed = await backend.inspect(ownAttempt);
          if (observed && !observed.State.Running) {
            stopped = true;
            break;
          }
          await delay(150);
        }
        assert.ok(
          stopped,
          'independent VM guard did not stop the original attempt',
        );
        const stopMs = Date.now() - lostAt;
        if (signal === 'SIGSTOP') child.kill('SIGCONT');
        await Promise.race([
          ended,
          delay(10000).then(() => {
            throw Error('controller cleanup timeout');
          }),
        ]);
        checks.push({
          name: signal + ' loses physical lease and stops without replay',
          passed: true,
          attemptId: ownAttempt,
          stopMs,
        });
        await save('report', { checks });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGCONT');
          child.kill('SIGKILL');
          await ended;
        }
        if (ownAttempt) {
          if ((await backend.inspect(ownAttempt))?.State.Running)
            await backend.stop(ownAttempt);
          await backend.cleanup(ownAttempt);
          assert.equal(await backend.inspect(ownAttempt), null);
        }
        await save(name + '-controller', {
          output: childOutput,
          exitCode: child.exitCode,
          signalCode: child.signalCode,
        });
      }
    }
    await save('report', {
      passed: true,
      mode: 'real VM; synthetic authority; no model',
      checks,
    });
  } catch (error) {
    await save('report', { passed: false, checks, error: String(error) });
    throw error;
  }
}
