import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  realpath,
  readFile,
  readdir,
  writeFile,
  mkdir,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PERSON_VM_COMMAND_MEMORY_PROGRAM } from '@allrice/person-vm';
import {
  VM_MEMORY_PHASE4_REFERENCE_POLICY,
  VM_PHYSICAL_MEMORY_BYTES,
} from './contract.ts';
import type * as Platform from '@allrice/contracts';
import { readPlatformPersonVmConfiguration } from '@allrice/contracts';
import type { GuestMemorySample, VmMemoryPolicy } from './contract.ts';
import { createVmMemoryGuestPlan as createPlan } from './guest-config.ts';

// Explicit historical policy is a fixture choice, never a production fallback.
const createVmMemoryGuestPlan = (input: {
  persistentDirectory: string;
  commandReceipt?: Parameters<typeof createPlan>[0]['commandReceipt'];
}) =>
  createPlan({
    ...input,
    policy: VM_MEMORY_PHASE4_REFERENCE_POLICY,
    policyRef: 'fixture:phase4-reference-not-product-approval',
  });

const require = createRequire(import.meta.url);
type Config = {
  contractVersion: number;
  platformPhysicalBytes: number;
  policyRef: string;
  cgroupRoot: string;
  dshGroup: string;
  commandsGroup: string;
  procRoot: string;
  swapFile: string;
  policy: VmMemoryPolicy;
  receiptDirectory?: string;
};
const { initialize } = require('../guest/initialize.cjs') as {
  initialize(
    config: Config,
    io: unknown,
    run: unknown,
  ): { swapFileBytes: number; groups: Record<string, Record<string, string>> };
};
const { sample } = require('../guest/sample.cjs') as {
  sample(config: Config, io: unknown): GuestMemorySample;
};
const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function virtualGuest(plan?: Awaited<ReturnType<typeof createPlan>>) {
  plan ??= await createVmMemoryGuestPlan({
    persistentDirectory: '/fixture/encrypted',
  });
  const config = JSON.parse(
    plan.files.find((file) => file.path.endsWith('/config.json'))!.contents,
  ) as Config;
  const files = new Map<string, string>([
    [join(config.procRoot, 'swaps'), 'Filename Type Size Used Priority\n'],
  ]);
  const enoent = () =>
    Object.assign(new Error('fixture-file-missing'), { code: 'ENOENT' });
  let swapSize: number | undefined;
  const io = {
    readFileSync(file: string) {
      const value = files.get(file);
      // cgroup files are kernel-created even when the fixture first inserts a
      // direct process (the existing negative input stays unchanged).
      if (value === undefined && file.endsWith('/cgroup.events')) {
        const procs = files.get(
          join(file.slice(0, -'/cgroup.events'.length), 'cgroup.procs'),
        );
        if (procs !== undefined)
          return `populated ${procs.trim() ? 1 : 0}\nfrozen 0\n`;
      }
      if (value === undefined) throw enoent();
      return value;
    },
    writeFileSync: vi.fn((file: string, value: string) => {
      files.set(file, value === '+memory' ? 'memory' : String(value));
    }),
    mkdirSync(directory: string, options?: { recursive?: boolean }) {
      if (!options?.recursive && files.has(join(directory, 'cgroup.procs')))
        throw Object.assign(Error('fixture-directory-exists'), {
          code: 'EEXIST',
        });
      files.set(
        join(directory, 'cgroup.procs'),
        files.get(join(directory, 'cgroup.procs')) ?? '',
      );
      const events = join(directory, 'cgroup.events');
      files.set(events, files.get(events) ?? 'populated 0\nfrozen 0\n');
    },
    chmodSync: vi.fn(),
    lstatSync() {
      if (swapSize === undefined) throw enoent();
      return {
        isFile: () => true,
        isSymbolicLink: () => false,
        size: swapSize,
      };
    },
    statSync() {
      return { size: swapSize };
    },
  };
  const run = vi.fn((command: string) => {
    if (command === 'fallocate') swapSize = config.policy.swapBytes;
    if (command === 'swapon')
      files.set(
        join(config.procRoot, 'swaps'),
        `Filename Type Size Used Priority\n${config.swapFile} file 2097148 0 -2\n`,
      );
  });
  return {
    config,
    files,
    io,
    run,
    setSwapSize(value: number) {
      swapSize = value;
    },
  };
}

async function writeSyntheticGuestBinaries(bin: string) {
  await writeFile(
    join(bin, 'cat'),
    `#!/bin/sh
case "$1" in
  "$ALLRICE_MEMORY_PROC_ROOT/"*/stat)
    if [ ! -f "$1" ]; then
      printf '1 (fixture bash) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 12345\\n'
      exit
    fi;;
esac
exec /bin/cat "$@"
`,
    { mode: 0o700 },
  );
  await writeFile(
    join(bin, 'mkdir'),
    `#!/bin/sh
/bin/mkdir "$1" || exit $?
printf 'oom 0\\noom_kill 0\\n' > "$1/memory.events.local"
pid=\${1##*-}
/bin/mkdir -p "$ALLRICE_MEMORY_PROC_ROOT/$pid"
: > "$ALLRICE_MEMORY_PROC_ROOT/$pid/oom_score_adj"
printf '%s (fixture bash) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 12345\\n' "$pid" > "$ALLRICE_MEMORY_PROC_ROOT/$pid/stat"
printf '0::/commands/command-%s\\n' "$pid" > "$ALLRICE_MEMORY_PROC_ROOT/$pid/cgroup"
`,
    { mode: 0o700 },
  );
}

async function bashGuest() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'met267-reexec-')),
  );
  directories.push(directory);
  const plan = await createVmMemoryGuestPlan({
    persistentDirectory: '/fixture/encrypted',
  });
  const bin = join(directory, 'bin');
  const commands = join(directory, 'commands');
  const dsh = join(directory, 'dsh');
  const proc = join(directory, 'proc');
  await Promise.all([bin, commands, dsh, proc].map((file) => mkdir(file)));
  const guard = join(directory, 'bash-env.sh');
  await writeFile(
    guard,
    plan.files.find((file) => file.path.endsWith('/bash-env.sh'))!.contents,
  );
  await writeSyntheticGuestBinaries(bin);
  const env: Record<string, string> = {
    ...plan.env,
    PATH: `${bin}:/usr/bin:/bin`,
    BASH_ENV: guard,
    ALLRICE_MEMORY_CGROUP_ROOT: directory,
    ALLRICE_MEMORY_COMMANDS_GROUP: commands,
    ALLRICE_MEMORY_DSH_GROUP: dsh,
    ALLRICE_MEMORY_PROC_ROOT: proc,
  };
  return {
    directory,
    env,
    async run(command: string) {
      // On macOS, Node's pipe is a socket and Bash -c can take its remote-shell
      // startup branch instead of BASH_ENV. A real /dev/null stdin isolates the
      // intended noninteractive BASH_ENV path without changing command text.
      const child = spawn(
        '/bin/bash',
        ['--noprofile', '--norc', '-c', command],
        {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      return await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) =>
          resolve({ code, signal, stdout, stderr }),
        );
      });
    },
  };
}

