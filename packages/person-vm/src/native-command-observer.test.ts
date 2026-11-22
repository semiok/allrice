import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { PersonVmBinding } from './contract.ts';
import type { PersonVmManagedJob } from './guest-bootstrap.ts';
import {
  createPersonVmCommandMemoryObserver,
  PERSON_VM_COMMAND_MEMORY_PROGRAM,
  type PersonVmManagedProbeJob,
  type PersonVmManagedProbePort,
} from './native-command-observer.ts';
import { hostEnvironment, runCommand } from './process.ts';

const binding: PersonVmBinding = {
  vmId: 'synthetic-vm',
  personId: 'synthetic-person',
  organizationId: 'synthetic-org',
  instanceId: 'synthetic-instance',
  leaseEpoch: 1,
};
const cfg = {
  cgroupRoot: '/sys/fs/cgroup',
  commandsGroup: '/sys/fs/cgroup/commands',
  dshGroup: '/sys/fs/cgroup/dsh',
  procRoot: '/proc',
  receiptDirectory: '/memory/receipts',
  executionRef: 'synthetic-execution',
  pid: 41,
};
const childPath = `${cfg.commandsGroup}/command-${cfg.pid}`;
const receiptPath = `${cfg.receiptDirectory}/${cfg.executionRef}.json`;
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

/** Explicit synthetic cgroup2/proc replacement. Positive execution of the fixed
 * program here proves parser/identity logic, never a real kernel source. */
function guest() {
  const directories = new Set([
    cfg.cgroupRoot,
    cfg.commandsGroup,
    cfg.dshGroup,
    cfg.procRoot,
    cfg.receiptDirectory,
    `${cfg.procRoot}/${cfg.pid}`,
    childPath,
  ]);
  const files = new Map<string, string>([
    [
      `${cfg.procRoot}/sys/kernel/random/boot_id`,
      '12345678-1234-1234-1234-123456789abc',
    ],
    [
      `${cfg.procRoot}/${cfg.pid}/stat`,
      `${cfg.pid} (synthetic command) ${['S', ...Array<string>(18).fill('0'), '1234'].join(' ')}`,
    ],
    [`${cfg.procRoot}/${cfg.pid}/cgroup`, '0::/dsh'],
    [`${childPath}/cgroup.procs`, ''],
    [`${childPath}/cgroup.events`, 'populated 0\nfrozen 0'],
    [
      `${childPath}/memory.events`,
      'low 0\nhigh 0\nmax 0\noom 4\noom_kill 2\noom_group_kill 0',
    ],
    [`${cfg.commandsGroup}/memory.events`, 'oom 999\noom_kill 999'],
  ]);
  const reads: string[] = [];
  const descriptors = new Map<number, string>();
  const aliases = new Map<string, string>();
  let next = 10;
  let inode = 27n;
  let cgroupType = 0x63677270n;
  let cleanupFails = false;
  const missing = () =>
    Object.assign(new Error('synthetic missing file'), { code: 'ENOENT' });
  const stat = (p: string) => {
    if (!directories.has(p) && !files.has(p)) throw missing();
    return {
      dev: p.startsWith(cfg.cgroupRoot) ? 5n : 7n,
      ino: p === childPath ? inode : 1n,
      isDirectory: () => directories.has(p),
      isFile: () => files.has(p),
    };
  };
  const fs = {
    constants: {
      O_RDONLY: 0,
      O_WRONLY: 1,
      O_NOFOLLOW: 2,
      O_TRUNC: 4,
      O_NONBLOCK: 8,
    },
    realpathSync: (p: string) => {
      stat(p);
      return aliases.get(p) ?? p;
    },
    statSync: stat,
    statfsSync: (p: string) => ({
      type: p === cfg.procRoot ? 0x9fa0n : cgroupType,
    }),
    openSync: (p: string) => {
      stat(p);
      const fd = next++;
      descriptors.set(fd, p);
      return fd;
    },
    fstatSync: (fd: number) => stat(descriptors.get(fd)!),
    closeSync: (fd: number) => descriptors.delete(fd),
    readFileSync: (fd: number) => {
      const p = descriptors.get(fd)!;
      reads.push(p);
      if (!files.has(p)) throw missing();
      return files.get(p)!;
    },
    writeFileSync: (
      p: string | number,
      contents: string,
      options?: { flag?: string },
    ) => {
      const target = typeof p === 'number' ? descriptors.get(p)! : p;
      if (options?.flag === 'wx' && files.has(target))
        throw new Error('synthetic receipt exists');
      files.set(target, contents);
    },
    rmdirSync: (p: string) => {
      if (
        cleanupFails ||
        p !== childPath ||
        files.get(`${p}/cgroup.procs`) ||
        files.get(`${p}/cgroup.events`) !== 'populated 0\nfrozen 0'
      )
        throw new Error('synthetic child cleanup failed');
      directories.delete(p);
      for (const key of files.keys())
        if (key.startsWith(p + '/')) files.delete(key);
    },
    unlinkSync: (p: string) => {
      if (p !== receiptPath || !files.delete(p)) throw missing();
    },
  };
  const run = (
    phase: 'baseline' | 'admitted' | 'complete' | 'complete-and-release',
  ) => {
    let output = '';
    const process = {
      pid: 99,
      argv: ['node', JSON.stringify(cfg), phase],
      stdout: {
        write: (text: string) => {
          output += text;
        },
      },
      exitCode: 0,
    };
    runInNewContext(PERSON_VM_COMMAND_MEMORY_PROGRAM, {
      process,
      require: (name: string) =>
        name === 'node:fs' ? fs : name === 'node:path' ? { posix } : undefined,
    });
    expect(descriptors.size).toBe(0);
    return {
      output,
      exitCode: process.exitCode,
      data: output ? JSON.parse(output) : null,
    };
  };
  const baseline = () => run('baseline');
  const admit = () => {
    files.set(`${cfg.procRoot}/${cfg.pid}/cgroup`, '0::/commands/command-41');
    files.set(`${childPath}/cgroup.procs`, `${cfg.pid}\n99`);
    files.set(`${childPath}/cgroup.events`, 'populated 1\nfrozen 0');
    return run('admitted');
  };
  const finish = (oom = '5', oomKill = '3') => {
    directories.delete(`${cfg.procRoot}/${cfg.pid}`);
    files.set(`${childPath}/cgroup.procs`, '');
    files.set(`${childPath}/cgroup.events`, 'populated 0\nfrozen 0');
    files.set(`${childPath}/memory.events`, `oom ${oom}\noom_kill ${oomKill}`);
  };
  return {
    files,
    directories,
    aliases,
    reads,
    run,
    baseline,
    admit,
    finish,
    replaceChild: () => {
      inode++;
    },
    ordinaryFilesystem: () => {
      cgroupType = 0x1234n;
    },
    failCleanup: () => {
      cleanupFails = true;
    },
  };
}

