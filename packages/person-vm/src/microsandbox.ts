import { lstat, readlink, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  PersonVmError,
  PERSON_VM_MEMORY_MIB,
  type PersonVmBinding,
  type PersonVmEgressReceipt,
} from './contract.ts';
import { privateDirectory } from './encrypted-disk.ts';
import { hostEnvironment, runCommand, type CommandRunner } from './process.ts';

export interface PersonVmNativePort {
  prepare(
    binding: PersonVmBinding,
    mount: string,
    signal: AbortSignal,
  ): Promise<void>;
  status(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<'absent' | 'stopped' | 'running' | 'unknown'>;
  create(
    binding: PersonVmBinding,
    receipt: PersonVmEgressReceipt,
    signal: AbortSignal,
  ): Promise<void>;
  start(binding: PersonVmBinding, signal: AbortSignal): Promise<void>;
  stop(binding: PersonVmBinding, signal: AbortSignal): Promise<void>;
  ping(binding: PersonVmBinding, signal: AbortSignal): Promise<void>;
}

/** Uses only the pinned public CLI. Does not edit Microsandbox's private DB. */
export class MicrosandboxPersonVm implements PersonVmNativePort {
  private readonly run: CommandRunner;
  private readonly homes = new Map<
    string,
    { home: string; config: string; userHome: string }
  >();
  constructor(
    private readonly options: {
      binary: string;
      libkrunfw: string;
      agentd: string;
      image: string;
      rootDiskGiB: number;
      socketRoot: string;
      runner?: CommandRunner;
    },
  ) {
    this.run = options.runner ?? runCommand;
    if (
      ![
        options.binary,
        options.libkrunfw,
        options.agentd,
        options.socketRoot,
      ].every(isAbsolute) ||
      !/^.+@sha256:[a-f0-9]{64}$/.test(options.image) ||
      !Number.isInteger(options.rootDiskGiB) ||
      options.rootDiskGiB <= 0
    )
      throw new PersonVmError('PROVIDER_FAILED');
  }
  private name(binding: PersonVmBinding) {
    return `allrice-${binding.vmId}`;
  }
  private async command(
    binding: PersonVmBinding,
    args: string[],
    signal: AbortSignal,
  ) {
    const paths = this.homes.get(binding.vmId);
    if (!paths) throw new PersonVmError('PROVIDER_FAILED');
    return this.run({
      executable: this.options.binary,
      args,
      signal,
      env: {
        ...hostEnvironment(paths.userHome),
        MSB_HOME: paths.home,
        MSB_CONFIG_PATH: paths.config,
      },
    });
  }
  async prepare(binding: PersonVmBinding, mount: string, signal: AbortSignal) {
    await privateDirectory(this.options.socketRoot);
    const target = join(mount, 'microsandbox');
    await privateDirectory(target);
    const userHome = join(mount, 'host-home');
    await privateDirectory(userHome);
    const home = join(this.options.socketRoot, binding.vmId);
    if (Buffer.byteLength(home) > 70)
      throw new PersonVmError('PROVIDER_FAILED');
    try {
      const stat = await lstat(home);
      if (!stat.isSymbolicLink() || (await readlink(home)) !== target)
        throw new PersonVmError('PROVIDER_FAILED');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await symlink(target, home, 'dir');
    }
    const config = join(mount, 'msb-config.json');
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        home,
        allowed_backends: ['local'],
        paths: {
          msb: this.options.binary,
          libkrunfw: this.options.libkrunfw,
          agentd: this.options.agentd,
          ...Object.fromEntries(
            [
              'cache',
              'sandboxes',
              'volumes',
              'snapshots',
              'logs',
              'secrets',
            ].map((name) => [name, join(home, name)]),
          ),
        },
        sandbox_defaults: {
          cpus: 2,
          memory_mib: PERSON_VM_MEMORY_MIB,
          oci: {
            root_disk: {
              kind: 'flat',
              size_mib: this.options.rootDiskGiB * 1024,
              clone: 'auto',
            },
          },
        },
      }),
      { mode: 0o600 },
    );
    this.homes.set(binding.vmId, { home, config, userHome });
    const version = await this.command(binding, ['--version'], signal);
    if (!/\b0\.7\.16\b/.test(version))
      throw new PersonVmError('PROVIDER_FAILED');
  }
  async status(binding: PersonVmBinding, signal: AbortSignal) {
    const rows: unknown = JSON.parse(
      await this.command(binding, ['list', '--format', 'json'], signal),
    );
    if (!Array.isArray(rows)) throw new PersonVmError('PROVIDER_FAILED');
    const matches = rows.filter(
      (value: unknown) =>
        value &&
        typeof value === 'object' &&
        'name' in value &&
        value.name === this.name(binding),
    );
    if (matches.length === 0) return 'absent' as const;
    if (matches.length !== 1) throw new PersonVmError('PROVIDER_FAILED');
    const status = (matches[0] as { status?: string }).status;
    if (status === 'Running') return 'running' as const;
    if (status === 'Stopped' || status === 'Created' || status === 'Crashed')
      return 'stopped' as const;
    return 'unknown' as const;
  }
  async create(
    binding: PersonVmBinding,
    receipt: PersonVmEgressReceipt,
    signal: AbortSignal,
  ) {
    if ((await this.status(binding, signal)) !== 'absent')
      throw new PersonVmError('PROVIDER_FAILED');
    await this.command(
      binding,
      ['pull', this.options.image, '--materialize', 'flat', '--quiet'],
      signal,
    );
    const args = [
      'create',
      this.options.image,
      '--name',
      this.name(binding),
      '--pull',
      'never',
      '--cpus',
      '2',
      '--max-cpus',
      '2',
      '--memory',
      '2048M',
      '--max-memory',
      '2048M',
      '--root-disk',
      `flat:${this.options.rootDiskGiB}G`,
      '--net-default',
      'deny',
      '--mkdir',
      '/work',
      '--workdir',
      '/work',
    ];
    for (const port of receipt.gatewayPorts)
      args.push('--net-rule', `allow:egress@host:tcp:${port}`);
    // No native idle-timeout: detached DSH jobs may be active without touching it.
    await this.command(binding, args, signal);
  }
  async start(binding: PersonVmBinding, signal: AbortSignal) {
    await this.command(binding, ['start', this.name(binding)], signal);
  }
  async stop(binding: PersonVmBinding, signal: AbortSignal) {
    const state = await this.status(binding, signal);
    if (state === 'absent' || state === 'stopped') return;
    await this.command(binding, ['stop', this.name(binding)], signal);
    const after = await this.status(binding, signal);
    if (after !== 'stopped' && after !== 'absent')
      throw new PersonVmError('CLEANUP_INCOMPLETE');
  }
  async ping(binding: PersonVmBinding, signal: AbortSignal) {
    await this.command(binding, ['ping', this.name(binding)], signal);
  }
  /** Trusted host diagnostics/bootstrap only; no guest-provided executable/arguments. */
  async exec(
    binding: PersonVmBinding,
    args: readonly string[],
    signal: AbortSignal,
  ) {
    return this.command(
      binding,
      ['exec', this.name(binding), '--', ...args],
      signal,
    );
  }
}