/** Real Bash/Node and the generated writer, with ordinary files explicitly
 * substituting cgroup2/proc kernel facts. This is not a DSH/VM OOM proof. */
async function receiptBashGuest() {
  const f = await bashGuest();
  const receiptDirectory = join(f.directory, 'receipts');
  const plan = await createVmMemoryGuestPlan({
    persistentDirectory: f.directory,
    commandReceipt: { nodeExecutable: process.execPath, receiptDirectory },
  });
  const writer = plan.files.find((file) =>
    file.path.endsWith('/command-observer.cjs'),
  )!;
  await mkdir(join(f.directory, 'allrice-memory'));
  await mkdir(receiptDirectory, { mode: 0o700 });
  await writeFile(writer.path, writer.contents, { mode: writer.mode });
  const proc = f.env.ALLRICE_MEMORY_PROC_ROOT!;
  await mkdir(join(proc, 'sys/kernel/random'), { recursive: true });
  await writeFile(
    join(proc, 'sys/kernel/random/boot_id'),
    '12345678-1234-1234-1234-123456789abc',
  );
  const mkdirPath = join(f.directory, 'bin/mkdir');
  const mkdirScript = await readFile(mkdirPath, 'utf8');
  await writeFile(
    mkdirPath,
    mkdirScript.replace(
      'printf \'0::/commands/command-%s\\n\' "$pid"',
      "printf '0::/dsh\\n'",
    ) +
      '\n: > "$1/cgroup.procs"\nprintf "populated 0\\nfrozen 0\\n" > "$1/cgroup.events"\nprintf "oom 0\\noom_kill 0\\n" > "$1/memory.events"\n',
  );
  const preload = join(f.directory, 'synthetic-kernel.cjs');
  const trace = join(f.directory, 'receipt-writes.jsonl');
  const memberReads = join(f.directory, 'receipt-member-reads.jsonl');
  await writeFile(
    preload,
    `const fs = require('node:fs');
const original = { ...fs }, descriptors = new Map();
const env = process.env, pid = process.argv[2], phase = process.argv[3];
const child = env.ALLRICE_MEMORY_COMMANDS_GROUP + '/command-' + pid;
const receipt = env.ALLRICE_MEMORY_RECEIPT_DIRECTORY + '/' + env.ALLRICE_MEMORY_EXECUTION_REF + '.json';
const procs = () => original.readFileSync(child + '/cgroup.procs', 'utf8').trim();
// Emulate the kernel's migration before admitted. Persist one source so Bash's
// real awk and the Node writer read identical membership across exec reentry.
if (phase === 'admitted' && procs().split('\\n').includes(pid)) {
  const extra = child + '/synthetic-members';
  if (original.existsSync(extra)) original.writeFileSync(child + '/cgroup.procs', procs() + '\\n' + original.readFileSync(extra, 'utf8').trim() + '\\n');
  original.writeFileSync(env.ALLRICE_MEMORY_PROC_ROOT + '/' + pid + '/cgroup', '0::' + child.slice(env.ALLRICE_MEMORY_CGROUP_ROOT.length));
  original.writeFileSync(child + '/cgroup.events', 'populated 1\\nfrozen 0');
}
fs.statfsSync = (p, ...args) => ({ ...original.statfsSync(p, ...args), type: p === env.ALLRICE_MEMORY_PROC_ROOT ? 0x9fa0n : 0x63677270n });
fs.openSync = (p, ...args) => { const fd = original.openSync(p, ...args); descriptors.set(fd, p); return fd; };
fs.closeSync = fd => { descriptors.delete(fd); return original.closeSync(fd); };
fs.readFileSync = (fd, ...args) => {
  const p = typeof fd === 'number' ? descriptors.get(fd) : fd;
  const value = original.readFileSync(fd, ...args);
  if (p === child + '/cgroup.procs') original.appendFileSync(${JSON.stringify(memberReads)}, JSON.stringify({ phase, members: value.trim() }) + '\\n');
  if (phase === 'admitted' && env.SYNTHETIC_RECEIPT_FAILURE === 'birth' && p === env.ALLRICE_MEMORY_PROC_ROOT + '/' + pid + '/stat') return value.replace('12345', '54321');
  return value;
};
fs.writeFileSync = (fd, value, ...args) => {
  const p = typeof fd === 'number' ? descriptors.get(fd) : fd;
  if (p !== receipt) return original.writeFileSync(fd, value, ...args);
  const data = JSON.parse(value);
  original.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ phase, pid, members: procs(), high: original.readFileSync(child + '/memory.high', 'utf8').trim(), max: original.readFileSync(child + '/memory.max', 'utf8').trim(), receipt: data }) + '\\n');
  if (env.SYNTHETIC_RECEIPT_FAILURE === phase + '-write') throw Error('synthetic receipt write failure');
  if (phase === 'baseline' && env.SYNTHETIC_RECEIPT_FAILURE === 'truncated') value = '{"version":1';
  return original.writeFileSync(fd, value, ...args);
};
`,
  );
  Object.assign(f.env, {
    ALLRICE_MEMORY_RECEIPT_NODE: plan.env.ALLRICE_MEMORY_RECEIPT_NODE,
    ALLRICE_MEMORY_RECEIPT_WRITER: plan.env.ALLRICE_MEMORY_RECEIPT_WRITER,
    ALLRICE_MEMORY_RECEIPT_DIRECTORY: receiptDirectory,
    ALLRICE_MEMORY_EXECUTION_REF: 'synthetic-dispatch-nonce',
    NODE_OPTIONS: `--require=${preload}`,
  });
  return {
    ...f,
    receiptDirectory,
    receipt: join(receiptDirectory, 'synthetic-dispatch-nonce.json'),
    trace,
    memberReads,
    writer,
  };
}