function fixture(signalValue: number | null | undefined = 9) {
  const g = guest();
  expect(g.baseline().exitCode).toBe(0);
  expect(g.admit().exitCode).toBe(0);
  g.finish();
  const job = {
    binding,
    jobId: 'synthetic-existing-command-job',
    wait: vi.fn<PersonVmManagedJob['wait']>(async () => ({
      exitCode: 137,
      timedOut: false,
      ...(signalValue === undefined ? {} : { signal: signalValue }),
    })),
    cancelAndWait: vi.fn(async () => ({ exitCode: 137, timedOut: false })),
  };
  const execution = {
    job,
    executionRef: cfg.executionRef,
  };
  const info = {
    version: 1,
    id: job.jobId,
    pid: cfg.pid,
    runtime_boot_id: 'synthetic-native-generation',
    state: 'exited',
    exit_code: 137,
    timed_out: false,
  };
  const command = vi.fn<
    Parameters<
      typeof createPersonVmCommandMemoryObserver
    >[0]['native']['command']
  >(async () => JSON.stringify(info));
  const cleanup = new AbortController();
  const probeJobs: PersonVmManagedProbeJob[] = [];
  const launch = vi.fn<PersonVmManagedProbePort['launch']>(async () => {
    const result = g.run('complete-and-release');
    const probe = {
      binding,
      jobId: `synthetic-probe-${probeJobs.length}`,
      wait: vi.fn(async () => ({ exitCode: result.exitCode, timedOut: false })),
      stdout: vi.fn(async () => result.output),
      cancelAndWait: vi.fn(async () => ({ exitCode: 137, timedOut: false })),
    };
    probeJobs.push(probe);
    return probe;
  });
  const observer = createPersonVmCommandMemoryObserver({
    ...cfg,
    binding,
    nodeExecutable: '/fixed-node/bin/node',
    probes: { launch },
    native: { name: 'synthetic-native-sandbox', command },
    cleanupSignal: () => cleanup.signal,
  });
  return {
    g,
    job,
    execution,
    command,
    info,
    launch,
    probeJobs,
    observer,
    cleanup,
  };
}

