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
  let cleanupStep:
    ((step: 'before-rmdir' | 'before-unlink') => void) | undefined;
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
      cleanupStep?.('before-rmdir');
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
      cleanupStep?.('before-unlink');
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
    onCleanup: (step: NonNullable<typeof cleanupStep>) => {
      cleanupStep = step;
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

  it('creates a nonce receipt exclusively and only reads an already-admitted receipt on same-birth reentry', () => {
    const g = guest();
    expect(g.baseline().exitCode).toBe(0);
    const baseline = g.files.get(receiptPath);
    expect(g.baseline().exitCode).toBe(1);
    expect(g.files.get(receiptPath)).toBe(baseline);
    expect(g.admit().exitCode).toBe(0);
    const admitted = g.files.get(receiptPath);
    // A read-only reentry must preserve even the original serialization.
    g.files.set(receiptPath, admitted! + '\n');
    expect(g.run('admitted').exitCode).toBe(0);
    expect(g.files.get(receiptPath)).toBe(admitted! + '\n');
    const wrongMembership = JSON.stringify({
      ...JSON.parse(admitted!),
      admittedMembership: '/dsh',
    });
    g.files.set(receiptPath, wrongMembership);
    expect(g.run('admitted').exitCode).toBe(1);
    expect(g.files.get(receiptPath)).toBe(wrongMembership);
    g.files.set(receiptPath, admitted! + '\n');
    g.files.set(
      `${cfg.procRoot}/${cfg.pid}/stat`,
      `${cfg.pid} (reused) ${['S', ...Array<string>(18).fill('0'), '4321'].join(' ')}`,
    );
    expect(g.run('admitted').exitCode).toBe(1);
    expect(g.files.get(receiptPath)).toBe(admitted! + '\n');
  });

  it.each(['admitted', 'complete-and-release'] as const)(
    'rejects missing, truncated or mismatched receipts before %s can certify a child',
    (phase) => {
      const corruptions = [
        ['missing', null],
        ['truncated', '{"version":1'],
        ['version', { version: 2 }],
        ['nonce', { executionRef: 'another-execution' }],
        ['pid', { pid: cfg.pid + 1 }],
        ['boot', { bootId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }],
        ['birth', { startTicks: 'not-a-birth' }],
        [
          'child-path',
          { child: { path: cfg.commandsGroup, device: '5', inode: '27' } },
        ],
        [
          'child-device',
          { child: { path: childPath, device: '6', inode: '27' } },
        ],
        [
          'child-inode',
          { child: { path: childPath, device: '5', inode: '28' } },
        ],
        ['baseline', { baseline: { oom: '4', oomKill: '-1' } }],
        ['origin', { beforeMembership: '/commands' }],
        ['stage', { stage: 'complete' }],
      ] as const;
      for (const [failure, patch] of corruptions) {
        const g = guest();
        expect(g.baseline().exitCode).toBe(0);
        if (phase === 'complete-and-release') {
          expect(g.admit().exitCode).toBe(0);
          g.finish();
        }
        const text = g.files.get(receiptPath)!;
        if (patch === null) g.files.delete(receiptPath);
        else
          g.files.set(
            receiptPath,
            typeof patch === 'string'
              ? patch
              : JSON.stringify({ ...JSON.parse(text), ...patch }),
          );
        const corrupted = g.files.get(receiptPath);
        const release = vi.fn();
        g.onCleanup(release);
        const result = phase === 'admitted' ? g.admit() : g.run(phase);
        expect(result.exitCode, failure).toBe(1);
        expect(result.data, failure).not.toHaveProperty('childJoined', true);
        expect(g.files.get(receiptPath), failure).toBe(corrupted);
        expect(g.directories.has(childPath), failure).toBe(true);
        expect(release, failure).not.toHaveBeenCalled();
        expect(g.reads, failure).not.toContain(
          `${cfg.commandsGroup}/memory.events`,
        );
      }
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
      state: 'unknown',
      outcome: 'unknown',
      reason: 'group-oom-events-do-not-identify-command-victim',
      completion: { joined: true, signal: 9 },
      child: {
        path: childPath,
        baseline: { oom: '4', oomKill: '2' },
        after: { oom: '5', oomKill: '3' },
        delta: { oom: '1', oomKill: '1' },
        joined: true,
        released: true,
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

  it('hands surviving descendants or missing receipts to the owner instead of equating native join with release', async () => {
    const h = fixture();
    h.g.files.set(`${childPath}/cgroup.procs`, '77');
    await expect(
      h.observer.observeCompletion(
        binding,
        h.execution,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
    expect(h.job.wait).toHaveBeenCalledOnce();
    expect(h.g.directories.has(childPath)).toBe(true);
    expect(h.g.files.has(receiptPath)).toBe(true);
    h.g.files.delete(receiptPath);
    await expect(
      h.observer.observeCompletion(
        binding,
        h.execution,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
    expect(h.g.directories.has(childPath)).toBe(true);
    expect(h.job.cancelAndWait).not.toHaveBeenCalled();
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
    ).toMatchObject({
      state: 'unknown',
      outcome: 'unknown',
      reason: 'group-oom-events-do-not-identify-command-victim',
      child: { delta: { oom: '0', oomKill: '1' }, released: true },
    });
  });

  it('retains the no-OOM-evidence result for a known normal exit with unchanged independent child counters', async () => {
    const h = fixture(null);
    h.g.finish('4', '2');
    h.info.exit_code = 0;
    h.job.wait.mockImplementation(async () => ({
      exitCode: 0,
      timedOut: false,
      signal: null,
    }));
    const result = await h.observer.observeCompletion(
      binding,
      h.execution,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      state: 'complete',
      outcome: 'no-oom-evidence',
      reason: null,
      completion: { exitCode: 0, signal: null, joined: true },
      child: {
        delta: { oom: '0', oomKill: '0' },
        joined: true,
        released: true,
      },
    });
    expect(h.job.cancelAndWait).not.toHaveBeenCalled();
  });

  it('keeps earlier helper OOM facts without blaming a later independent SIGKILL of the still-running main job', async () => {
    const h = fixture(9);
    // The helper has already died and incremented this exact child, while its
    // main process is still alive. A separate actor later kills that main job.
    h.g.directories.add(`${cfg.procRoot}/${cfg.pid}`);
    h.g.files.set(`${childPath}/cgroup.procs`, String(cfg.pid));
    h.g.files.set(`${childPath}/cgroup.events`, 'populated 1\nfrozen 0');
    h.command.mockResolvedValueOnce(
      JSON.stringify({ ...h.info, state: 'running', exit_code: null }),
    );
    h.job.wait.mockImplementation(async () => {
      expect(h.g.directories.has(`${cfg.procRoot}/${cfg.pid}`)).toBe(true);
      expect(h.g.files.get(`${childPath}/memory.events`)).toBe(
        'oom 5\noom_kill 3',
      );
      h.g.finish('5', '3');
      return { exitCode: 137, timedOut: false, signal: 9 };
    });
    const result = await h.observer.observeCompletion(
      binding,
      h.execution,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      state: 'unknown',
      outcome: 'unknown',
      reason: 'group-oom-events-do-not-identify-command-victim',
      completion: { signal: 9, exitCode: 137, joined: true },
      child: {
        baseline: { oom: '4', oomKill: '2' },
        delta: { oom: '1', oomKill: '1' },
        joined: true,
        released: true,
      },
    });
    expect(h.g.files.has(receiptPath)).toBe(false);
    expect(h.g.directories.has(childPath)).toBe(false);
    expect(h.job.cancelAndWait).not.toHaveBeenCalled();
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
      const assertion = expect(observing).rejects.toMatchObject({
        code: 'CLEANUP_INCOMPLETE',
        cause: reason,
      });
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
      expect(h.g.directories.has(childPath)).toBe(true);
      expect(h.g.files.has(receiptPath)).toBe(true);
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
    const releaseStep = vi.fn();
    h.g.onCleanup(releaseStep);
    await expect(
      h.observer.observeCompletion(
        binding,
        h.execution,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
    expect(releaseStep).toHaveBeenCalledWith('before-rmdir');
    expect(h.g.directories.has(childPath)).toBe(true);
    expect(h.g.files.has(receiptPath)).toBe(true);
    expect(h.job.cancelAndWait).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'does not lose failed release when its joined probe output fails (timedOut=%s)',
    async (timedOut) => {
      const h = fixture();
      h.g.failCleanup();
      const releaseStep = vi.fn();
      h.g.onCleanup(releaseStep);
      const outputFailure = new Error('retained probe stdout unavailable');
      const launch = h.launch.getMockImplementation()!;
      h.launch.mockImplementationOnce(async (...args) => {
        const job = await launch(...args);
        job.wait = vi.fn(async () => ({ exitCode: 1, timedOut }));
        job.stdout = vi.fn(async () => {
          throw outputFailure;
        });
        return job;
      });
      await expect(
        h.observer.observeCompletion(
          binding,
          h.execution,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        code: 'CLEANUP_INCOMPLETE',
        cause: outputFailure,
      });
      expect(releaseStep).toHaveBeenCalledWith('before-rmdir');
      expect(h.probeJobs[0]!.wait).toHaveBeenCalledOnce();
      expect(h.probeJobs[0]!.stdout).toHaveBeenCalledOnce();
      expect(h.probeJobs[0]!.cancelAndWait).not.toHaveBeenCalled();
      expect(h.g.directories.has(childPath)).toBe(true);
      expect(h.g.files.has(receiptPath)).toBe(true);
      expect(h.job.cancelAndWait).not.toHaveBeenCalled();
    },
  );

  it('preserves unconfirmed release when stdout is cancelled after the probe wait already joined', async () => {
    const h = fixture();
    h.g.failCleanup();
    const releaseStep = vi.fn();
    h.g.onCleanup(releaseStep);
    const cancel = new AbortController(),
      entered = gate();
    const reason = new Error('cancel after guest wait');
    const launch = h.launch.getMockImplementation()!;
    h.launch.mockImplementationOnce(async (...args) => {
      const job = await launch(...args);
      job.stdout = vi.fn(async (signal) => {
        entered.resolve();
        if (!signal.aborted)
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        signal.throwIfAborted();
        return '';
      });
      return job;
    });
    const observing = h.observer.observeCompletion(
      binding,
      h.execution,
      cancel.signal,
    );
    const assertion = expect(observing).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
      cause: reason,
    });
    await entered.promise;
    expect(releaseStep).toHaveBeenCalledWith('before-rmdir');
    expect(h.probeJobs[0]!.wait).toHaveBeenCalledOnce();
    cancel.abort(reason);
    await assertion;
    expect(h.probeJobs[0]!.cancelAndWait).not.toHaveBeenCalled();
    expect(h.g.directories.has(childPath)).toBe(true);
    expect(h.g.files.has(receiptPath)).toBe(true);
    expect(h.job.cancelAndWait).not.toHaveBeenCalled();
  });

  it.each(['before-rmdir', 'before-unlink'] as const)(
    'probe cancel/join at %s does not certify both artifacts were released',
    async (interruption) => {
      const h = fixture();
      const cancel = new AbortController();
      const reason = new Error('interrupt release phase');
      const releaseStep = vi.fn((step: 'before-rmdir' | 'before-unlink') => {
        if (step === interruption) {
          cancel.abort(reason);
          throw reason;
        }
      });
      h.g.onCleanup(releaseStep);
      await expect(
        h.observer.observeCompletion(binding, h.execution, cancel.signal),
      ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE', cause: reason });
      expect(releaseStep).toHaveBeenCalledWith(interruption);
      expect(h.probeJobs[0]!.cancelAndWait).toHaveBeenCalledOnce();
      expect(h.probeJobs[0]!.stdout).not.toHaveBeenCalled();
      expect(h.g.directories.has(childPath)).toBe(
        interruption === 'before-rmdir',
      );
      expect(h.g.files.has(receiptPath)).toBe(true);
      expect(h.job.cancelAndWait).not.toHaveBeenCalled();
    },
  );

  it('cannot certify release with lost or mismatched output even when the synthetic program actually removed its artifacts', async () => {
    for (const failure of [
      'stdout',
      'json',
      'foreign-receipt',
      'release-flag',
      'version',
      'receipt-version',
      'pid',
      'birth',
      'child-path',
      'child-identity',
      'stage',
      'membership',
      'baseline',
      'counter-reset',
      'joined-flag',
    ] as const) {
      const h = fixture();
      const launch = h.launch.getMockImplementation()!;
      h.launch.mockImplementationOnce(async (...args) => {
        const job = await launch(...args);
        const stdout = job.stdout;
        job.stdout = vi.fn(async (signal) => {
          if (failure === 'stdout') throw new Error('stdout lost');
          if (failure === 'json') return 'not-json';
          const data = JSON.parse(await stdout(signal));
          if (failure === 'foreign-receipt')
            data.receipt.executionRef = 'foreign';
          if (failure === 'release-flag') data.childReleased = false;
          if (failure === 'version') data.version = 2;
          if (failure === 'receipt-version') data.receipt.version = 2;
          if (failure === 'pid') data.receipt.pid++;
          if (failure === 'birth') data.receipt.startTicks = null;
          if (failure === 'child-path')
            data.receipt.child.path = cfg.commandsGroup;
          if (failure === 'child-identity')
            data.receipt.child.inode = 'unknown';
          if (failure === 'stage') data.receipt.stage = 'baseline';
          if (failure === 'membership')
            data.receipt.admittedMembership = '/dsh';
          if (failure === 'baseline') delete data.receipt.baseline.oom;
          if (failure === 'counter-reset') data.after.oom = '0';
          if (failure === 'joined-flag') data.childJoined = false;
          return JSON.stringify(data);
        });
        return job;
      });
      await expect(
        h.observer.observeCompletion(
          binding,
          h.execution,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
      expect(h.g.directories.has(childPath)).toBe(false);
      expect(h.g.files.has(receiptPath)).toBe(false);
      expect(h.probeJobs[0]!.cancelAndWait).not.toHaveBeenCalled();
      expect(h.job.cancelAndWait).not.toHaveBeenCalled();
    }
  });

  it('preserves the original abort only after a matching successful release certificate was obtained', async () => {
    const h = fixture();
    const cancel = new AbortController();
    const reason = new Error('cancel alongside confirmed output');
    const launch = h.launch.getMockImplementation()!;
    h.launch.mockImplementationOnce(async (...args) => {
      const job = await launch(...args);
      const stdout = job.stdout;
      job.stdout = vi.fn(async (signal) => {
        const output = await stdout(signal);
        cancel.abort(reason);
        return output;
      });
      return job;
    });
    await expect(
      h.observer.observeCompletion(binding, h.execution, cancel.signal),
    ).rejects.toBe(reason);
    expect(h.g.directories.has(childPath)).toBe(false);
    expect(h.g.files.has(receiptPath)).toBe(false);
    expect(h.probeJobs[0]!.cancelAndWait).not.toHaveBeenCalled();
    expect(h.job.cancelAndWait).not.toHaveBeenCalled();
  });

  it('keeps ambiguous probe dispatch and a foreign retained handle as owner cleanup failures', async () => {
    const h = fixture();
    const admission = new Error('probe dispatch acknowledgement lost');
    h.launch.mockRejectedValueOnce(admission);
    await expect(
      h.observer.observeCompletion(
        binding,
        h.execution,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE', cause: admission });
    const foreign = {
      binding: { ...binding, leaseEpoch: 2 },
      jobId: 'foreign-probe',
      wait: vi.fn(async () => ({ exitCode: 0, timedOut: false })),
      stdout: vi.fn(async () => ''),
      cancelAndWait: vi.fn(async () => ({ exitCode: 137, timedOut: false })),
    };
    h.launch.mockResolvedValueOnce(foreign);
    await expect(
      h.observer.observeCompletion(
        binding,
        h.execution,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
    expect(foreign.wait).not.toHaveBeenCalled();
    expect(foreign.cancelAndWait).not.toHaveBeenCalled();
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
