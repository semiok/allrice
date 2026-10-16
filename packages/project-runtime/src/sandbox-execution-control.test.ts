import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  nodeSandboxExecutionControl,
  pythonSandboxExecutionControl,
} from './sandbox-execution-control.js';

const children: ReturnType<typeof spawn>[] = [];
afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null) child.kill('SIGKILL');
});

async function fixture(
  runtime: 'node' | 'python',
  deadlineMs = 2000,
  hardMs = 3000,
  runtimeNetwork = false,
) {
  const attemptId = randomUUID(),
    now = Date.now();
  const config = {
    deadlineUnixMs: now + deadlineMs,
    runtimeNetwork,
    executionControl: { version: 1, attemptId, hardDeadlineAt: now + hardMs },
  };
  const child =
    runtime === 'node'
      ? spawn(process.execPath, [
          '--input-type=module',
          '--eval',
          `
      const end=(reason,code)=>process.exit(code);
      ${nodeSandboxExecutionControl}
      const config=${JSON.stringify(config)};installSandboxExecutionControl(config);
      const probe=setInterval(()=>{if(config.runtimeNetworkReady){console.log('network ready');clearInterval(probe);}},10);
      console.log('ready');setInterval(()=>{},1000);
    `,
        ])
      : spawn('python3', [
          '-I',
          '-u',
          '-c',
          `
import os,sys,json,time
${pythonSandboxExecutionControl}
config=json.loads(${JSON.stringify(JSON.stringify(config))});install_sandbox_execution_control(config)
print('ready',flush=True)
while True:
    if config.get('runtimeNetworkReady') is True:print('network ready',flush=True);break
    time.sleep(.01)
time.sleep(60)
    `,
        ]);
  children.push(child);
  let stderr = '';
  child.stderr!.on('data', (b) => {
    stderr += b;
  });
  const exited = once(child, 'exit');
  const ready = await Promise.race([
    once(child.stdout!, 'data').then(([b]) => String(b).trim()),
    exited.then(() => `exited: ${stderr}`),
  ]);
  expect(ready).toBe('ready');
  let sequence = 0;
  return {
    child,
    exited,
    config,
    send: (patch: Record<string, unknown> = {}) =>
      child.stdin!.write(
        JSON.stringify({
          type: 'execution_renew',
          attemptId,
          sequence: ++sequence,
          deadlineAt: config.deadlineUnixMs,
          leaseDeadlineAt: Math.min(Date.now() + 1000, config.deadlineUnixMs),
          ...patch,
        }) + '\n',
      ),
  };
}

it.each(['node', 'python'] as const)(
  '%s exits when the private control channel closes',
  async (runtime) => {
    const f = await fixture(runtime);
    f.send();
    f.child.stdin!.end();
    const [code] = await f.exited;
    expect(code).toBe(124);
  },
);

it.each(['node', 'python'] as const)(
  '%s stops a silent controller within its last physical lease',
  async (runtime) => {
    const f = await fixture(runtime);
    const start = Date.now();
    f.send({ leaseDeadlineAt: start + 200 });
    const [code] = await f.exited;
    expect(code).toBe(124);
    expect(Date.now() - start).toBeLessThan(1500);
  },
);

it.each(['node', 'python'] as const)(
  '%s can extend only the soft deadline within the immutable cap',
  async (runtime) => {
    const f = await fixture(runtime, 500, 1200);
    f.send({
      deadlineAt: f.config.executionControl.hardDeadlineAt,
      leaseDeadlineAt: f.config.executionControl.hardDeadlineAt,
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(f.child.exitCode).toBeNull();
    const [code] = await f.exited;
    expect(code).toBe(124);
  },
);

it.each(
  (['node', 'python'] as const).flatMap((runtime) =>
    [
      'wrong-attempt',
      'replay',
      'increase-cap',
      'long-lease',
      'output-spoof',
      'overflow',
      'ungranted-network',
    ].map((mode) => ({ runtime, mode })),
  ),
)('$runtime rejects $mode on private control', async ({ runtime, mode }) => {
  const f = await fixture(runtime, 3000, 40000);
  f.send();
  if (mode === 'wrong-attempt') f.send({ attemptId: randomUUID() });
  if (mode === 'replay') f.send({ sequence: 1 });
  if (mode === 'increase-cap')
    f.send({ deadlineAt: f.config.executionControl.hardDeadlineAt + 1 });
  if (mode === 'long-lease')
    f.send({
      deadlineAt: f.config.executionControl.hardDeadlineAt,
      leaseDeadlineAt: Date.now() + 30000,
    });
  if (mode === 'output-spoof') f.send({ type: 'stdout', data: 'renew' });
  if (mode === 'ungranted-network') f.send({ networkReady: true });
  if (mode === 'overflow') f.child.stdin!.write('x'.repeat(17000));
  const [code] = await f.exited;
  expect(code).toBe(124);
});

it.each(['node', 'python'] as const)(
  '%s opens the network gate only on a valid private authority frame',
  async (runtime) => {
    const f = await fixture(runtime, 3000, 4000, true);
    let observed = '';
    f.child.stdout!.on('data', (bytes) => {
      observed += String(bytes);
    });
    f.send();
    await new Promise((r) => setTimeout(r, 60));
    expect(observed.trim()).toBe('');
    f.send({ networkReady: true });
    await expect.poll(() => observed).toContain('network ready');
    f.child.stdin!.end();
    const [code] = await f.exited;
    expect(code).toBe(124);
  },
);

it.each(['node', 'python'] as const)(
  '%s tolerates a healthy six-second control roundtrip then still stops on channel loss',
  async (runtime) => {
    const f = await fixture(runtime, 30000, 40000);
    f.send({ leaseDeadlineAt: Date.now() + 20000 });
    await new Promise((r) => setTimeout(r, 6000));
    expect(f.child.exitCode).toBeNull();
    f.send({
      leaseDeadlineAt: Math.min(Date.now() + 20000, f.config.deadlineUnixMs),
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(f.child.exitCode).toBeNull();
    f.child.stdin!.end();
    const [code] = await f.exited;
    expect(code).toBe(124);
  },
  10000,
);
