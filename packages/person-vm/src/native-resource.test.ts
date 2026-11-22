import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import {
  PersonVmError,
  type PersonVmBinding,
  type PersonVmRuntimePort,
} from './contract.ts';
import {
  bootstrapMicrosandbox,
  spawnMicrosandboxManagedProbe,
} from './microsandbox-bootstrap.ts';
import {
  bootstrapPersonVm,
  type PersonVmBootstrapScope,
  type PersonVmJobExit,
  type PersonVmManagedJob,
  type PersonVmMemoryGuestPlan,
} from './guest-bootstrap.ts';
import type {
  PersonVmManagedProbeJob,
  PersonVmManagedProbePort,
} from './native-command-observer.ts';
import {
  createPersonVmGuestMemoryReader,
  PERSON_VM_GUEST_CONTROL_READER,
  type PersonVmGuestControlTarget,
} from './native-resource.ts';
import { hostEnvironment, runCommand } from './process.ts';

const binding: PersonVmBinding = {
  vmId: 'synthetic-vm',
  personId: 'synthetic-person',
  organizationId: 'synthetic-org',
  instanceId: 'synthetic-instance',
  leaseEpoch: 1,
};
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'met267-controls-')),
  );
  directories.push(root);
  const targets: PersonVmGuestControlTarget[] = [
    {
      target: 'commands',
      path: join(root, 'allrice-commands'),
      high: 768 * 1024 ** 2,
      max: 1280 * 1024 ** 2,
      swapMax: 2 * 1024 ** 3,
    },
    {
      target: 'dsh',
      path: join(root, 'allrice-dsh'),
      high: 'max',
      max: 'max',
      swapMax: 512 * 1024 ** 2,
    },
  ];
  for (const target of targets) {
    await mkdir(target.path);
    for (const [name, value] of [
      ['memory.high', target.high],
      ['memory.max', target.max],
      ['memory.swap.max', target.swapMax],
    ] as const)
      await writeFile(join(target.path, name), String(value) + '\n');
  }
  const cleanup = new AbortController();
  const stat = vi.fn((path: string) => fs.statSync(path, { bigint: true }));
  const fstat = vi.fn((fd: number) => fs.fstatSync(fd, { bigint: true }));
  const statfs = vi.fn((path: string) => ({
    ...fs.statfsSync(path, { bigint: true }),
    type: 0x63677270n,
  }));
  const captures: string[] = [];
  const jobs: PersonVmManagedProbeJob[] = [];
  const output = vi.fn(async (text: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    return text;
  });
  const makeJob = (
    text: string,
    overrides: Partial<PersonVmManagedProbeJob> = {},
  ): PersonVmManagedProbeJob => {
    const job: PersonVmManagedProbeJob = {
      binding,
      jobId: `synthetic-probe-${jobs.length}`,
      wait: vi.fn(async (signal: AbortSignal) => {
        signal.throwIfAborted();
        return { exitCode: 0, timedOut: false };
      }),
      stdout: vi.fn((signal: AbortSignal) => output(text, signal)),
      cancelAndWait: vi.fn(async (signal: AbortSignal) => {
        signal.throwIfAborted();
        return { exitCode: 137, timedOut: false };
      }),
      ...overrides,
    };
    jobs.push(job);
    return job;
  };
  const launch = vi.fn<PersonVmManagedProbePort['launch']>(async (spec) => {
    expect(spec.executable).toBe('/fixed-node/bin/node');
    expect(spec.args.slice(0, 2)).toEqual([
      '-e',
      PERSON_VM_GUEST_CONTROL_READER,
    ]);
    let text = '';
    // Deliberately synthetic cgroup2 provenance. All file contents/realpath/fds
    // are real fixture I/O; only statfs is replaced in this test VM context.
    // The production program has no bypass and requires the actual kernel fs.
    runInNewContext(PERSON_VM_GUEST_CONTROL_READER, {
      require: (name: string) =>
        name === 'node:fs'
          ? { ...fs, statSync: stat, fstatSync: fstat, statfsSync: statfs }
          : name === 'node:path'
            ? { posix }
            : undefined,
      process: {
        argv: ['node', spec.args[2]],
        stdout: {
          write: (value: string) => {
            text += value;
          },
        },
      },
    });
    captures.push(text);
    return makeJob(text);
  });
  const input = {
    binding,
    probes: { launch },
    nodeExecutable: '/fixed-node/bin/node',
    cleanupSignal: () => cleanup.signal,
    cgroupRoot: root,
    targets,
  };
  return {
    root,
    targets,
    launch,
    output,
    jobs,
    makeJob,
    cleanup,
    stat,
    fstat,
    statfs,
    captures,
    input,
    reader: createPersonVmGuestMemoryReader(input),
  };
}

