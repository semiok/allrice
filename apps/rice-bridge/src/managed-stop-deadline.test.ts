import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import {
  managedNodePayloadForPlatform,
  managedPythonPayloadForPlatform,
} from '@allrice/contracts';
import type * as Runtime from '@allrice/project-runtime';

const ports = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock('@allrice/project-runtime', async (original) => ({
  ...(await original<typeof Runtime>()),
  downloadManagedRuntimeAsset: ports.download,
}));
import { ManagedPythonSandbox } from './managed-python-sandbox.js';
import { managedSandboxProfile } from './managed-sandbox-release.js';
import { LocalCommandError } from './local-command-inputs.js';
import type { PreparationEvent } from './preparation-progress.js';
import * as ownedProcess from './owned-stop-process.js';
import type { Readable } from 'node:stream';

const roots: string[] = [],
  extraChildren: ChildProcess[] = [];
const fixturePids = new Map<number, string>();
afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const child of extraChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = new Promise<void>((resolve) =>
        child.once('exit', () => resolve()),
      );
      child.kill('SIGKILL');
      await exit;
    }
  }
  // These PIDs were emitted by scripts created in this test's private root.
  // Cleanup never searches names, real Colima profiles or global VM state.
  for (const [pid, binary] of fixturePids) {
    try {
      const { stdout } = await promisify(execFile)('/bin/ps', [
        '-p',
        String(pid),
        '-o',
        'command=',
      ]);
      // A PID from a completed fixture may have been reused. Only the exact
      // unique fixture executable still running under that PID is ours.
      if (stdout.includes(binary)) process.kill(pid, 'SIGKILL');
    } catch {
      /* already observed exited */
    }
  }
  fixturePids.clear();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function sandbox() {
  return new ManagedPythonSandbox(
    {
      server: 'https://synthetic.invalid',
      deviceId: randomUUID(),
      deviceName: 'Isolated deadline fixture',
      grants: [],
    },
    managedPythonPayloadForPlatform(`macos-${process.arch}`)!,
  );
}
type Event = {
  command: string;
  pid: number;
  args: string[];
  signal?: string;
  home: string;
  lima: string;
};
async function fixture(
  options: {
    stopHang?: boolean;
    startHang?: boolean;
    startFailure?: boolean;
    statusHang?: boolean;
    status?: string;
    statusFailure?: boolean;
    statusDelay?: number;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'rice-owned-vm-stop-'));
  roots.push(root);
  const tools = join(root, 'tools'),
    vm = join(root, 'vm');
  await mkdir(join(tools, 'bin'), { recursive: true, mode: 0o700 });
  await mkdir(vm, { mode: 0o700 });
  const events = join(root, 'events.jsonl'),
    binary = join(tools, 'bin', 'colima');
  const source = `#!${process.execPath}
const fs = require('node:fs');
const command = process.argv[2];
const options = ${JSON.stringify(options)};
const record = signal => fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({command,pid:process.pid,args:process.argv.slice(2),signal,home:process.env.COLIMA_HOME,lima:process.env.LIMA_HOME})+'\\n');
const hang = (command === 'stop' && options.stopHang) || (command === 'start' && options.startHang) || (command === 'list' && options.statusHang);
if(hang) process.on('SIGTERM', () => record('SIGTERM'));
record();
if(hang) setInterval(() => {}, 1000);
else if(command === 'list') setTimeout(() => {process.stdout.write(options.status ?? JSON.stringify({name:${JSON.stringify(managedSandboxProfile)},status:'Stopped'})+'\\n');process.exit(options.statusFailure ? 1 : 0);}, options.statusDelay ?? 0);
else process.exit(command === 'start' && options.startFailure ? 1 : 0);
`;
  await writeFile(binary, source, { mode: 0o700 });
  const instance = sandbox();
  Reflect.set(instance, 'root', root);
  Reflect.set(instance, 'tools', tools);
  Reflect.set(instance, 'vmHome', vm);
  Reflect.set(instance, 'started', true);
  // Real executable startup (including a cold host Node) is part of the budget;
  // leave time to install the TERM handler before exercising its deadline.
  Reflect.set(instance, 'processTimeouts', {
    start: 6_000,
    stop: 4_000,
    status: 4_000,
  });
  const steps: PreparationEvent[] = [];
  instance.onPreparationStep = (event) => steps.push(event);
  const observed = async () => {
    const rows = (await readFile(events, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Event);
    for (const row of rows) fixturePids.set(row.pid, binary);
    return rows;
  };
  const waitFor = async (command: string) => {
    for (let n = 0; n < 300; n++) {
      const found = (await observed()).find((row) => row.command === command);
      if (found) return found;
      await delay(10);
    }
    throw Error('Owned fixture failed to start');
  };
  return { root, tools, vm, binary, instance, steps, observed, waitFor };
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it('escalates only its TERM-ignoring stop child, observes exit, and independently confirms the private VM', async () => {
  const f = await fixture({ stopHang: true });
  const unrelated = spawn(
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)'],
    { stdio: 'ignore' },
  );
  extraChildren.push(unrelated);
  const before = performance.now();
  const stopping = f.instance.stop().catch((error) => error);
  const owned = await f.waitFor('stop');
  expect(await stopping).toBeUndefined();
  expect(performance.now() - before).toBeLessThan(8_000);
  const rows = await f.observed();
  expect(
    rows.some((row) => row.pid === owned.pid && row.signal === 'SIGTERM'),
  ).toBe(true);
  expect(alive(owned.pid)).toBe(false);
  expect(unrelated.exitCode).toBe(null);
  expect(unrelated.signalCode).toBe(null);
  expect(rows.find((row) => row.command === 'list')).toMatchObject({
    args: ['list', '--profile', managedSandboxProfile, '--json'],
    home: join(f.vm, 'c'),
    lima: join(f.vm, 'c', '_lima'),
  });
  expect(Reflect.get(f.instance, 'started')).toBe(false);
  expect(f.steps).toContainEqual({
    component: 'vm',
    step: 'vm_stop',
    state: 'failed',
  });
  expect(f.steps).toContainEqual({
    component: 'vm',
    step: 'vm_status',
    state: 'completed',
  });
}, 10_000);