describe.sequential(
  'guest artifacts without VM, kernel mutation or pressure allocation',
  () => {
    it('产品计划必须显式给平台policy和批准来源，不把样机值当默认', async () => {
      await expect(
        createPlan({
          persistentDirectory: '/fixture/encrypted',
          policy: VM_MEMORY_PHASE4_REFERENCE_POLICY,
          policyRef: '',
        }),
      ).rejects.toThrow('approved_memory_policy_required');
      const f = await virtualGuest();
      expect(() =>
        initialize({ ...f.config, policyRef: '' }, f.io, f.run),
      ).toThrow('approved_memory_policy_required');
      expect(f.run).not.toHaveBeenCalled();
    });
    it('the default plan stages the same platform cap that the actual initializer accepts', async () => {
      const f = await virtualGuest();
      expect(f.config.platformPhysicalBytes).toBe(VM_PHYSICAL_MEMORY_BYTES);
      expect(f.config.policy.physicalBytes).toBe(
        f.config.platformPhysicalBytes,
      );
      expect(initialize(f.config, f.io, f.run).swapFileBytes).toBe(
        f.config.policy.swapBytes,
      );
    });

    it('a non-default application platform snapshot flows through the actual plan into the initializer', async () => {
      // Only the trusted static source boundary is varied; no request/env writer.
      const platform = Object.freeze({
        ...readPlatformPersonVmConfiguration(),
        memoryMiB: 3072,
        idleMs: 3333,
      });
      vi.resetModules();
      vi.doMock('@allrice/contracts', async (original) => ({
        ...(await original<typeof Platform>()),
        readPlatformPersonVmConfiguration: () => platform,
      }));
      try {
        const { createVmMemoryGuestPlan: currentPlan } =
          await import('./guest-config.ts');
        const physicalBytes = platform.memoryMiB * 1024 ** 2;
        const plan = await currentPlan({
          persistentDirectory: '/fixture/encrypted',
          policy: { ...VM_MEMORY_PHASE4_REFERENCE_POLICY, physicalBytes },
          policyRef: 'fixture:nondefault-application-platform-snapshot',
        });
        const f = await virtualGuest(plan);
        expect(f.config.platformPhysicalBytes).toBe(physicalBytes);
        expect(f.config.policy.physicalBytes).toBe(physicalBytes);
        expect(initialize(f.config, f.io, f.run).swapFileBytes).toBe(
          f.config.policy.swapBytes,
        );
        await expect(
          currentPlan({
            persistentDirectory: '/fixture/encrypted',
            policy: VM_MEMORY_PHASE4_REFERENCE_POLICY,
            policyRef: 'fixture:wrong-platform-physical-policy',
          }),
        ).rejects.toThrow('invalid_memory_policy');
      } finally {
        vi.doUnmock('@allrice/contracts');
        vi.resetModules();
      }
    });

    it.each(['missing', 'zero', 'mismatch'] as const)(
      'initializer rejects a %s staged platform cap before resource mutation',
      async (kind) => {
        const f = await virtualGuest();
        const config = { ...f.config };
        if (kind === 'missing')
          Reflect.deleteProperty(config, 'platformPhysicalBytes');
        else
          config.platformPhysicalBytes =
            kind === 'zero' ? 0 : VM_PHYSICAL_MEMORY_BYTES + 1;
        const mkdir = vi.spyOn(f.io, 'mkdirSync');
        expect(() => initialize(config, f.io, f.run)).toThrow(
          'invalid_memory_policy',
        );
        expect(mkdir).not.toHaveBeenCalled();
        expect(f.io.writeFileSync).not.toHaveBeenCalled();
        expect(f.run).not.toHaveBeenCalled();
      },
    );

    it('初始化读取真实接口回值，RAM/swap分开，重复启动不重格式化已用swap', async () => {
      const f = await virtualGuest();
      const result = initialize(f.config, f.io, f.run);
      expect(result.swapFileBytes).toBe(2147483648);
      expect(result.groups[f.config.commandsGroup]).toEqual({
        'memory.high': '805306368',
        'memory.max': '1342177280',
        'memory.swap.max': '2147483648',
        'memory.oom.group': '0',
      });
      expect(result.groups[f.config.dshGroup]).toMatchObject({
        'memory.low': '268435456',
        'memory.swap.max': '536870912',
        'memory.max': 'max',
      });
      initialize(f.config, f.io, f.run);
      expect(f.run.mock.calls.map(([command]) => command)).toEqual([
        'fallocate',
        'mkswap',
        'swapon',
      ]);
      expect(f.io.chmodSync).toHaveBeenCalledWith(f.config.swapFile, 0o600);
    });

    it('已有错误swap或live父组不擅自重格式化/移动运行进程', async () => {
      const f = await virtualGuest();
      f.setSwapSize(1);
      expect(() => initialize(f.config, f.io, f.run)).toThrow(
        'existing_swap_file_invalid',
      );
      expect(f.run).not.toHaveBeenCalled();
      f.setSwapSize(2147483648);
      f.files.set(join(f.config.commandsGroup, 'cgroup.procs'), '123\n');
      expect(() => initialize(f.config, f.io, f.run)).toThrow(
        'memory_group_has_live_processes',
      );
      expect(f.run.mock.calls.map(([command]) => command)).not.toContain(
        'mkswap',
      );
    });

    it('内核不支持swap/memcg或回读不符时明确失败，不输出设置成功', async () => {
      const f = await virtualGuest();
      expect(() =>
        initialize(f.config, f.io, () => {
          throw Error('synthetic-swap-unsupported');
        }),
      ).toThrow('synthetic-swap-unsupported');
      expect(() =>
        initialize(f.config, { ...f.io, writeFileSync() {} }, f.run),
      ).toThrow();
    });

    it.each(
      (['memory.high', 'memory.max'] as const).flatMap((limit) =>
        (['mismatch', 'unreadable'] as const).map((kind) => ({ limit, kind })),
      ),
    )(
      '初始化$limit写入后回读$kind仍失败，不能返回设置成功',
      async ({ limit, kind }) => {
        const f = await virtualGuest();
        const target = join(f.config.commandsGroup, limit);
        const io = {
          ...f.io,
          readFileSync(file: string) {
            const value = f.io.readFileSync(file);
            if (file !== target) return value;
            if (kind === 'unreadable')
              throw Error('synthetic-limit-readback-unavailable');
            return '0';
          },
        };
        expect(() => initialize(f.config, io, f.run)).toThrow(
          kind === 'mismatch'
            ? 'memory_limit_readback_failed'
            : 'synthetic-limit-readback-unavailable',
        );
        expect(f.io.writeFileSync).toHaveBeenCalledWith(
          target,
          String(
            limit === 'memory.high'
              ? f.config.policy.commandHighBytes
              : f.config.policy.commandMaxBytes,
          ),
        );
      },
    );

    it('swapon命令返回但未读到活动swap时拒绝，尚不开始写memcg限额', async () => {
      const f = await virtualGuest();
      expect(() =>
        initialize(f.config, f.io, (command: string) => {
          if (command !== 'swapon') f.run(command);
        }),
      ).toThrow('swap_activation_not_observed');
      expect(f.io.writeFileSync).not.toHaveBeenCalled();
    });

    it('父组为空但child仍活时，在任何组限额写入前拒绝差异policy', async () => {
      const f = await virtualGuest();
      initialize(f.config, f.io, f.run);
      f.files.set(join(f.config.commandsGroup, 'cgroup.procs'), '');
      f.files.set(
        join(f.config.commandsGroup, 'command-123/cgroup.procs'),
        '123\n',
      );
      f.files.set(
        join(f.config.commandsGroup, 'cgroup.events'),
        'populated 1\nfrozen 0\n',
      );
      f.io.writeFileSync.mockClear();
      const policy = {
        ...f.config.policy,
        commandMaxBytes: f.config.policy.commandMaxBytes - 1,
      };
      expect(() => initialize({ ...f.config, policy }, f.io, f.run)).toThrow(
        'memory_group_has_live_processes',
      );
      expect(
        f.io.writeFileSync.mock.calls.filter(([file]) =>
          /\/memory\./.test(file),
        ),
      ).toEqual([]);
      expect(f.files.get(join(f.config.dshGroup, 'memory.low'))).toBe(
        String(f.config.policy.dshLowBytes),
      );
      expect(f.files.get(join(f.config.commandsGroup, 'memory.max'))).toBe(
        String(f.config.policy.commandMaxBytes),
      );
    });

    it('已建组同配置只读幂等，空组也不开放running重配', async () => {
      const f = await virtualGuest();
      initialize(f.config, f.io, f.run);
      f.files.set(
        join(f.config.commandsGroup, 'cgroup.events'),
        'populated 1\nfrozen 0\n',
      );
      f.io.writeFileSync.mockClear();
      initialize(f.config, f.io, f.run);
      expect(
        f.io.writeFileSync.mock.calls.filter(([file]) =>
          /\/memory\./.test(file),
        ),
      ).toEqual([]);
      f.files.set(
        join(f.config.commandsGroup, 'cgroup.events'),
        'populated 0\nfrozen 0\n',
      );
      expect(() =>
        initialize(
          {
            ...f.config,
            policy: {
              ...f.config.policy,
              commandMaxBytes: f.config.policy.commandMaxBytes - 1,
            },
          },
          f.io,
          f.run,
        ),
      ).toThrow();
    });

    it('后一个组拒绝时不提前写第一个新组的限额，子树事实缺失也失败', async () => {
      const f = await virtualGuest();
      f.files.set(join(f.config.commandsGroup, 'cgroup.procs'), '');
      f.files.set(
        join(f.config.commandsGroup, 'cgroup.events'),
        'populated 1\nfrozen 0\n',
      );
      f.files.set(
        join(f.config.commandsGroup, 'command-123/cgroup.procs'),
        '123\n',
      );
      expect(() => initialize(f.config, f.io, f.run)).toThrow(
        'memory_group_has_live_processes',
      );
      expect(
        f.io.writeFileSync.mock.calls.filter(([file]) =>
          /\/memory\./.test(file),
        ),
      ).toEqual([]);
      const unknown = await virtualGuest();
      unknown.files.set(join(unknown.config.commandsGroup, 'cgroup.procs'), '');
      unknown.files.set(
        join(unknown.config.commandsGroup, 'cgroup.events'),
        'frozen 0\n',
      );
      expect(() => initialize(unknown.config, unknown.io, unknown.run)).toThrow(
        'memory_group_population_unknown',
      );
      expect(
        unknown.io.writeFileSync.mock.calls.filter(([file]) =>
          /\/memory\./.test(file),
        ),
      ).toEqual([]);
    });

    it('诊断按键取RAM/swap/局部/父组/全局计数，缺失保持null', async () => {
      const f = await virtualGuest();
      f.files.set(
        join(f.config.procRoot, 'meminfo'),
        'SwapFree: 20 kB\nMemAvailable: 30 kB\nMemTotal: 100 kB\nSwapTotal: 40 kB\n',
      );
      f.files.set(join(f.config.procRoot, 'vmstat'), 'oom_kill 9\n');
      f.files.set(join(f.config.commandsGroup, 'memory.current'), '70\n');
      f.files.set(join(f.config.commandsGroup, 'memory.swap.current'), '12\n');
      f.files.set(
        join(f.config.commandsGroup, 'memory.events'),
        'oom 3\noom_kill 2\n',
      );
      f.files.set(
        join(f.config.commandsGroup, 'memory.events.local'),
        'oom 1\noom_kill 0\n',
      );
      expect(sample(f.config, f.io)).toEqual({
        ramBytes: 102400,
        availableBytes: 30720,
        swapTotalBytes: 40960,
        swapFreeBytes: 20480,
        commandRamBytes: 70,
        commandSwapBytes: 12,
        dshRamBytes: null,
        dshSwapBytes: null,
        commandOomKills: 2,
        parentLocalOoms: 1,
        globalOomKills: 9,
      });
    });

    it('工件只走原生BASH_ENV/launcher，无轮询、默认超时或第二命令runner', async () => {
      const plan = await createVmMemoryGuestPlan({
        persistentDirectory: '/fixture/encrypted',
      });
      expect(plan.env.BASH_ENV).toBe(
        '/fixture/encrypted/allrice-memory/bash-env.sh',
      );
      expect(plan.env.ALLRICE_MEMORY_COMMAND_OOM_SCORE).toBe('800');
      const launcher = plan.files.find((file) =>
        file.path.endsWith('/launch-dsh.sh'),
      )!.contents;
      expect(launcher.indexOf('cgroup.procs')).toBeLessThan(
        launcher.indexOf('exec "$@"'),
      );
      expect(launcher).toContain('oom_score_adj');
      await expect(
        createVmMemoryGuestPlan({ persistentDirectory: '/' }),
      ).rejects.toThrow('invalid_guest_memory_directory');
    });

    it('receipt显式配置只生成同一公开程序，不给DSH配置共享nonce', async () => {
      const plan = await createVmMemoryGuestPlan({
        persistentDirectory: '/fixture/encrypted',
        commandReceipt: {
          nodeExecutable: '/fixed-node/bin/node',
          receiptDirectory: '/fixture/encrypted/receipts',
        },
      });
      const writer = plan.files.find((file) =>
        file.path.endsWith('/command-observer.cjs'),
      )!;
      expect(writer.mode).toBe(0o700);
      expect(writer.contents.endsWith(PERSON_VM_COMMAND_MEMORY_PROGRAM)).toBe(
        true,
      );
      expect(plan.env).toMatchObject({
        ALLRICE_MEMORY_RECEIPT_NODE: '/fixed-node/bin/node',
        ALLRICE_MEMORY_RECEIPT_WRITER:
          '/fixture/encrypted/allrice-memory/command-observer.cjs',
        ALLRICE_MEMORY_RECEIPT_DIRECTORY: '/fixture/encrypted/receipts',
      });
      expect(plan.env).not.toHaveProperty('ALLRICE_MEMORY_EXECUTION_REF');
      for (const commandReceipt of [
        {
          nodeExecutable: 'node',
          receiptDirectory: '/fixture/encrypted/receipts',
        },
        {
          nodeExecutable: '/fixed-node/bin/node',
          receiptDirectory: '/other-person/receipts',
        },
        {
          nodeExecutable: '/fixed-node/bin/node',
          receiptDirectory: '/fixture/encrypted/../other/receipts',
        },
      ])
        await expect(
          createVmMemoryGuestPlan({
            persistentDirectory: '/fixture/encrypted',
            commandReceipt,
          }),
        ).rejects.toThrow('invalid_command_receipt_configuration');
    });

    it.each(['canonical', 'symlink', 'not-directory'] as const)(
      '初始化仅为显式receipt目录创建0700并核身份（%s）',
      async (kind) => {
        const f = await virtualGuest();
        const receipt = '/fixture/encrypted/receipts';
        const mkdirReceipt = vi.fn();
        const io = {
          ...f.io,
          mkdirSync(
            directory: string,
            options?: { recursive?: boolean; mode?: number },
          ) {
            if (directory === receipt) mkdirReceipt(directory, options);
            else f.io.mkdirSync(directory, options);
          },
          lstatSync(file: string) {
            return file === receipt
              ? { isDirectory: () => kind !== 'not-directory' }
              : f.io.lstatSync();
          },
          realpathSync: () =>
            kind === 'symlink' ? '/another-person/receipts' : receipt,
        };
        const initializing = () =>
          initialize({ ...f.config, receiptDirectory: receipt }, io, f.run);
        if (kind === 'canonical') {
          expect(
            initializing().groups[f.config.commandsGroup]!['memory.max'],
          ).toBe('1342177280');
          expect(f.io.chmodSync).toHaveBeenCalledWith(receipt, 0o700);
        } else
          expect(initializing).toThrow('invalid_command_receipt_directory');
        expect(mkdirReceipt).toHaveBeenCalledWith(receipt, {
          recursive: true,
          mode: 0o700,
        });
      },
    );

    it('真实BASH_ENV在负载前按读回→空child baseline→同PID admitted写receipt，EXIT保留待observer释放', async () => {
      const f = await receiptBashGuest();
      const result = await f.run('printf "ran-once\\n"; exit 9');
      expect(result).toMatchObject({
        code: 9,
        signal: null,
        stdout: 'ran-once\n',
        stderr: '',
      });
      const writes = (await readFile(f.trace, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(writes.map((entry) => entry.phase)).toEqual([
        'baseline',
        'admitted',
      ]);
      const pid = Number(writes[0].pid);
      expect(writes[0]).toMatchObject({
        members: '',
        high: '805306368',
        max: '1342177280',
        receipt: {
          version: 1,
          pid,
          stage: 'baseline',
          beforeMembership: '/dsh',
          startTicks: '12345',
          baseline: { oom: '0', oomKill: '0' },
        },
      });
      expect(writes[1]).toMatchObject({
        pid: String(pid),
        members: String(pid),
        receipt: {
          ...writes[0].receipt,
          stage: 'admitted',
          admittedMembership: `/commands/command-${pid}`,
        },
      });
      expect((await stat(f.receipt)).mode & 0o777).toBe(0o600);
      expect((await stat(writes[0].receipt.child.path)).isDirectory()).toBe(
        true,
      );
      expect(JSON.parse(await readFile(f.receipt, 'utf8')).stage).toBe(
        'admitted',
      );
    });

    it('receipt模式exec同PID重入只读校验，不重写首次baseline或receipt字节', async () => {
      const f = await receiptBashGuest();
      const result = await f.run(
        'cat "$ALLRICE_MEMORY_PROC_ROOT/$$/cgroup" > "$ALLRICE_MEMORY_CGROUP_ROOT/before-cgroup"; cp "$ALLRICE_MEMORY_RECEIPT_DIRECTORY/$ALLRICE_MEMORY_EXECUTION_REF.json" "$ALLRICE_MEMORY_CGROUP_ROOT/before.json"; printf "oom 3\\noom_kill 2\\n" > "$allrice_memory_child/memory.events"; exec /bin/bash -c \'cmp "$ALLRICE_MEMORY_CGROUP_ROOT/before.json" "$ALLRICE_MEMORY_RECEIPT_DIRECTORY/$ALLRICE_MEMORY_EXECUTION_REF.json" || exit 91; printf "once\\n"; exit 4\'',
      );
      expect(result).toMatchObject({
        code: 4,
        signal: null,
        stdout: 'once\n',
        stderr: '',
      });
      const writes = (await readFile(f.trace, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(writes.map((entry) => entry.phase)).toEqual([
        'baseline',
        'admitted',
      ]);
      expect(await readFile(f.receipt, 'utf8')).toBe(
        await readFile(join(f.directory, 'before.json'), 'utf8'),
      );
      expect(JSON.parse(await readFile(f.receipt, 'utf8')).baseline).toEqual({
        oom: '0',
        oomKill: '0',
      });
      const receipt = JSON.parse(await readFile(f.receipt, 'utf8'));
      expect(await readFile(join(f.directory, 'before-cgroup'), 'utf8')).toBe(
        '0::' + receipt.admittedMembership,
      );
    });

    it('已admitted的同PID真实Bash重入允许合成存活成员，仍不重写receipt', async () => {
      const f = await receiptBashGuest();
      const result = await f.run(
        'printf "77\\n" > "$allrice_memory_child/synthetic-members"; cp "$ALLRICE_MEMORY_RECEIPT_DIRECTORY/$ALLRICE_MEMORY_EXECUTION_REF.json" "$ALLRICE_MEMORY_CGROUP_ROOT/before.json"; exec /bin/bash -c \'cmp "$ALLRICE_MEMORY_CGROUP_ROOT/before.json" "$ALLRICE_MEMORY_RECEIPT_DIRECTORY/$ALLRICE_MEMORY_EXECUTION_REF.json" || exit 91; printf "once\\n"; exit 4\'',
      );
      expect(result).toMatchObject({
        code: 4,
        signal: null,
        stdout: 'once\n',
        stderr: '',
      });
      const reads = (await readFile(f.memberReads, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        reads.some(
          (entry) =>
            entry.phase === 'admitted' &&
            entry.members.split('\n').includes('77'),
        ),
      ).toBe(true);
      expect((await readFile(f.trace, 'utf8')).trim().split('\n')).toHaveLength(
        2,
      );
      expect(await readFile(f.receipt, 'utf8')).toBe(
        await readFile(join(f.directory, 'before.json'), 'utf8'),
      );
      const receipt = JSON.parse(await readFile(f.receipt, 'utf8'));
      expect(
        await readFile(join(receipt.child.path, 'cgroup.procs'), 'utf8'),
      ).toContain('\n77\n');
    });

    it('统一membership夹具不掩盖实际Bash重入的错组拒绝', async () => {
      const f = await receiptBashGuest();
      const result = await f.run(
        'printf "0::/dsh" > "$ALLRICE_MEMORY_PROC_ROOT/$$/cgroup"; exec /bin/bash -c \'printf must-not-run\'',
      );
      expect(result).toMatchObject({ code: 75, signal: null, stdout: '' });
      expect(result.stderr).toContain('COMMAND_MEMORY_SETUP_FAILED');
      expect((await readFile(f.trace, 'utf8')).trim().split('\n')).toHaveLength(
        2,
      );
      const receipt = JSON.parse(await readFile(f.receipt, 'utf8'));
      expect(
        await readFile(
          join(f.env.ALLRICE_MEMORY_PROC_ROOT!, String(receipt.pid), 'cgroup'),
          'utf8',
        ),
      ).toBe('0::/dsh');
    });

    it.each(
      [0, 9].flatMap((exit) =>
        [
          { kind: 'local', events: 'oom 1\noom_kill 1\n' },
          { kind: 'unattributed', events: 'oom 0\noom_kill 1\n' },
        ].map((event) => ({ ...event, exit })),
      ),
    )(
      'receipt组事件$kind不改存活shell原exit=$exit，不冒称主命令死亡',
      async ({ events, exit }) => {
        const f = await receiptBashGuest();
        f.env.SYNTHETIC_EVENTS = events;
        f.env.SYNTHETIC_EXIT = String(exit);
        const result = await f.run(
          'printf "%s" "$SYNTHETIC_EVENTS" > "$allrice_memory_child/memory.events.local"; printf "%s" "$SYNTHETIC_EVENTS" > "$allrice_memory_child/memory.events"; printf "once\\n"; exit "$SYNTHETIC_EXIT"',
        );
        expect(result).toMatchObject({
          code: exit,
          signal: null,
          stdout: 'once\n',
          stderr: '命令组观察到 OOM 事件，具体进程及命令退出原因未确认\n',
        });
        expect(result.stderr).not.toContain('COMMAND_MEMORY_LIMIT');
        expect(result.stderr).not.toContain('COMMAND_OOM_KILLED');
        const receipt = JSON.parse(await readFile(f.receipt, 'utf8'));
        expect(receipt).toMatchObject({
          stage: 'admitted',
          baseline: { oom: '0', oomKill: '0' },
        });
        expect((await stat(receipt.child.path)).isDirectory()).toBe(true);
        expect(
          await readFile(
            join(receipt.child.path, 'memory.events.local'),
            'utf8',
          ),
        ).toBe(events);
      },
    );

    it('receipt模式exec非Bash仍保留原137和工件，不靠组事件猜退出原因', async () => {
      const f = await receiptBashGuest();
      const result = await f.run(
        'printf "oom 1\\noom_kill 1\\n" > "$allrice_memory_child/memory.events.local"; printf "once\\n"; exec /bin/sh -c \'exit 137\'',
      );
      expect(result).toMatchObject({
        code: 137,
        signal: null,
        stdout: 'once\n',
        stderr: '',
      });
      const receipt = JSON.parse(await readFile(f.receipt, 'utf8'));
      expect(receipt.stage).toBe('admitted');
      expect((await stat(receipt.child.path)).isDirectory()).toBe(true);
    });

    it.each(['memory.high', 'memory.max'] as const)(
      'receipt模式%s回读失败发生在baseline和迁PID之前',
      async (limit) => {
        const f = await receiptBashGuest();
        const cat = join(f.directory, 'bin/cat');
        const original = await readFile(cat, 'utf8');
        await writeFile(
          cat,
          `#!/bin/sh
case "$1" in */${limit})
  /bin/cat "$1" > "$ALLRICE_MEMORY_CGROUP_ROOT/written-limit" || exit 99
  printf '0\\n'; exit;;
esac
${original.replace('#!/bin/sh\n', '')}`,
        );
        expect(await f.run('printf must-not-run')).toMatchObject({
          code: 75,
          stdout: '',
        });
        expect(await readFile(join(f.directory, 'written-limit'), 'utf8')).toBe(
          String(
            limit === 'memory.high'
              ? VM_MEMORY_PHASE4_REFERENCE_POLICY.commandHighBytes
              : VM_MEMORY_PHASE4_REFERENCE_POLICY.commandMaxBytes,
          ) + '\n',
        );
        await expect(readFile(f.trace)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await expect(readFile(f.receipt)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        const children = await readdir(f.env.ALLRICE_MEMORY_COMMANDS_GROUP!);
        expect(children).toHaveLength(1);
        expect(children[0]).toMatch(/^command-[1-9][0-9]*$/);
        expect(
          await readFile(
            join(
              f.env.ALLRICE_MEMORY_COMMANDS_GROUP!,
              children[0]!,
              'cgroup.procs',
            ),
            'utf8',
          ),
        ).toBe('');
      },
    );

    it.each([
      'baseline-write',
      'admitted-write',
      'truncated',
      'birth',
    ] as const)(
      '真实入口receipt %s失败拒绝负载并保留owner收尾证据',
      async (failure) => {
        const f = await receiptBashGuest();
        f.env.SYNTHETIC_RECEIPT_FAILURE = failure;
        const result = await f.run('printf must-not-run');
        expect(result).toMatchObject({ code: 75, signal: null, stdout: '' });
        expect(result.stderr).toContain('COMMAND_MEMORY_SETUP_FAILED');
        const writes = (await readFile(f.trace, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(writes[0]).toMatchObject({
          phase: 'baseline',
          members: '',
          high: '805306368',
          max: '1342177280',
        });
        expect((await stat(writes[0].receipt.child.path)).isDirectory()).toBe(
          true,
        );
        if (failure === 'admitted-write')
          expect(writes[1]).toMatchObject({
            phase: 'admitted',
            members: writes[0].pid,
          });
        else expect(writes).toHaveLength(1);
      },
    );

    it('已有nonce拒绝重复派发，fork继承关联也拒绝，不覆盖原receipt', async () => {
      const f = await receiptBashGuest();
      expect((await f.run('exit 0')).code).toBe(0);
      const original = await readFile(f.receipt, 'utf8');
      expect(await f.run('printf must-not-run')).toMatchObject({
        code: 75,
        stdout: '',
      });
      expect(await readFile(f.receipt, 'utf8')).toBe(original);
      const fork = await receiptBashGuest();
      expect(
        await fork.run("/bin/bash -c 'printf must-not-run'"),
      ).toMatchObject({ code: 75, stdout: '' });
      expect(
        (await readFile(fork.trace, 'utf8')).trim().split('\n'),
      ).toHaveLength(2);
    });

    it('无nonce保持旧调用；显式nonce缺配拒绝；shell死亡仍保留receipt且不猜OOM', async () => {
      const legacy = await receiptBashGuest();
      delete legacy.env.ALLRICE_MEMORY_EXECUTION_REF;
      expect(await legacy.run('printf legacy')).toMatchObject({
        code: 0,
        stdout: 'legacy',
        stderr: '',
      });
      await expect(readFile(legacy.trace)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const missing = await receiptBashGuest();
      delete missing.env.ALLRICE_MEMORY_RECEIPT_NODE;
      expect(await missing.run('printf must-not-run')).toMatchObject({
        code: 75,
        stdout: '',
      });
      const killed = await receiptBashGuest();
      expect(
        await killed.run('printf "once\\n"; kill -KILL "$$"'),
      ).toMatchObject({
        code: null,
        signal: 'SIGKILL',
        stdout: 'once\n',
        stderr: '',
      });
      const receipt = JSON.parse(await readFile(killed.receipt, 'utf8'));
      expect(receipt.stage).toBe('admitted');
      expect((await stat(receipt.child.path)).isDirectory()).toBe(true);
    });

    it('命令保护尚未装配时在原生bash执行前明确失败，不运行用户命令', async () => {
      const directory = await realpath(
        await mkdtemp(join(tmpdir(), 'met267-uninitialized-')),
      );
      directories.push(directory);
      const guard = join(directory, 'bash-env.sh');
      const plan = await createVmMemoryGuestPlan({
        persistentDirectory: '/fixture/encrypted',
      });
      await writeFile(
        guard,
        plan.files.find((file) => file.path.endsWith('/bash-env.sh'))!.contents,
      );
      let result: { code?: number; stdout: string; stderr: string } | undefined;
      try {
        result = await execute(
          '/bin/bash',
          ['--noprofile', '--norc', '-c', 'printf "must-not-run\\n"'],
          {
            env: { PATH: '/usr/bin:/bin', BASH_ENV: guard },
          },
        );
      } catch (error) {
        result = error as { code: number; stdout: string; stderr: string };
      }
      expect(result?.code).toBe(75);
      expect(result?.stdout).toBe('');
      expect(result?.stderr).toContain('COMMAND_MEMORY_SETUP_FAILED');
    });

    it.each(
      (['memory.high', 'memory.max'] as const).flatMap((limit) =>
        (['mismatch', 'unreadable'] as const).map((kind) => ({ limit, kind })),
      ),
    )(
      '首次child的$limit已写但回读$kind时拒绝入组和执行',
      async ({ limit, kind }) => {
        const f = await bashGuest();
        const cat = join(f.directory, 'bin/cat');
        const original = await readFile(cat, 'utf8');
        await writeFile(
          cat,
          `#!/bin/sh
case "$1" in
  */${limit})
    /bin/cat "$1" > "$ALLRICE_MEMORY_CGROUP_ROOT/readback-written" || exit 99
    printf '%s' "\${1%/*}" > "$ALLRICE_MEMORY_CGROUP_ROOT/readback-child"
    ${kind === 'mismatch' ? "printf '0\\n'" : 'exit 1'}
    exit;;
esac
${original.replace('#!/bin/sh\n', '')}`,
        );
        const result = await f.run('printf "must-not-run\\n"');
        expect(result.code).toBe(75);
        expect(result.signal).toBe(null);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('COMMAND_MEMORY_SETUP_FAILED');
        expect(
          await readFile(join(f.directory, 'readback-written'), 'utf8'),
        ).toBe(
          String(
            limit === 'memory.high'
              ? VM_MEMORY_PHASE4_REFERENCE_POLICY.commandHighBytes
              : VM_MEMORY_PHASE4_REFERENCE_POLICY.commandMaxBytes,
          ) + '\n',
        );
        const child = await readFile(
          join(f.directory, 'readback-child'),
          'utf8',
        );
        await expect(
          readFile(join(child, 'cgroup.procs')),
        ).rejects.toMatchObject({
          code: 'ENOENT',
        });
      },
    );

    it.each(['-c', 'script'] as const)(
      'exec bash %s保持同PID受管命令的合法原生语义',
      async (kind) => {
        const f = await bashGuest();
        const script = join(f.directory, 'script.sh');
        await writeFile(script, 'printf "ok\\n"\n');
        const result = await f.run(
          kind === '-c'
            ? 'exec /bin/bash -c \'printf "ok\\n"\''
            : `exec /bin/bash '${script}'`,
        );
        expect('code' in result ? result.code : 0, JSON.stringify(result)).toBe(
          0,
        );
        expect(result.stdout).toBe('ok\n');
        expect(result.stderr).not.toContain('COMMAND_');
      },
    );

    it('exec bash重入沿用首次OOM基线，不因新shell启动抹去先前增量', async () => {
      const f = await bashGuest();
      const result = await f.run(
        'printf "oom 1\\noom_kill 1\\n" > "$allrice_memory_child/memory.events.local"; exec /bin/bash -c \'printf "ok\\n"\'',
      );
      expect('code' in result ? result.code : 0, JSON.stringify(result)).toBe(
        137,
      );
      expect(result.stdout).toBe('ok\n');
      expect(result.stderr).toContain('COMMAND_MEMORY_LIMIT');
    });

    it.each(['exec', 'signal'] as const)(
      'shell无法执行EXIT trap（%s）时保留原始退出，不能仅凭137或SIGKILL归因OOM',
      async (kind) => {
        const f = await bashGuest();
        const result = await f.run(
          'printf "oom 1\\noom_kill 1\\n" > "$allrice_memory_child/memory.events.local"; ' +
            'printf "ran-once\\n"; ' +
            (kind === 'exec'
              ? "exec /bin/sh -c 'exit 137'"
              : 'kill -KILL "$$"'),
        );
        expect(result.stdout).toBe('ran-once\n');
        expect(result.code).toBe(kind === 'exec' ? 137 : null);
        expect(result.signal).toBe(kind === 'exec' ? null : 'SIGKILL');
        expect(result.stderr).not.toContain('COMMAND_');
      },
    );

    it('EXIT时精确child计数不可读仍保留原始137，不冒称局部OOM', async () => {
      const f = await bashGuest();
      const result = await f.run(
        'rm "$allrice_memory_child/memory.events.local"; printf "ran-once\\n"; exit 137',
      );
      expect(result.code).toBe(137);
      expect(result.signal).toBe(null);
      expect(result.stdout).toBe('ran-once\n');
      expect(result.stderr).not.toContain('COMMAND_');
    });

    it.each(['birth', 'membership', 'limit'] as const)(
      '同PID重入的%s事实不符时拒绝，不运行新shell命令',
      async (kind) => {
        const f = await bashGuest();
        const mismatch =
          kind === 'birth'
            ? 'export ALLRICE_MEMORY_MANAGED_START=999'
            : kind === 'membership'
              ? 'printf "0::/dsh\\n" > "$ALLRICE_MEMORY_PROC_ROOT/$$/cgroup"'
              : 'printf 9 > "$allrice_memory_child/memory.max"';
        const result = await f.run(
          `${mismatch}; exec /bin/bash -c 'printf must-not-run'`,
        );
        expect(result.code).toBe(75);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('COMMAND_MEMORY_SETUP_FAILED');
      },
    );

    it.each([
      {
        events: 'oom 1\noom_kill 1\n',
        exit: 9,
        expected: 137,
        text: 'COMMAND_MEMORY_LIMIT',
      },
      {
        events: 'oom 0\noom_kill 1\n',
        exit: 9,
        expected: 137,
        text: 'COMMAND_OOM_KILLED',
      },
      { events: 'oom 0\noom_kill 0\n', exit: 137, expected: 137, text: '' },
      { events: 'oom 0\noom_kill 0\n', exit: 9, expected: 9, text: '' },
      { events: 'oom 0\noom_kill 0\n', exit: 0, expected: 0, text: '' },
    ])(
      '原生bash入口自动映射合成计数 $text / $exit；没有手工拼错误或重放命令',
      async (scenario) => {
        const directory = await realpath(
          await mkdtemp(join(tmpdir(), 'met267-guest-')),
        );
        directories.push(directory);
        const plan = await createVmMemoryGuestPlan({
          persistentDirectory: '/fixture/encrypted',
        });
        const bin = join(directory, 'bin');
        const commands = join(directory, 'commands');
        const dsh = join(directory, 'dsh');
        const proc = join(directory, 'proc');
        await Promise.all(
          [bin, commands, dsh, proc].map((file) => mkdir(file)),
        );
        const guard = join(directory, 'bash-env.sh');
        await writeFile(
          guard,
          plan.files.find((file) => file.path.endsWith('/bash-env.sh'))!
            .contents,
        );
        // Synthetic sysfs/proc: no actual kernel cgroup or score is changed.
        await writeSyntheticGuestBinaries(bin);
        const command =
          'printf "%s" "$SYNTHETIC_EVENTS" > "$allrice_memory_child/memory.events.local"; printf "ran-once\\n"; exit "$SYNTHETIC_EXIT"';
        let result: { stdout: string; stderr: string; code?: number };
        try {
          result = await execute(
            '/bin/bash',
            ['--noprofile', '--norc', '-c', command],
            {
              env: {
                ...plan.env,
                PATH: `${bin}:/usr/bin:/bin`,
                BASH_ENV: guard,
                ALLRICE_MEMORY_CGROUP_ROOT: directory,
                ALLRICE_MEMORY_COMMANDS_GROUP: commands,
                ALLRICE_MEMORY_DSH_GROUP: dsh,
                ALLRICE_MEMORY_PROC_ROOT: proc,
                SYNTHETIC_EVENTS: scenario.events,
                SYNTHETIC_EXIT: String(scenario.exit),
              },
            },
          );
        } catch (error) {
          result = error as { stdout: string; stderr: string; code: number };
        }
        expect(result.code ?? 0).toBe(scenario.expected);
        expect(result.stdout).toBe('ran-once\n');
        if (scenario.text) {
          expect(result.stderr).toContain(scenario.text);
          expect(result.stderr).toBe(
            scenario.text === 'COMMAND_MEMORY_LIMIT'
              ? 'COMMAND_MEMORY_LIMIT: 该命令内存/交换额度不足，请分批处理，会话保留\n'
              : 'COMMAND_OOM_KILLED: 该命令被内存回收终止，原因需核实，会话保留\n',
          );
        } else expect(result.stderr).not.toContain('COMMAND_');
        // Regular files emulate cgroup control files, so teardown removes them here.
        expect(await readFile(join(dsh, 'cgroup.procs'), 'utf8')).toMatch(
          /^\d+\n$/,
        );
      },
    );
  },
);