describe('managed guest control reader (synthetic cgroup2/native sources; not physical RAM proof)', () => {
  it('reads actual controls, keeps the command 1.25GiB and DSH unlimited scopes, and never supplies a physical cap', async () => {
    const h = await fixture();
    const result = await h.reader.read(binding, new AbortController().signal);
    expect(result).toMatchObject({
      scope: 'guest-cgroup',
      boundary: 'guest-root-cooperative',
      state: 'verified',
    });
    expect(result.groups[0]).toMatchObject({
      target: 'commands',
      observed: {
        high: 768 * 1024 ** 2,
        max: 1280 * 1024 ** 2,
        swapMax: 2 * 1024 ** 3,
      },
    });
    expect(result.groups[1]).toMatchObject({
      target: 'dsh',
      observed: { high: 'max', max: 'max' },
    });
    expect(result).not.toHaveProperty('physical');
    expect(JSON.parse(h.launch.mock.calls[0]![0].args[2]!)).toEqual({
      cgroupRoot: h.root,
      targets: h.targets.map(({ target, path }) => ({ target, path })),
    });
    // Expectations are never sent to the probe as a fallback readback.
    expect(h.launch).toHaveBeenCalledOnce();
    expect(h.jobs[0]!.wait).toHaveBeenCalledOnce();
    expect(h.jobs[0]!.stdout).toHaveBeenCalledOnce();
    expect(await readFile(join(h.targets[1]!.path, 'memory.max'), 'utf8')).toBe(
      'max\n',
    );
  });

  it('missing whole-VM 2GiB controls stays unknown even when the command group readback succeeds', async () => {
    const h = await fixture();
    const reader = createPersonVmGuestMemoryReader({
      ...h.input,
      targets: [
        {
          target: 'vm-controls',
          path: h.root,
          high: 2 * 1024 ** 3,
          max: 2 * 1024 ** 3,
          swapMax: 2 * 1024 ** 3,
        },
        ...h.targets,
      ],
    });
    const result = await reader.read(binding, new AbortController().signal);
    expect(result.state).toBe('unknown');
    expect(result.groups[0]).toMatchObject({
      target: 'vm-controls',
      state: 'unknown',
      observed: null,
    });
    expect(result.groups[1]).toMatchObject({
      target: 'commands',
      state: 'verified',
      observed: { max: 1280 * 1024 ** 2 },
    });
    expect(result).not.toHaveProperty('physical');
  });

  it.each(['memory.high', 'memory.max', 'memory.swap.max'] as const)(
    'an actual mismatching %s rejects the readback rather than echoing expectations',
    async (file) => {
      const h = await fixture();
      await writeFile(join(h.targets[0]!.path, file), '123\n');
      const result = await h.reader.read(binding, new AbortController().signal);
      expect(result.state).toBe('unknown');
      expect(result.groups[0]?.reason).toBe('control-readback-mismatch');
      const field = {
        'memory.high': 'high',
        'memory.max': 'max',
        'memory.swap.max': 'swapMax',
      } as const;
      expect(result.groups[0]?.observed?.[field[file]]).toBe(123);
      expect(await readFile(join(h.targets[0]!.path, file), 'utf8')).toBe(
        '123\n',
      );
    },
  );

  it.each(['memory.high', 'memory.max', 'memory.swap.max'] as const)(
    'unreadable %s produces no configured/RSS/guest-physical replacement',
    async (file) => {
      const h = await fixture();
      await rm(join(h.targets[0]!.path, file));
      const result = await h.reader.read(binding, new AbortController().signal);
      expect(result.state).toBe('unknown');
      expect(result.groups[0]).toMatchObject({
        state: 'unknown',
        observed: null,
      });
      expect(result.groups[1]?.state).toBe('verified');
    },
  );

  it('revision is derived from actual resource readback, independent of lifecycle/admission cursors', async () => {
    const h = await fixture();
    const first = await h.reader.read(binding, new AbortController().signal);
    expect(
      (await h.reader.read(binding, new AbortController().signal)).revision,
    ).toBe(first.revision);
    await writeFile(join(h.targets[0]!.path, 'memory.max'), '123\n');
    const changed = await h.reader.read(binding, new AbortController().signal);
    expect(changed.revision).not.toBe(first.revision);
    expect(changed.state).toBe('unknown');
    expect(changed.evidenceRef).toContain(changed.revision);
  });

  it.each([
    'vmId',
    'personId',
    'organizationId',
    'instanceId',
    'leaseEpoch',
  ] as const)('different %s is refused before exec', async (field) => {
    const h = await fixture();
    await expect(
      h.reader.read(
        { ...binding, [field]: field === 'leaseEpoch' ? 2 : 'other' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(h.launch).not.toHaveBeenCalled();
  });

  it('failed or malformed public exec stays unknown; no configuration fallback', async () => {
    const h = await fixture();
    for (const output of [
      'not-json',
      JSON.stringify({ version: 1, scope: 'host-physical', groups: [] }),
      JSON.stringify({
        version: 1,
        scope: 'guest-cgroup',
        groups: [{ target: 'other' }, {}],
      }),
    ]) {
      h.output.mockResolvedValueOnce(output);
      const result = await h.reader.read(binding, new AbortController().signal);
      expect(result.state).toBe('unknown');
      expect(result.groups.every((group) => group.observed === null)).toBe(
        true,
      );
    }
    h.output.mockRejectedValueOnce(new Error('managed output unavailable'));
    expect(
      (await h.reader.read(binding, new AbortController().signal)).state,
    ).toBe('unknown');
  });

  it('cancellation preserves the reason only after late admission and exact guest cancel/wait join', async () => {
    const h = await fixture();
    const entered = gate(),
      joined = gate();
    const controller = new AbortController();
    const reason = new Error('cancel read');
    const admitted = gate();
    const cancelAndWait = vi.fn(async (signal: AbortSignal) => {
      expect(signal).toBe(h.cleanup.signal);
      expect(signal.aborted).toBe(false);
      await joined.promise;
      return { exitCode: 137, timedOut: false };
    });
    h.launch.mockImplementationOnce(async () => {
      entered.resolve();
      await admitted.promise;
      return h.makeJob('{}', { cancelAndWait });
    });
    const reading = h.reader.read(binding, controller.signal);
    const rejected = expect(reading).rejects.toBe(reason);
    let settled = false;
    void reading.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await entered.promise;
      controller.abort(reason);
      admitted.resolve();
      await setImmediate();
      expect(settled).toBe(false);
      expect(cancelAndWait).toHaveBeenCalledOnce();
      joined.resolve();
      await rejected;
    } finally {
      admitted.resolve();
      joined.resolve();
      await reading.catch(() => {});
    }
  });

  it('rejects a real ordinary filesystem even when every copied control matches', async () => {
    const h = await fixture();
    const request = JSON.stringify({
      cgroupRoot: h.root,
      targets: h.targets.map(({ target, path }) => ({ target, path })),
    });
    const text = await runCommand({
      executable: process.execPath,
      args: ['-e', PERSON_VM_GUEST_CONTROL_READER, request],
      env: hostEnvironment(h.root),
      signal: new AbortController().signal,
    });
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toMatchObject({
      groups: h.targets.map(({ target, path }) => ({
        target,
        path,
        error: 'not-cgroup2',
      })),
    });
    h.output.mockResolvedValueOnce(text);
    const result = await h.reader.read(binding, new AbortController().signal);
    expect(result.state).toBe('unknown');
    expect(result.groups.every((group) => group.observed === null)).toBe(true);
    for (const target of h.targets)
      expect(await readFile(join(target.path, 'memory.max'), 'utf8')).toBe(
        String(target.max) + '\n',
      );
  });

  it.each(['inside-root', 'outside-root', 'control-file'] as const)(
    'rejects %s symlink redirection with matching copied controls',
    async (kind) => {
      const h = await fixture();
      const target = h.targets[0]!;
      if (kind === 'control-file') {
        const shadow = join(h.root, 'copied-max');
        await writeFile(shadow, String(target.max));
        await rm(join(target.path, 'memory.max'));
        await symlink(shadow, join(target.path, 'memory.max'));
      } else {
        let destination = target.path;
        if (kind === 'outside-root') {
          destination = await realpath(
            await mkdtemp(join(tmpdir(), 'met267-outside-')),
          );
          directories.push(destination);
          for (const name of ['memory.high', 'memory.max', 'memory.swap.max'])
            await writeFile(
              join(destination, name),
              await readFile(join(target.path, name)),
            );
        }
        const alias = join(h.root, 'redirected-commands');
        await symlink(destination, alias);
        h.targets[0] = { ...target, path: alias };
      }
      const reader = createPersonVmGuestMemoryReader({
        ...h.input,
        targets: h.targets,
      });
      const result = await reader.read(binding, new AbortController().signal);
      expect(result.groups[0]).toMatchObject({
        state: 'unknown',
        observed: null,
      });
      expect(result.groups[1]?.state).toBe('verified');
    },
  );

  it.each([
    'target-filesystem',
    'target-device',
    'directory-inode',
    'control-inode',
  ] as const)('rejects %s changes during a read', async (kind) => {
    const h = await fixture();
    const target = h.targets[0]!;
    if (kind === 'target-filesystem')
      h.statfs.mockImplementation((path) => ({
        ...fs.statfsSync(path, { bigint: true }),
        type: path === target.path ? 0n : 0x63677270n,
      }));
    let directoryReads = 0;
    h.stat.mockImplementation((path) => {
      const stat = fs.statSync(path, { bigint: true });
      if (path === target.path) {
        directoryReads++;
        if (kind === 'target-device') stat.dev += 1n;
        if (kind === 'directory-inode' && directoryReads >= 2) stat.ino += 1n;
      }
      return stat;
    });
    // The production fd read is still real. Only an explicit test replacement
    // changes the file's reported identity between its first/second read.
    if (kind === 'control-inode') {
      let reads = 0;
      h.fstat.mockImplementation((fd) => {
        const stat = fs.fstatSync(fd, { bigint: true });
        if (++reads >= 4) stat.ino += 1n;
        return stat;
      });
    }
    const result = await h.reader.read(binding, new AbortController().signal);
    expect(result.groups[0]).toMatchObject({
      state: 'unknown',
      observed: null,
    });
  });

  it.each([null, {}, 7, '01', '-1', '9007199254740992'])(
    'treats parsed control value %s as unknown instead of an implicit any',
    async (invalid) => {
      const h = await fixture();
      h.output.mockResolvedValueOnce(
        JSON.stringify({
          version: 1,
          scope: 'guest-cgroup',
          groups: h.targets.map((target, index) => ({
            target: target.target,
            path: target.path,
            device: '1',
            inode: '1',
            values: [
              index === 0 ? invalid : String(target.high),
              String(target.max),
              String(target.swapMax),
            ],
          })),
        }),
      );
      const result = await h.reader.read(binding, new AbortController().signal);
      expect(result.groups[0]).toMatchObject({
        state: 'unknown',
        observed: null,
      });
      expect(result.groups[1]?.state).toBe('verified');
    },
  );

  it('available captured output cannot finish a read before managed guest wait joins', async () => {
    const h = await fixture();
    const entered = gate(),
      joined = gate();
    const launch = h.launch.getMockImplementation()!;
    h.launch.mockImplementationOnce(async (...args) => {
      const job = await launch(...args);
      return {
        ...job,
        wait: async () => {
          entered.resolve();
          await joined.promise;
          return { exitCode: 0, timedOut: false };
        },
      };
    });
    let settled = false;
    const reading = h.reader
      .read(binding, new AbortController().signal)
      .then((result) => {
        settled = true;
        return result;
      });
    try {
      await entered.promise;
      expect(h.captures[0]).toContain('guest-cgroup');
      await setImmediate();
      expect(settled).toBe(false);
      expect(h.output).not.toHaveBeenCalled();
      joined.resolve();
      expect((await reading).state).toBe('verified');
    } finally {
      joined.resolve();
      await reading.catch(() => {});
    }
  });

  it('wait failure cancels the exact guest and holds the read until confirmed cleanup wait', async () => {
    const h = await fixture();
    const entered = gate(),
      joined = gate();
    const cancelAndWait = vi.fn(async (signal: AbortSignal) => {
      expect(signal).toBe(h.cleanup.signal);
      entered.resolve();
      await joined.promise;
      return { exitCode: 137, timedOut: false };
    });
    const job = h.makeJob('{}', {
      wait: async () => {
        throw new Error('guest wait connection lost');
      },
      cancelAndWait,
    });
    h.launch.mockResolvedValueOnce(job);
    let settled = false;
    const reading = h.reader
      .read(binding, new AbortController().signal)
      .then((result) => {
        settled = true;
        return result;
      });
    try {
      await entered.promise;
      await setImmediate();
      expect(settled).toBe(false);
      expect(job.stdout).not.toHaveBeenCalled();
      joined.resolve();
      expect((await reading).state).toBe('unknown');
      expect(cancelAndWait).toHaveBeenCalledOnce();
    } finally {
      joined.resolve();
      await reading.catch(() => {});
    }
  });

  it.each([
    { exitCode: 1, timedOut: false },
    { exitCode: 0, timedOut: true },
  ])(
    'confirmed non-success probe %s never supplies control evidence',
    async (exit) => {
      const h = await fixture();
      const job = h.makeJob('{}', { wait: async () => exit });
      h.launch.mockResolvedValueOnce(job);
      const result = await h.reader.read(binding, new AbortController().signal);
      expect(result.state).toBe('unknown');
      expect(result.groups.every((group) => group.observed === null)).toBe(
        true,
      );
      expect(job.stdout).not.toHaveBeenCalled();
      expect(job.cancelAndWait).not.toHaveBeenCalled();
    },
  );

  it('cleanup failure is retained for the owner instead of ordinary unknown or abort', async () => {
    const h = await fixture();
    const entered = gate();
    const cancel = new AbortController();
    const reason = new Error('read cancelled');
    const cleanupError = new Error('guest completion unconfirmed');
    const cancelAndWait = vi.fn(async () => {
      throw cleanupError;
    });
    h.launch.mockResolvedValueOnce(
      h.makeJob('{}', {
        wait: async (signal) => {
          entered.resolve();
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          signal.throwIfAborted();
          return { exitCode: 0, timedOut: false };
        },
        cancelAndWait,
      }),
    );
    const reading = h.reader.read(binding, cancel.signal);
    const assertion = expect(reading).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
      cause: expect.objectContaining({ errors: [reason, cleanupError] }),
    });
    await entered.promise;
    cancel.abort(reason);
    await assertion;
    expect(cancelAndWait).toHaveBeenCalledOnce();
  });

  it('unconfirmed launch and foreign-epoch handle are explicit owner recovery failures', async () => {
    const h = await fixture();
    h.launch.mockRejectedValueOnce(new Error('admission acknowledgement lost'));
    await expect(
      h.reader.read(binding, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
    const foreign = h.makeJob('{}', { binding: { ...binding, leaseEpoch: 2 } });
    h.launch.mockResolvedValueOnce(foreign);
    await expect(
      h.reader.read(binding, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
    expect(foreign.wait).not.toHaveBeenCalled();
    expect(foreign.cancelAndWait).not.toHaveBeenCalled();
  });

  it('cleanup can reenter a separate read without losing either exact guest owner', async () => {
    const h = await fixture();
    const entered = gate(),
      joined = gate();
    let reenteredState: string | undefined;
    const cancelAndWait = vi.fn(async () => {
      try {
        reenteredState = (
          await h.reader.read(binding, new AbortController().signal)
        ).state;
      } finally {
        entered.resolve();
      }
      await joined.promise;
      return { exitCode: 137, timedOut: false };
    });
    h.launch.mockResolvedValueOnce(
      h.makeJob('{}', {
        wait: async () => {
          throw new Error('first wait lost');
        },
        cancelAndWait,
      }),
    );
    const first = h.reader.read(binding, new AbortController().signal);
    try {
      await entered.promise;
      expect(reenteredState).toBe('verified');
      expect(h.launch).toHaveBeenCalledTimes(2);
      expect(h.jobs[1]!.cancelAndWait).not.toHaveBeenCalled();
      joined.resolve();
      expect((await first).state).toBe('unknown');
      expect(cancelAndWait).toHaveBeenCalledOnce();
    } finally {
      joined.resolve();
      await first.catch(() => {});
    }
  });
});

/** Calls the actual extracted executor; only the public CLI transport and
 * lifecycle authority are synthetic. No guest/VM execution or new executor. */
function managedProtocol() {
  const scopeAbort = new AbortController(),
    cleanup = new AbortController();
  const name = 'synthetic-native-sandbox',
    jobId = 'synthetic-retained-probe';
  const output = '{"version":1,"retained":"fast-probe"}';
  let current = true;
  const lost = new PersonVmError('LEASE_LOST');
  const assertCurrent = vi.fn(async () => {
    if (!current) throw lost;
  });
  const scope = { binding, signal: scopeAbort.signal, assertCurrent };
  const raw = (args: string[]) => {
    if (args[0] === 'exec') return jobId + '\n';
    if (args[0] === 'wait')
      return JSON.stringify({ code: 137, success: false, timed_out: false });
    if (args[0] === 'kill') return '';
    if (args[0] === 'logs')
      return (
        [output.slice(0, 13), output.slice(13)]
          .map((d) => JSON.stringify({ id: jobId, s: 'stdout', e: null, d }))
          .join('\n') + '\n'
      );
    throw new Error('unexpected synthetic public CLI operation');
  };
  const command = vi.fn<
    Parameters<typeof spawnMicrosandboxManagedProbe>[0]['command']
  >(async (args, signal) => {
    signal.throwIfAborted();
    return raw(args);
  });
  const spec = {
    executable: '/fixed-node/bin/node',
    args: ['-e', 'process.stdout.write("synthetic")'],
    env: { SYNTHETIC: 'value with spaces' },
    workdir: '/workspace',
  };
  return {
    name,
    jobId,
    output,
    command,
    spec,
    scope,
    scopeAbort,
    assertCurrent,
    cleanup,
    raw,
    lost,
    loseAuthority: () => {
      current = false;
    },
    revoke: (reason: unknown) => {
      current = false;
      scopeAbort.abort(reason);
    },
    launch: () =>
      spawnMicrosandboxManagedProbe(
        { scope, name, cleanupTimeoutMs: 10_000, command },
        spec,
      ),
  };
}

describe('extracted managed probe public protocol (synthetic transport, not VM acceptance)', () => {
  it('uses exact detached job/wait and retained stdout logs, including a probe which exited before reading', async () => {
    const h = managedProtocol();
    const job = await h.launch();
    expect(job.binding).toEqual(binding);
    expect(job.jobId).toBe(h.jobId);
    expect(h.command.mock.calls[0]).toEqual([
      [
        'exec',
        h.name,
        '--detach',
        '--no-stdin',
        '--no-tty',
        '--env',
        'SYNTHETIC=value with spaces',
        '--workdir',
        '/workspace',
        '--',
        h.spec.executable,
        ...h.spec.args,
      ],
      h.scope.signal,
    ]);
    const caller = new AbortController();
    expect(await job.wait(caller.signal)).toEqual({
      exitCode: 137,
      timedOut: false,
    });
    expect(await job.stdout(caller.signal)).toBe(h.output);
    expect(h.command.mock.calls[1]).toEqual([
      ['wait', h.name, '--job', h.jobId, '--format', 'json'],
      expect.any(AbortSignal),
      true,
    ]);
    expect(h.command.mock.calls[2]).toEqual([
      ['logs', h.name, '--job', h.jobId, '--source', 'stdout', '--json'],
      expect.any(AbortSignal),
    ]);
    expect(h.command.mock.calls.map(([args]) => args[0])).toEqual([
      'exec',
      'wait',
      'logs',
    ]);
    expect(h.assertCurrent).toHaveBeenCalledTimes(6); // Before/after launch, wait, stdout.
  });

  it.each(['wait', 'stdout'] as const)(
    'revocation after launch blocks ordinary %s but not exact independent cleanup',
    async (operation) => {
      const h = managedProtocol();
      const job = await h.launch();
      const reason = new Error('owner revoked after launch');
      h.revoke(reason);
      await expect(job[operation](new AbortController().signal)).rejects.toBe(
        reason,
      );
      expect(h.command).toHaveBeenCalledOnce();
      const assertions = h.assertCurrent.mock.calls.length;
      expect(await job.cancelAndWait(h.cleanup.signal)).toEqual({
        exitCode: 137,
        timedOut: false,
      });
      expect(h.command.mock.calls.slice(1)).toEqual([
        [['kill', h.name, '--job', h.jobId], h.cleanup.signal],
        [
          ['wait', h.name, '--job', h.jobId, '--format', 'json'],
          h.cleanup.signal,
          true,
        ],
      ]);
      expect(h.assertCurrent).toHaveBeenCalledTimes(assertions);
      expect(h.cleanup.signal.aborted).toBe(false);
    },
  );

  it.each([
    ['wait', 'scope'],
    ['stdout', 'scope'],
    ['wait', 'caller'],
    ['stdout', 'caller'],
  ] as const)(
    '%s observes %s cancellation and waits for transport settlement',
    async (operation, owner) => {
      const h = managedProtocol();
      const job = await h.launch();
      const entered = gate(),
        settledTransport = gate(),
        caller = new AbortController();
      const reason = new Error('owner revoked during native operation');
      let running: AbortSignal | undefined;
      h.command.mockImplementationOnce(async (args, signal) => {
        running = signal;
        entered.resolve();
        await settledTransport.promise; // Deliberately ignores abort until joined.
        return h.raw(args);
      });
      const pending = job[operation](caller.signal);
      const rejected = expect(pending).rejects.toBe(reason);
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await entered.promise;
        if (owner === 'scope') h.revoke(reason);
        else caller.abort(reason);
        expect(running?.aborted).toBe(true);
        expect(caller.signal.aborted).toBe(owner === 'caller');
        expect(h.scope.signal.aborted).toBe(owner === 'scope');
        await setImmediate();
        expect(settled).toBe(false);
        settledTransport.resolve();
        await rejected;
        expect(await job.cancelAndWait(h.cleanup.signal)).toEqual({
          exitCode: 137,
          timedOut: false,
        });
      } finally {
        settledTransport.resolve();
        await pending.catch(() => {});
      }
    },
  );

  it.each(['wait', 'stdout'] as const)(
    'authority lost just before %s returns rejects retained output even without a signal event',
    async (operation) => {
      const h = managedProtocol();
      const job = await h.launch();
      h.command.mockImplementationOnce(async (args) => {
        const result = h.raw(args);
        h.loseAuthority();
        return result;
      });
      await expect(job[operation](new AbortController().signal)).rejects.toBe(
        h.lost,
      );
      expect(h.scope.signal.aborted).toBe(false);
      const assertions = h.assertCurrent.mock.calls.length;
      await job.cancelAndWait(h.cleanup.signal);
      expect(h.assertCurrent).toHaveBeenCalledTimes(assertions);
    },
  );

  it.each(['wait', 'stdout'] as const)(
    'checks abort again after the final %s authority assertion settles',
    async (operation) => {
      const h = managedProtocol();
      const job = await h.launch();
      const reason = new Error('revoked while final fence settled');
      h.assertCurrent
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(async () => {
          h.scopeAbort.abort(reason);
        });
      await expect(job[operation](new AbortController().signal)).rejects.toBe(
        reason,
      );
      await job.cancelAndWait(h.cleanup.signal);
    },
  );

  it('retains a late launch handle after revocation and cannot reject before exact independent cleanup wait joins', async () => {
    const h = managedProtocol();
    const entered = gate(),
      admitted = gate(),
      cleanupEntered = gate(),
      joined = gate();
    const reason = new Error('revoked during dispatch');
    h.command.mockImplementation(async (args, signal) => {
      if (args[0] === 'exec') {
        entered.resolve();
        await admitted.promise;
        return h.raw(args);
      }
      expect(signal).not.toBe(h.scope.signal);
      expect(signal.aborted).toBe(false);
      if (args[0] === 'wait') {
        cleanupEntered.resolve();
        await joined.promise;
      }
      return h.raw(args);
    });
    const launching = h.launch();
    const rejected = expect(launching).rejects.toBe(reason);
    let settled = false;
    void launching.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await entered.promise;
      h.revoke(reason);
      admitted.resolve();
      await cleanupEntered.promise;
      await setImmediate();
      expect(settled).toBe(false);
      expect(h.command.mock.calls.map(([args]) => args[0])).toEqual([
        'exec',
        'kill',
        'wait',
      ]);
      expect(h.command.mock.calls[1]![0]).toEqual([
        'kill',
        h.name,
        '--job',
        h.jobId,
      ]);
      expect(h.command.mock.calls[2]![0]).toEqual([
        'wait',
        h.name,
        '--job',
        h.jobId,
        '--format',
        'json',
      ]);
      joined.resolve();
      await rejected;
    } finally {
      admitted.resolve();
      joined.resolve();
      await launching.catch(() => {});
    }
  });

  it('uses the cleanup completion certificate even if kill refuses, and reports a failed exact wait', async () => {
    const h = managedProtocol();
    const job = await h.launch();
    h.revoke(new Error('owner ended'));
    h.command.mockRejectedValueOnce(new Error('already exited'));
    expect(await job.cancelAndWait(h.cleanup.signal)).toEqual({
      exitCode: 137,
      timedOut: false,
    });
    h.command
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(
        JSON.stringify({ code: 137, success: true, timed_out: false }),
      );
    await expect(job.cancelAndWait(h.cleanup.signal)).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
  });

  it.each(['wrong-job', 'stderr', 'base64', 'malformed'] as const)(
    'rejects %s retained logs rather than pretending complete stdout',
    async (failure) => {
      const h = managedProtocol();
      const job = await h.launch();
      h.command.mockResolvedValueOnce(
        failure === 'malformed'
          ? 'not-json'
          : JSON.stringify({
              id: failure === 'wrong-job' ? 'another-job' : h.jobId,
              s: failure === 'stderr' ? 'stderr' : 'stdout',
              e: failure === 'base64' ? 'b64' : null,
              d: h.output,
            }),
      );
      await expect(job.stdout(new AbortController().signal)).rejects.toThrow();
      expect(h.command.mock.calls[1]![0]).toEqual([
        'logs',
        h.name,
        '--job',
        h.jobId,
        '--source',
        'stdout',
        '--json',
      ]);
    },
  );
});

const retainedBootstrapPlan = (): PersonVmMemoryGuestPlan => ({
  files: [
    {
      path: '/work/memory/initialize.cjs',
      contents: '// synthetic initialization artifact',
      mode: 0o600,
    },
    {
      path: '/work/memory/launcher',
      contents: '#!/bin/sh\nexec "$@"\n',
      mode: 0o700,
    },
  ],
  initialize: { executable: 'node', args: ['/work/memory/initialize.cjs'] },
  launcher: '/work/memory/launcher',
  env: { SYNTHETIC_MEMORY_PLAN: 'explicit' },
});
const bootstrapStage = async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'met267-retained-bootstrap-')),
  );
  directories.push(root);
  return root;
};