it.each([
  [
    'running',
    JSON.stringify({ name: managedSandboxProfile, status: 'Running' }),
  ],
  [
    'unknown',
    JSON.stringify({ name: managedSandboxProfile, status: 'Unknown' }),
  ],
  ['broken', JSON.stringify({ name: managedSandboxProfile, status: 'Broken' })],
  ['other profile', JSON.stringify({ name: 'default', status: 'Stopped' })],
  [
    'duplicate',
    [1, 2]
      .map(() =>
        JSON.stringify({ name: managedSandboxProfile, status: 'Stopped' }),
      )
      .join('\n'),
  ],
  ['malformed', '{partial'],
])(
  'does not treat successful stop CLI exit as VM proof: %s',
  async (_name, status) => {
    const f = await fixture({ status });
    await expect(f.instance.stop()).rejects.toMatchObject({
      code: 'STOP_NOT_CONFIRMED',
    });
    expect(Reflect.get(f.instance, 'started')).toBe(true);
    expect((await f.observed()).map((row) => row.command)).toEqual([
      'stop',
      'list',
    ]);
  },
);

it('confirms an absent private profile only from a successful filtered list', async () => {
  const f = await fixture({ status: '' });
  await expect(f.instance.stop()).resolves.toBeUndefined();
  expect(Reflect.get(f.instance, 'started')).toBe(false);
  const failed = await fixture({ status: '', statusFailure: true });
  await expect(failed.instance.stop()).rejects.toMatchObject({
    code: 'STOP_NOT_CONFIRMED',
  });
  expect(Reflect.get(failed.instance, 'started')).toBe(true);
});

it('bounds a TERM-ignoring status child and retains the unconfirmed VM state', async () => {
  const f = await fixture({ statusHang: true });
  const result = f.instance.stop().catch((error) => error);
  const query = await f.waitFor('list');
  expect(await result).toMatchObject({ code: 'STOP_NOT_CONFIRMED' });
  expect(alive(query.pid)).toBe(false);
  expect(Reflect.get(f.instance, 'started')).toBe(true);
}, 10_000);

it('does not claim a VM stopped when its tool is missing after a start or with retained profile metadata', async () => {
  const f = await fixture();
  await rm(f.binary);
  await expect(f.instance.stop()).rejects.toMatchObject({
    code: 'STOP_NOT_CONFIRMED',
  });
  Reflect.set(f.instance, 'started', false);
  await mkdir(join(f.vm, 'c', '_lima', `colima-${managedSandboxProfile}`), {
    recursive: true,
  });
  await expect(f.instance.stop()).rejects.toMatchObject({
    code: 'STOP_NOT_CONFIRMED',
  });
  await rm(join(f.vm, 'c'), { recursive: true });
  await expect(f.instance.stop()).resolves.toBeUndefined();
});

function ownedStartup(f: Awaited<ReturnType<typeof fixture>>) {
  Reflect.set(f.instance, 'started', false);
  const launch = Reflect.get(f.instance, 'launchVM').bind(f.instance) as (
    binary: string,
    args: string[],
    signal: AbortSignal,
  ) => Promise<void>;
  vi.spyOn(
    f.instance as unknown as { startVM(signal: AbortSignal): Promise<void> },
    'startVM',
  ).mockImplementation((signal) =>
    launch(f.binary, ['start', '--profile', managedSandboxProfile], signal),
  );
  return vi.spyOn(f.instance.runner.api, 'json');
}

