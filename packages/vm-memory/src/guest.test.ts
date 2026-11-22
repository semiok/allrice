import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  realpath,
  readFile,
  writeFile,
  mkdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VM_MEMORY_PHASE4_REFERENCE_POLICY } from './contract.ts';
import type { GuestMemorySample, VmMemoryPolicy } from './contract.ts';
import { createVmMemoryGuestPlan as createPlan } from './guest-config.ts';

// Explicit historical policy is a fixture choice, never a production fallback.
const createVmMemoryGuestPlan = (input: { persistentDirectory: string }) =>
  createPlan({
    ...input,
    policy: VM_MEMORY_PHASE4_REFERENCE_POLICY,
    policyRef: 'fixture:phase4-reference-not-product-approval',
  });

const require = createRequire(import.meta.url);
type Config = {
  contractVersion: number;
  policyRef: string;
  cgroupRoot: string;
  dshGroup: string;
  commandsGroup: string;
  procRoot: string;
  swapFile: string;
  policy: VmMemoryPolicy;
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

async function virtualGuest() {
  const plan = await createVmMemoryGuestPlan({
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
  const env = {
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

    it.each(['mismatch', 'unreadable'] as const)(
      '初始化限额写入后回读%s仍失败，不能返回设置成功',
      async (kind) => {
        const f = await virtualGuest();
        const target = join(f.config.commandsGroup, 'memory.max');
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
          String(f.config.policy.commandMaxBytes),
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
        if (scenario.text) expect(result.stderr).toContain(scenario.text);
        else expect(result.stderr).not.toContain('COMMAND_');
        // Regular files emulate cgroup control files, so teardown removes them here.
        expect(await readFile(join(dsh, 'cgroup.procs'), 'utf8')).toMatch(
          /^\d+\n$/,
        );
      },
    );
  },
);