describe('bootstrap retained jobs and operation-scoped probes share the real executor kernel', () => {
  it.each(['during-startup', 'after-startup'] as const)(
    'retained wait started %s outlives actual bootstrap scope closure, while stale probes reject and independently join cleanup',
    async (phase) => {
      const stagingRoot = await bootstrapStage(),
        name = 'synthetic-native-sandbox';
      const startup = new AbortController(),
        lifetime = new AbortController(),
        cleanup = new AbortController();
      const retainedDone = gate(),
        probeDone = gate(),
        probeCleanupEntered = gate();
      const jobs = new Map<
        string,
        { role: 'setup' | 'retained' | 'probe'; killed: boolean }
      >();
      let retained: PersonVmManagedJob | undefined,
        probe: PersonVmManagedProbeJob | undefined;
      let starting: PersonVmBootstrapScope | undefined,
        retainedSignal: AbortSignal | undefined;
      let completion:
        | Promise<
            | { state: 'exit'; exit: PersonVmJobExit }
            | { state: 'lost'; cause: unknown }
          >
        | undefined;
      let cleanupPending: Promise<PersonVmJobExit> | undefined;
      let completed = false,
        cleanupJoined = false;
      const waitFor = async (
        done: ReturnType<typeof gate>,
        signal: AbortSignal,
        code: number,
      ) => {
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const aborted = () => {
            signal.removeEventListener('abort', aborted);
            reject(signal.reason);
          };
          signal.addEventListener('abort', aborted, { once: true });
          void done.promise.then(() => {
            signal.removeEventListener('abort', aborted);
            resolve();
          });
          if (signal.aborted) aborted();
        });
        signal.throwIfAborted();
        return JSON.stringify({ code, success: code === 0, timed_out: false });
      };
      const command = vi.fn<
        Parameters<typeof spawnMicrosandboxManagedProbe>[0]['command']
      >(async (args, signal) => {
        signal.throwIfAborted();
        if (args[0] === 'cp') return '';
        if (args[0] === 'exec') {
          const role = args.includes('/bin/retained-dsh')
            ? 'retained'
            : args.includes('/fixed-node/bin/node')
              ? 'probe'
              : 'setup';
          const id = `synthetic-${role}-${jobs.size}`;
          jobs.set(id, { role, killed: false });
          return id + '\n';
        }
        const id = args[args.indexOf('--job') + 1]!;
        const job = jobs.get(id);
        if (!job) throw new Error('unknown exact public job');
        if (args[0] === 'kill') {
          job.killed = true;
          return '';
        }
        if (args[0] === 'wait') {
          if (job.role === 'setup')
            return JSON.stringify({ code: 0, success: true, timed_out: false });
          if (job.role === 'retained') {
            retainedSignal = signal;
            return waitFor(retainedDone, signal, 37);
          }
          expect(job.killed).toBe(true);
          expect(signal).toBe(cleanup.signal);
          probeCleanupEntered.resolve();
          return waitFor(probeDone, signal, 137);
        }
        throw new Error('ordinary stale probe must not reach public logs');
      });
      const beginWait = (job: PersonVmManagedJob) =>
        job.wait(lifetime.signal).then(
          (exit) => {
            completed = true;
            return { state: 'exit' as const, exit };
          },
          (cause: unknown) => {
            completed = true;
            return { state: 'lost' as const, cause };
          },
        );
      const runtime: PersonVmRuntimePort = {
        memoryGuestPlan: async () => retainedBootstrapPlan(),
        start: async (_binding, _signal, scope) => {
          starting = scope;
          retained = await scope.launch({
            executable: '/bin/retained-dsh',
            args: ['--synthetic'],
          });
          if (phase === 'during-startup') completion = beginWait(retained);
          probe = await spawnMicrosandboxManagedProbe(
            { scope, name, cleanupTimeoutMs: 10_000, command },
            { executable: '/fixed-node/bin/node', args: ['-e', '0'] },
          );
        },
        activity: async () => {
          throw new Error('unexpected activity');
        },
        readiness: async () => {
          throw new Error('unexpected readiness');
        },
      };
      try {
        await bootstrapPersonVm({
          binding,
          signal: startup.signal,
          assertCurrent: async () => {},
          runtime,
          native: {
            bootstrap: (scope, plan) =>
              bootstrapMicrosandbox({
                scope,
                plan,
                stagingRoot,
                name,
                cleanupTimeoutMs: 10_000,
                command,
              }),
          },
        });
        if (!starting || !retained || !probe)
          throw new Error('bootstrap did not hand off native jobs');
        expect(starting.signal.aborted).toBe(true); // Closed by actual bootstrapPersonVm finally.
        expect(startup.signal.aborted).toBe(false);
        expect(retained).not.toHaveProperty('stdout');
        if (phase === 'after-startup') completion = beginWait(retained);
        startup.abort(
          new Error('startup budget ended after successful handoff'),
        );
        await setImmediate();
        expect(retainedSignal).toBe(lifetime.signal);
        expect(retainedSignal?.aborted).toBe(false);
        expect(completed).toBe(false);
        await expect(probe.wait(new AbortController().signal)).rejects.toBe(
          starting.signal.reason,
        );
        await expect(probe.stdout(new AbortController().signal)).rejects.toBe(
          starting.signal.reason,
        );
        expect(command.mock.calls.some(([args]) => args[0] === 'logs')).toBe(
          false,
        );
        cleanupPending = probe.cancelAndWait(cleanup.signal);
        void cleanupPending.then(
          () => {
            cleanupJoined = true;
          },
          () => {
            cleanupJoined = true;
          },
        );
        await Promise.race([
          probeCleanupEntered.promise,
          cleanupPending.then(() => {
            throw new Error('cleanup resolved without entering exact wait');
          }),
        ]);
        await setImmediate();
        expect(cleanupJoined).toBe(false);
        expect(completed).toBe(false);
        expect(
          command.mock.calls
            .filter(([args]) => args[0] === 'kill')
            .map(([args]) => args),
        ).toEqual([['kill', name, '--job', probe.jobId]]);
        probeDone.resolve();
        expect(await cleanupPending).toEqual({
          exitCode: 137,
          timedOut: false,
        });
        expect(completed).toBe(false);
        retainedDone.resolve();
        expect(await completion).toEqual({
          state: 'exit',
          exit: { exitCode: 37, timedOut: false },
        });
        expect(jobs.get(retained.jobId)?.killed).toBe(false);
        expect(
          command.mock.calls
            .filter(([args]) => args[0] === 'wait')
            .every((call) => call[2] === true),
        ).toBe(true);
      } finally {
        retainedDone.resolve();
        probeDone.resolve();
        await completion;
        await cleanupPending?.catch(() => {});
      }
    },
  );

  it.each(['lost-id', 'dispatch-rejection'] as const)(
    'preserves bootstrap %s error classification while probe ambiguity stays CLEANUP_INCOMPLETE',
    async (failure) => {
      const h = managedProtocol(),
        stagingRoot = await bootstrapStage();
      const cause = new PersonVmError('PROVIDER_FAILED');
      if (failure === 'lost-id') h.command.mockResolvedValueOnce('');
      else h.command.mockRejectedValueOnce(cause);
      const bootstrapping = bootstrapMicrosandbox({
        scope: h.scope,
        plan: retainedBootstrapPlan(),
        stagingRoot,
        name: h.name,
        cleanupTimeoutMs: 10_000,
        command: h.command,
      });
      if (failure === 'lost-id')
        await expect(bootstrapping).rejects.toMatchObject({
          code: 'PROVIDER_FAILED',
        });
      else await expect(bootstrapping).rejects.toBe(cause);
      expect(h.command).toHaveBeenCalledOnce();
      if (failure === 'lost-id') h.command.mockResolvedValueOnce('');
      else h.command.mockRejectedValueOnce(cause);
      await expect(h.launch()).rejects.toMatchObject({
        code: 'CLEANUP_INCOMPLETE',
      });
      expect(h.command).toHaveBeenCalledTimes(2);
    },
  );
});