it.each([false, true])(
  'joins an already-owned VM flight when its wait observer cancels synchronously (cleanup unknown=%s)',
  async (unknown) => {
    const instance = sandbox(),
      abort = new AbortController();
    let finish!: () => void, fail!: (error: Error) => void;
    const flight = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const startup = vi
      .spyOn(
        instance as unknown as { startVM(signal: AbortSignal): Promise<void> },
        'startVM',
      )
      .mockReturnValue(flight);
    const inspect = vi.spyOn(instance.runner.api, 'json');
    instance.onPreparationStep = (event) => {
      if (event.step === 'vm_wait' && event.state === 'started') abort.abort();
    };
    let settled = false;
    const pending = instance
      .prepareNodeImage(abort.signal)
      .finally(() => {
        settled = true;
      })
      .catch((error) => error);
    await delay(0);
    expect(abort.signal.aborted).toBe(true);
    expect(startup).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    if (unknown) fail(new LocalCommandError('STOP_NOT_CONFIRMED'));
    else finish();
    expect(await pending).toMatchObject(
      unknown ? { code: 'STOP_NOT_CONFIRMED' } : { name: 'AbortError' },
    );
    expect(inspect).not.toHaveBeenCalled();
    expect(ports.download).not.toHaveBeenCalled();
  },
);

it('cancels a real TERM-ignoring owned start child, waits for stop/status cleanup, and never starts Node image work', async () => {
  const f = await fixture({ startHang: true, statusDelay: 100 });
  const inspect = ownedStartup(f),
    abort = new AbortController();
  const result = f.instance
    .prepareNodeImage(abort.signal)
    .catch((error) => error);
  const child = await f.waitFor('start');
  abort.abort(Error('fixture cancel'));
  expect(await result).toMatchObject({ message: 'fixture cancel' });
  expect(alive(child.pid)).toBe(false);
  const rows = await f.observed();
  expect(
    rows.some((row) => row.command === 'start' && row.signal === 'SIGTERM'),
  ).toBe(true);
  expect(rows.filter((row) => !row.signal).map((row) => row.command)).toEqual([
    'start',
    'stop',
    'list',
  ]);
  expect(inspect).not.toHaveBeenCalled();
  expect(ports.download).not.toHaveBeenCalled();
  expect(f.steps).toContainEqual({
    component: 'vm',
    step: 'vm_status',
    state: 'completed',
  });
});

it('preserves STOP_NOT_CONFIRMED rather than masking failed startup cleanup with cancellation', async () => {
  const f = await fixture({
    startHang: true,
    status: JSON.stringify({ name: managedSandboxProfile, status: 'Running' }),
  });
  const inspect = ownedStartup(f),
    abort = new AbortController();
  const result = f.instance
    .prepareNodeImage(abort.signal)
    .catch((error) => error);
  const child = await f.waitFor('start');
  abort.abort(Error('fixture cancel'));
  const error = await result;
  expect(error).toMatchObject({ code: 'STOP_NOT_CONFIRMED' });
  expect(error.cause).toBeInstanceOf(AggregateError);
  expect(alive(child.pid)).toBe(false);
  expect(inspect).not.toHaveBeenCalled();
  expect(f.instance.preparation.get('vm')).toMatchObject({
    stage: 'failed',
    reason: 'STOP_NOT_CONFIRMED',
  });
});

it('awaits independent cleanup for failed startup before rejecting the preparation', async () => {
  const f = await fixture({ startFailure: true, statusDelay: 150 });
  const inspect = ownedStartup(f);
  const before = performance.now();
  await expect(
    f.instance.prepareNodeImage(new AbortController().signal),
  ).rejects.toMatchObject({ code: 'NATIVE_VM_UNAVAILABLE' });
  expect(performance.now() - before).toBeGreaterThanOrEqual(150);
  expect((await f.observed()).map((row) => row.command)).toEqual([
    'start',
    'stop',
    'list',
  ]);
  expect(inspect).not.toHaveBeenCalled();
});

it('retains recovery after unobserved startup exit even when a later real profile query reports Stopped', async () => {
  const f = await fixture();
  ownedStartup(f);
  vi.spyOn(ownedProcess, 'runOwnedStopProcess').mockRejectedValueOnce(
    new ownedProcess.OwnedStopProcessExitUnconfirmed(undefined),
  );
  await expect(
    f.instance.prepareNodeImage(new AbortController().signal),
  ).rejects.toMatchObject({ code: 'STOP_NOT_CONFIRMED' });
  expect(Reflect.get(f.instance, 'ownedExitUnconfirmed')).toBe(true);
  expect(Reflect.get(f.instance, 'vmStartRequested')).toBe(true);
  await expect(f.instance.stop()).rejects.toMatchObject({
    code: 'STOP_NOT_CONFIRMED',
  });
  expect((await f.observed()).map((row) => row.command)).toEqual([
    'stop',
    'list',
    'stop',
    'list',
  ]);
});