describe('command memory observer (synthetic kernel/native sources; not DSH/VM acceptance)', () => {
  it('captures the empty pre-entry baseline, then witnesses the same birth/membership before payload', () => {
    const g = guest();
    expect(g.baseline()).toMatchObject({ exitCode: 0 });
    const before = JSON.parse(g.files.get(receiptPath)!);
    expect(before).toMatchObject({
      stage: 'baseline',
      pid: 41,
      startTicks: '1234',
      baseline: { oom: '4', oomKill: '2' },
      beforeMembership: '/dsh',
    });
    expect(g.admit()).toMatchObject({ exitCode: 0 });
    const admitted = JSON.parse(g.files.get(receiptPath)!);
    expect(admitted).toMatchObject({
      ...before,
      stage: 'admitted',
      admittedMembership: '/commands/command-41',
    });
    expect(g.reads).not.toContain(`${cfg.commandsGroup}/memory.events`);
  });

  it.each(['occupied', 'birth', 'membership', 'foreign-member'] as const)(
    'rejects %s rather than manufacturing independent dispatch evidence',
    (failure) => {
      const g = guest();
      if (failure === 'occupied') {
        g.files.set(`${childPath}/cgroup.procs`, '77');
        expect(g.baseline()).toMatchObject({
          exitCode: 1,
          data: { error: 'child-not-independent' },
        });
        expect(g.files.has(receiptPath)).toBe(false);
        return;
      }
      expect(g.baseline().exitCode).toBe(0);
      if (failure === 'birth')
        g.files.set(
          `${cfg.procRoot}/${cfg.pid}/stat`,
          `${cfg.pid} (reused) ${['S', ...Array<string>(18).fill('0'), '4321'].join(' ')}`,
        );
      if (failure === 'membership') {
        expect(g.run('admitted')).toMatchObject({
          exitCode: 1,
          data: { error: 'admitted-membership-mismatch' },
        });
      } else {
        if (failure === 'foreign-member') {
          g.files.set(
            `${cfg.procRoot}/${cfg.pid}/cgroup`,
            '0::/commands/command-41',
          );
          g.files.set(`${childPath}/cgroup.procs`, '41\n99\n77');
          g.files.set(`${childPath}/cgroup.events`, 'populated 1');
          expect(g.run('admitted').exitCode).toBe(1);
        } else expect(g.admit().exitCode).toBe(1);
      }
      expect(JSON.parse(g.files.get(receiptPath)!).stage).toBe('baseline');
    },
  );

  it('rejects a real ordinary directory with the exact cgroup2 error', async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'allrice-observer-ordinary-')),
    );
    try {
      const text = await runCommand({
        executable: process.execPath,
        args: [
          '-e',
          PERSON_VM_COMMAND_MEMORY_PROGRAM,
          JSON.stringify({ ...cfg, cgroupRoot: directory }),
          'complete',
        ],
        env: hostEnvironment(directory),
        signal: new AbortController().signal,
        readNonzeroExit: true,
      });
      expect(JSON.parse(text)).toEqual({
        version: 1,
        stage: 'read',
        error: 'not-cgroup2',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    'symlink',
    'inode',
    'not-dispatched',
    'descendant',
    'pid-reused',
    'counter-reset',
  ] as const)(
    'rejects %s at final read instead of a false joined/OOM result',
    (failure) => {
      const g = guest();
      expect(g.baseline().exitCode).toBe(0);
      if (failure !== 'not-dispatched') expect(g.admit().exitCode).toBe(0);
      g.finish();
      if (failure === 'symlink')
        g.aliases.set(childPath, `${cfg.commandsGroup}/another-child`);
      if (failure === 'inode') g.replaceChild();
      if (failure === 'descendant')
        g.files.set(`${childPath}/cgroup.procs`, '77');
      if (failure === 'pid-reused')
        g.directories.add(`${cfg.procRoot}/${cfg.pid}`);
      if (failure === 'counter-reset')
        g.files.set(`${childPath}/memory.events`, 'oom 0\noom_kill 0');
      expect(g.run('complete').exitCode).toBe(1);
    },
  );

  it('combines the fixed program with the existing managed-job contract; never reads parent counters or kills DSH', async () => {
    const h = fixture();
    const result = await h.observer.observeCompletion(
      binding,
      h.execution,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      state: 'complete',
      outcome: 'command-memory-limit',
      completion: { joined: true, signal: 9 },
      child: {
        path: childPath,
        baseline: { oom: '4', oomKill: '2' },
        after: { oom: '5', oomKill: '3' },
        delta: { oom: '1', oomKill: '1' },
        joined: true,
      },
      boundary: 'guest-root-cooperative',
    });
    expect(h.launch.mock.calls[0]![0]).toEqual({
      executable: '/fixed-node/bin/node',
      args: [
        '-e',
        PERSON_VM_COMMAND_MEMORY_PROGRAM,
        JSON.stringify({
          cgroupRoot: cfg.cgroupRoot,
          commandsGroup: cfg.commandsGroup,
          dshGroup: cfg.dshGroup,
          procRoot: cfg.procRoot,
          receiptDirectory: cfg.receiptDirectory,
          executionRef: cfg.executionRef,
          pid: cfg.pid,
        }),
        'complete-and-release',
      ],
    });
    expect(h.job.cancelAndWait).not.toHaveBeenCalled();
    expect(h.command.mock.calls).toEqual([
      [
        [
          'inspect',
          'synthetic-native-sandbox',
          '--job',
          h.job.jobId,
          '--format',
          'json',
        ],
        expect.any(AbortSignal),
      ],
      [
        [
          'inspect',
          'synthetic-native-sandbox',
          '--job',
          h.job.jobId,
          '--format',
          'json',
        ],
        expect.any(AbortSignal),
      ],
    ]);
    expect(h.g.reads).not.toContain(`${cfg.commandsGroup}/memory.events`);
    expect(h.g.directories.has(childPath)).toBe(false);
    expect(h.g.files.has(receiptPath)).toBe(false);
    expect(result).not.toHaveProperty('physical');
  });

  it('retains unknown for the real v0.7.16 JobExit shape, including code137 and exact counter increments', async () => {
    const h = fixture(undefined);
    // Omit rather than set undefined: the released native result has no signal.
    h.job.wait.mockResolvedValue({ exitCode: 137, timedOut: false });
    const result = await h.observer.observeCompletion(
      binding,
      h.execution,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      state: 'unknown',
      outcome: 'unknown',
      reason: 'managed-terminating-signal-unavailable',
      completion: { exitCode: 137, signal: 'unknown', joined: true },
      child: { joined: true, delta: { oom: '1', oomKill: '1' } },
    });
  });

  it('keeps native join separate from surviving descendants and missing pre-dispatch receipt', async () => {
    const h = fixture();
    h.g.files.set(`${childPath}/cgroup.procs`, '77');
    expect(
      await h.observer.observeCompletion(
        binding,
        h.execution,
        new AbortController().signal,
      ),
    ).toMatchObject({
      state: 'unknown',
      outcome: 'unknown',
      completion: { joined: true },
      child: null,
    });
    h.g.files.delete(receiptPath);
    expect(
      await h.observer.observeCompletion(
        binding,
        h.execution,
        new AbortController().signal,
      ),
    ).toMatchObject({ state: 'unknown', child: null });
  });

  it('does not treat a normal exit137 or unrelated SIGKILL as local OOM', async () => {
    const normal = fixture(null);
    expect(
      await normal.observer.observeCompletion(
        binding,
        normal.execution,
        new AbortController().signal,
      ),
    ).toMatchObject({
      state: 'unknown',
      outcome: 'unknown',
      completion: { signal: null },
    });
    const killed = fixture(9);
    killed.g.finish('4', '2');
    expect(
      await killed.observer.observeCompletion(
        binding,
        killed.execution,
        new AbortController().signal,
      ),
    ).toMatchObject({ state: 'unknown', outcome: 'unknown' });
    const global = fixture(9);
    global.g.finish('4', '3');
    expect(
      await global.observer.observeCompletion(
        binding,
        global.execution,
        new AbortController().signal,
      ),
    ).toMatchObject({ outcome: 'oom-killed-cause-unknown' });
  });

  it('rejects wrong binding before waiting or probing', async () => {
    const h = fixture();
    expect(
      await h.observer.observeCompletion(
        { ...binding, leaseEpoch: 2 },
        h.execution,
        new AbortController().signal,
      ),
    ).toMatchObject({ state: 'unknown', completion: null, child: null });
    expect(h.job.wait).not.toHaveBeenCalled();
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.command).not.toHaveBeenCalled();
  });

  it.each(['id', 'pid', 'runtime_boot_id', 'exit_code'] as const)(
    'invalidates changed native job %s before reading a child',
    async (field) => {
      const h = fixture();
      h.command
        .mockResolvedValueOnce(JSON.stringify(h.info))
        .mockResolvedValueOnce(
          JSON.stringify({
            ...h.info,
            [field]:
              field === 'pid' || field === 'exit_code'
                ? 99
                : 'synthetic-different-identity',
          }),
        );
      expect(
        await h.observer.observeCompletion(
          binding,
          h.execution,
          new AbortController().signal,
        ),
      ).toMatchObject({ state: 'unknown', completion: null, child: null });
      expect(h.launch).not.toHaveBeenCalled();
      expect(h.job.cancelAndWait).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'cancels and joins an owned probe, including a late launch (%s)',
    async (late) => {
      const h = fixture();
      const admitted = gate(),
        launched = gate(),
        joined = gate();
      const cancel = new AbortController();
      const reason = new Error('synthetic observer cancel');
      const probe = {
        binding,
        jobId: 'synthetic-owned-probe',
        wait: vi.fn(async (signal: AbortSignal) => {
          admitted.resolve();
          if (!signal.aborted)
            await new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true }),
            );
          signal.throwIfAborted();
          return { exitCode: 0, timedOut: false };
        }),
        stdout: vi.fn(async () => ''),
        cancelAndWait: vi.fn(async (signal: AbortSignal) => {
          expect(signal).toBe(h.cleanup.signal);
          expect(signal.aborted).toBe(false);
          await joined.promise;
          return { exitCode: 137, timedOut: false };
        }),
      };
      h.launch.mockImplementation(async () => {
        if (late) {
          admitted.resolve();
          await launched.promise;
        }
        return probe;
      });
      const observing = h.observer.observeCompletion(
        binding,
        h.execution,
        cancel.signal,
      );
      const assertion = expect(observing).rejects.toBe(reason);
      await admitted.promise;
      cancel.abort(reason);
      launched.resolve();
      let settled = false;
      void observing.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      expect(settled).toBe(false);
      joined.resolve();
      await assertion;
      expect(probe.cancelAndWait).toHaveBeenCalledOnce();
      expect(probe.stdout).not.toHaveBeenCalled();
      expect(h.job.cancelAndWait).not.toHaveBeenCalled();
    },
  );

  it('cancelling observation detaches the running command wait without killing that command', async () => {
    const h = fixture();
    const waiting = gate();
    h.job.wait.mockImplementation(async (signal) => {
      waiting.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      signal.throwIfAborted();
      return { exitCode: 137, timedOut: false };
    });
    const cancel = new AbortController();
    const reason = new Error('synthetic observation-only cancel');
    const observing = h.observer.observeCompletion(
      binding,
      h.execution,
      cancel.signal,
    );
    const assertion = expect(observing).rejects.toBe(reason);
    await waiting.promise;
    cancel.abort(reason);
    await assertion;
    expect(h.job.cancelAndWait).not.toHaveBeenCalled();
    expect(h.launch).not.toHaveBeenCalled();
  });

  it('reports actual empty-child cleanup failure to the owner after the probe has joined', async () => {
    const h = fixture();
    h.g.failCleanup();
    await expect(
      h.observer.observeCompletion(
        binding,
        h.execution,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
    expect(h.g.directories.has(childPath)).toBe(true);
    expect(h.g.files.has(receiptPath)).toBe(true);
    expect(h.job.cancelAndWait).not.toHaveBeenCalled();
  });

  it('propagates cleanup failure to the lifecycle owner instead of hiding it as unknown/abort', async () => {
    const h = fixture();
    const cleanup = new Error('synthetic guest join unavailable');
    h.launch.mockResolvedValue({
      binding,
      jobId: 'synthetic-owned-probe',
      wait: async () => {
        throw new Error('synthetic wait failed');
      },
      stdout: async () => '',
      cancelAndWait: async () => {
        throw cleanup;
      },
    });
    await expect(
      h.observer.observeCompletion(
        binding,
        h.execution,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
    expect(h.job.cancelAndWait).not.toHaveBeenCalled();
  });
});