it('passes the Node inspect signal and refuses its stale success or 404 after cancellation', async () => {
  for (const missing of [false, true]) {
    const instance = sandbox(),
      abort = new AbortController();
    const node = managedNodePayloadForPlatform(`macos-${process.arch}`)!;
    vi.spyOn(instance, 'prepareVM').mockResolvedValue();
    Reflect.set(instance, 'started', true);
    const inspect = vi
      .spyOn(instance.runner.api, 'json')
      .mockImplementation(async (_method, _path, _body, _timeout, signal) => {
        expect(signal).toBe(abort.signal);
        abort.abort(Error('node canceled'));
        if (missing) throw new LocalCommandError('DAEMON_HTTP_404');
        return {
          Id: node.imageId,
          Architecture: node.architecture,
          Os: 'linux',
        };
      });
    const load = vi.spyOn(instance.runner.api, 'loadImageArchive');
    await expect(instance.prepareNodeImage(abort.signal)).rejects.toThrow(
      'node canceled',
    );
    expect(inspect).toHaveBeenCalledOnce();
    expect(ports.download).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  }
});

it.each(['node', 'python'] as const)(
  'does not import a %s image when cancellation wins a download completion',
  async (component) => {
    const instance = sandbox(),
      abort = new AbortController();
    vi.spyOn(instance, 'prepareVM').mockResolvedValue();
    Reflect.set(instance, 'started', true);
    if (component === 'node')
      vi.spyOn(instance.runner.api, 'json').mockRejectedValue(
        new LocalCommandError('DAEMON_HTTP_404'),
      );
    else
      vi.spyOn(instance.runner, 'preflight').mockRejectedValue(
        new LocalCommandError('DAEMON_HTTP_404'),
      );
    ports.download.mockImplementation(async () => {
      abort.abort(Error('download canceled'));
    });
    const load = vi.spyOn(instance.runner.api, 'loadImageArchive');
    await expect(
      component === 'node'
        ? instance.prepareNodeImage(abort.signal)
        : instance.prepareManaged(abort.signal),
    ).rejects.toThrow('download canceled');
    expect(ports.download).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
    expect(instance.preparation.get(component)?.stage).toBe('failed');
  },
);

it('destroys its image stream on cancellation during Engine import and never performs the next inspect', async () => {
  const f = await fixture(),
    abort = new AbortController();
  const node = managedNodePayloadForPlatform(`macos-${process.arch}`)!;
  vi.spyOn(f.instance, 'prepareVM').mockResolvedValue();
  const inspect = vi
    .spyOn(f.instance.runner.api, 'json')
    .mockRejectedValue(new LocalCommandError('DAEMON_HTTP_404'));
  ports.download.mockImplementation(async () => {
    await mkdir(join(f.root, 'archives'), { mode: 0o700 });
    await writeFile(
      join(f.root, 'archives', node.archive.fileName),
      'isolated archive bytes',
    );
  });
  let imported: Readable | undefined;
  vi.spyOn(f.instance.runner.api, 'loadImageArchive').mockImplementation(
    async (stream, _size, signal) => {
      imported = stream;
      expect(signal).toBe(abort.signal);
      abort.abort(Error('import canceled'));
      // Model the Engine's initial socket await, before pipeline owns the stream.
      await delay(10);
      signal.throwIfAborted();
    },
  );
  await expect(f.instance.prepareNodeImage(abort.signal)).rejects.toThrow(
    'import canceled',
  );
  expect(imported?.destroyed).toBe(true);
  expect(inspect).toHaveBeenCalledOnce();
  expect(f.steps).toContainEqual({
    component: 'node',
    step: 'image_import',
    state: 'failed',
  });
});

it('forwards runner preparation events to the current observer and diagnostics cannot block cleanup', async () => {
  const f = await fixture();
  const observer = vi.fn();
  f.instance.onPreparationStep = observer;
  f.instance.runner.onPreparationStep?.({
    component: 'python',
    step: 'engine_info',
    state: 'started',
  });
  expect(observer).toHaveBeenCalledWith({
    component: 'python',
    step: 'engine_info',
    state: 'started',
  });
  f.instance.onPreparationStep = () => {
    throw Error('diagnostic only');
  };
  await expect(f.instance.stop()).resolves.toBeUndefined();
});
