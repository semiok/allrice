import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  BridgePreparationProgress,
  ManagedPythonPayloadRelease,
} from '@allrice/contracts';
import { managedNodePayloadForPlatform } from '@allrice/contracts';
import { configPath, type BridgeConfig } from './config.js';
import { LocalCommandError } from './local-command-inputs.js';
import {
  downloadManagedRuntimeAsset,
  runtimeAssetMatches as matches,
} from '@allrice/project-runtime';
import { LocalPythonRunner } from './local-python-runner.js';
import {
  managedSandboxProfile,
  managedSandboxReleases,
  managedSandboxVersion,
} from './managed-sandbox-release.js';
import { managedSandboxLicenses } from './managed-sandbox-licenses.js';
import {
  OwnedStopProcessExitUnconfirmed,
  runOwnedStopProcess,
} from './owned-stop-process.js';
import {
  withPreparationStep,
  type PreparationObserver,
  type PreparationStep,
} from './preparation-progress.js';

const exec = promisify(execFile);
async function privateDirectory(path: string) {
  await mkdir(path, { mode: 0o700 }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  const s = await lstat(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid?.() ||
    (s.mode & 0o077) !== 0
  )
    throw new LocalCommandError('UNSAFE_RUNTIME_DIRECTORY');
}
export { downloadManagedRuntimeAsset } from '@allrice/project-runtime';

export function managedSandboxEnvironment(
  root: string,
  tools: string,
): NodeJS.ProcessEnv {
  return {
    PATH: `${join(tools, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    LANG: 'C.UTF-8',
    COLIMA_HOME: join(root, 'c'),
    COLIMA_CACHE_HOME: join(root, 'cache'),
    LIMA_HOME: join(root, 'c', '_lima'),
    DOCKER_CONFIG: join(root, 'docker-config'),
    COLIMA_SAVE_CONFIG: 'true',
  };
}
export function managedSandboxVMHome(
  config: BridgeConfig,
  path = configPath(),
) {
  const identity = createHash('sha256')
    .update(
      JSON.stringify({
        path,
        server: config.server,
        deviceId: config.deviceId,
      }),
    )
    .digest('hex')
    .slice(0, 16);
  const home = join(
    '/private/var/tmp',
    `ar1-${process.getuid?.() ?? 'unsupported'}-${identity}`,
  );
  // Lima checks its temporary OpenSSH socket too, not only docker.sock.
  if (
    Buffer.byteLength(
      join(
        home,
        'c',
        '_lima',
        `colima-${managedSandboxProfile}`,
        'ssh.sock.1234567890123456',
      ),
    ) >= 104
  )
    throw new LocalCommandError('RUNTIME_SOCKET_PATH_TOO_LONG');
  return home;
}
export function managedSandboxStartArguments(
  guest: string,
  architecture: string,
) {
  return [
    'start',
    '--profile',
    managedSandboxProfile,
    '--runtime',
    'docker',
    '--vm-type',
    'vz',
    '--arch',
    architecture,
    '--cpus',
    '2',
    '--memory',
    '2',
    '--disk',
    '8',
    '--root-disk',
    '8',
    '--mount',
    'none',
    '--template=false',
    '--ssh-agent=false',
    '--ssh-config=false',
    '--activate=false',
    '--port-forwarder=none',
    '--network-address=false',
    '--binfmt=false',
    '--kubernetes=false',
    '--disk-image',
    guest,
    '--force-disk-image=false',
  ];
}

/** The effective Lima config is checked in addition to passing --mount none;
 * Colima's default mounts must never turn into host business-folder authority. */
export function assertManagedSandboxConfiguration(yaml: string) {
  // Pinned Colima omits its nil Mounts slice for --mount none. Pinned Lima
  // combines only explicit/default/override mounts; it adds no built-in mount.
  if (
    (/^mounts:/m.test(yaml) && !/^mounts:\s*(?:\[\]|null)\s*$/m.test(yaml)) ||
    !/^vmType:\s*vz\s*$/m.test(yaml) ||
    !/^cpus:\s*2\s*$/m.test(yaml) ||
    !/^memory:\s*(?:2GiB|2048MiB|2147483648)\s*$/m.test(yaml) ||
    /^\s*forwardAgent:\s*true\s*$/m.test(yaml)
  )
    throw new LocalCommandError('UNSAFE_VM_CONFIGURATION');
}

export class ManagedPythonSandbox {
  readonly root: string;
  readonly runner: LocalPythonRunner;
  readonly vmHome: string;
  private readonly tools: string;
  private started = false;
  private vmStartRequested = false;
  private ownedExitUnconfirmed = false;
  private vmPreparation: Promise<void> | undefined;
  private vmStop: Promise<void> | undefined;
  // Includes TERM, KILL and exit observation; status has its own bounded read.
  private readonly processTimeouts = {
    start: 180_000,
    stop: 25_000,
    status: 5_000,
  };
  readonly preparation = new Map<
    BridgePreparationProgress['component'],
    BridgePreparationProgress
  >();
  onPreparation?: () => void;
  onPreparationStep?: PreparationObserver;
  private step<T>(
    component: BridgePreparationProgress['component'],
    step: PreparationStep,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ) {
    return withPreparationStep(
      this.onPreparationStep,
      component,
      step,
      async () => {
        signal?.throwIfAborted();
        const value = await operation();
        signal?.throwIfAborted();
        return value;
      },
    );
  }
  private readonly downloadFailures = new Map<
    BridgePreparationProgress['component'],
    unknown
  >();
  private lastProgressNotice = 0;
  private progress(
    component: BridgePreparationProgress['component'],
    stage: BridgePreparationProgress['stage'],
    detail: Partial<BridgePreparationProgress> = {},
  ) {
    const previous = this.preparation.get(component);
    const next: BridgePreparationProgress = {
      component,
      stage,
      receivedBytes: 0,
      attempt: 0,
      resumed: false,
      ...previous,
      ...detail,
      updatedAt: new Date().toISOString(),
    };
    next.stage = stage;
    this.preparation.set(component, next);
    if (
      stage !== 'downloading' ||
      previous?.stage !== stage ||
      Date.now() - this.lastProgressNotice > 500
    ) {
      this.lastProgressNotice = Date.now();
      this.onPreparation?.();
    }
  }
  private async prepareComponent<T>(
    component: BridgePreparationProgress['component'],
    prepare: () => Promise<T>,
  ): Promise<T> {
    // Download retries are finite. Explicit "prepare" restarts the controller
    // with a new instance; it reuses the verified archives and saved fragments.
    if (this.downloadFailures.has(component))
      throw this.downloadFailures.get(component);
    if (this.preparation.get(component)?.stage !== 'ready')
      this.progress(component, 'preparing', { reason: undefined });
    try {
      const result = await prepare();
      this.progress(component, 'ready');
      return result;
    } catch (error) {
      const reason =
        error instanceof LocalCommandError
          ? error.code
          : 'RUNTIME_PREPARATION_FAILED';
      this.progress(component, 'failed', {
        reason: /^[A-Z][A-Z0-9_]{0,79}$/.test(reason)
          ? reason
          : 'RUNTIME_PREPARATION_FAILED',
      });
      throw error;
    }
  }
  private async download(
    component: BridgePreparationProgress['component'],
    path: string,
    asset: Parameters<typeof downloadManagedRuntimeAsset>[1],
    signal: AbortSignal,
  ) {
    try {
      await this.step(component, 'download', signal, () =>
        downloadManagedRuntimeAsset(path, asset, signal, {
          onProgress: (progress) =>
            this.progress(component, progress.stage, progress),
        }),
      );
    } catch (error) {
      this.downloadFailures.set(component, error);
      throw error;
    }
    this.progress(component, 'installing', {
      receivedBytes: asset.sizeBytes,
      expectedBytes: asset.sizeBytes,
      reason: undefined,
    });
  }
  constructor(
    readonly config: BridgeConfig,
    readonly release: ManagedPythonPayloadRelease,
  ) {
    this.root = `${configPath()}.managed-python-v1-${config.deviceId}`;
    this.vmHome = managedSandboxVMHome(config);
    this.tools = join(this.root, managedSandboxVersion);
    this.runner = new LocalPythonRunner({
      release,
      socketPath: join(this.vmHome, 'c', managedSandboxProfile, 'docker.sock'),
    });
    this.runner.onPreparationStep = (event) => this.onPreparationStep?.(event);
  }
  private environment() {
    return managedSandboxEnvironment(this.vmHome, this.tools);
  }
  private async extract(archive: string, target: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const { stdout } = await exec('/usr/bin/tar', ['-tzf', archive], {
      signal,
      timeout: 30_000,
      maxBuffer: 1_000_000,
    });
    if (
      stdout
        .split('\n')
        .filter(Boolean)
        .some((path) => path.startsWith('/') || path.split('/').includes('..'))
    )
      throw new LocalCommandError('RUNTIME_ARCHIVE_UNSAFE');
    signal.throwIfAborted();
    await exec('/usr/bin/tar', ['-xzf', archive, '-C', target], {
      signal,
      timeout: 60_000,
      maxBuffer: 4096,
    });
  }
  /** VM setup is single-flight; image preparation is independent per runtime. */
  async prepareVM(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.vmPreparation) {
      this.vmPreparation = this.prepareComponent('vm', () =>
        this.startVM(signal),
      ).finally(() => {
        this.vmPreparation = undefined;
      });
    }
    // The flight already owns startup/cleanup effects. A synchronous observer
    // cancellation must still join it before reporting the preparation ended.
    const preparation = this.vmPreparation;
    await withPreparationStep(
      this.onPreparationStep,
      'vm',
      'vm_wait',
      () => preparation,
    );
    signal.throwIfAborted();
  }
  private async startVM(signal: AbortSignal) {
    const platform =
      process.platform === 'darwin' &&
      (process.arch === 'x64' || process.arch === 'arm64')
        ? (`macos-${process.arch}` as const)
        : null;
    if (
      !platform ||
      this.release.platform !== platform ||
      !this.release.nativeSupported
    )
      throw new LocalCommandError('UNSUPPORTED_NATIVE_PLATFORM');
    const [{ stdout: mac }, { stdout: hypervisor }] = await Promise.all([
      exec('/usr/bin/sw_vers', ['-productVersion'], {
        signal,
        timeout: 3000,
        maxBuffer: 1024,
      }),
      exec('/usr/sbin/sysctl', ['-n', 'kern.hv_support'], {
        signal,
        timeout: 3000,
        maxBuffer: 1024,
      }),
    ]);
    const [major, minor] = mac.trim().split('.').map(Number);
    signal.throwIfAborted();
    if (
      !major ||
      major < 13 ||
      (major === 13 && minor! < 5) ||
      hypervisor.trim() !== '1'
    )
      throw new LocalCommandError('NATIVE_VM_UNAVAILABLE');
    await privateDirectory(this.root);
    await privateDirectory(join(this.root, 'archives'));
    await privateDirectory(this.vmHome);
    if (this.started) {
      assertManagedSandboxConfiguration(
        await readFile(
          join(
            this.vmHome,
            'c',
            '_lima',
            `colima-${managedSandboxProfile}`,
            'lima.yaml',
          ),
          'utf8',
        ),
      );
      return;
    }
    const distribution = managedSandboxReleases[platform];
    const assets = [
      distribution.colima,
      distribution.lima,
      distribution.agents,
      distribution.docker,
      distribution.guest,
      ...managedSandboxLicenses,
    ];
    const free = await statfs(this.root);
    if (
      free.bavail * free.bsize <
      5 * 1024 * 1024 * 1024 +
        assets.reduce((sum, a) => sum + a.sizeBytes, 0) +
        this.release.archive.sizeBytes
    )
      throw new LocalCommandError('RUNTIME_DISK_SPACE_REQUIRED');
    for (const asset of assets)
      await this.download(
        'vm',
        join(this.root, 'archives', asset.fileName),
        asset,
        signal,
      );
    // Rebuild tools from verified archives in a private, atomic release path.
    if (!(await lstat(this.tools).catch(() => null))) {
      const stage = join(
        this.root,
        `${managedSandboxVersion}.${randomUUID()}.part`,
      );
      await privateDirectory(stage);
      await privateDirectory(join(stage, 'bin'));
      try {
        await this.step('vm', 'extract', signal, () =>
          this.extract(
            join(this.root, 'archives', distribution.lima.fileName),
            stage,
            signal,
          ),
        );
        await this.step('vm', 'extract', signal, () =>
          this.extract(
            join(this.root, 'archives', distribution.agents.fileName),
            stage,
            signal,
          ),
        );
        await this.step('vm', 'extract', signal, () =>
          this.extract(
            join(this.root, 'archives', distribution.docker.fileName),
            stage,
            signal,
          ),
        );
        await copyFile(
          join(this.root, 'archives', 'colima'),
          join(stage, 'bin', 'colima'),
        );
        await chmod(join(stage, 'bin', 'colima'), 0o700);
        await copyFile(
          join(stage, 'docker', 'docker'),
          join(stage, 'bin', 'docker'),
        );
        await chmod(join(stage, 'bin', 'docker'), 0o700);
        await privateDirectory(join(stage, 'licenses'));
        for (const license of managedSandboxLicenses)
          await copyFile(
            join(this.root, 'archives', license.fileName),
            join(stage, 'licenses', license.fileName),
          );
        await writeFile(
          join(stage, 'release.json'),
          JSON.stringify({ version: managedSandboxVersion, assets }),
          { mode: 0o600 },
        );
        signal.throwIfAborted();
        await rename(stage, this.tools);
      } finally {
        await rm(stage, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
    for (const directory of ['c', 'cache', 'docker-config'])
      await privateDirectory(join(this.vmHome, directory));
    // Lima merges these private global files with the instance YAML. Nothing
    // may add a host mount behind an otherwise safe generated configuration.
    for (const file of ['default.yaml', 'override.yaml']) {
      const global = await readFile(
        join(this.vmHome, 'c', '_lima', '_config', file),
        'utf8',
      ).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      });
      if (/^mounts:/m.test(global))
        throw new LocalCommandError('UNSAFE_VM_CONFIGURATION');
    }
    const binary = join(this.tools, 'bin', 'colima'),
      stat = await lstat(binary);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o022 ||
      !(await matches(binary, distribution.colima))
    )
      throw new LocalCommandError('RUNTIME_TOOL_CHANGED');
    signal.throwIfAborted();
    await this.launchVM(
      binary,
      managedSandboxStartArguments(
        join(this.root, 'archives', distribution.guest.fileName),
        distribution.nativeArchitecture,
      ),
      signal,
    );
  }
  private async launchVM(binary: string, args: string[], signal: AbortSignal) {
    // Every resume is bounded and rewrites our fixed flags, not user defaults.
    try {
      await this.step('vm', 'vm_start', signal, async () => {
        this.vmStartRequested = true;
        const result = await runOwnedStopProcess(binary, args, {
          env: this.environment(),
          signal,
          timeoutMs: this.processTimeouts.start,
          maxBuffer: 256_000,
        });
        signal.throwIfAborted();
        if (result.exitCode !== 0 || result.interrupted)
          throw new LocalCommandError('NATIVE_VM_UNAVAILABLE');
      });
      this.started = true;
      signal.throwIfAborted();
      const yaml = await readFile(
        join(
          this.vmHome,
          'c',
          '_lima',
          `colima-${managedSandboxProfile}`,
          'lima.yaml',
        ),
        'utf8',
      );
      signal.throwIfAborted();
      assertManagedSandboxConfiguration(yaml);
    } catch (error) {
      if (error instanceof OwnedStopProcessExitUnconfirmed)
        this.ownedExitUnconfirmed = true;
      // Only failed VM startup owns this cleanup. An image download must never
      // stop the shared VM or invalidate another already-ready runtime.
      try {
        await this.stop();
      } catch (cleanupError) {
        const unknown = new LocalCommandError('STOP_NOT_CONFIRMED');
        unknown.cause = new AggregateError([error, cleanupError]);
        throw unknown;
      }
      throw error;
    }
  }
  async prepareManaged(signal: AbortSignal) {
    await this.prepareVM(signal);
    return this.prepareComponent('python', () => this.preparePython(signal));
  }
  private importImage(
    component: 'python' | 'node',
    path: string,
    size: number,
    signal: AbortSignal,
  ) {
    return this.step(component, 'image_import', signal, async () => {
      const stream = createReadStream(path, { signal });
      // The Engine verifies its socket before attaching pipeline listeners.
      // Cancellation in that await must not emit an unhandled stream error.
      stream.on('error', () => undefined);
      try {
        await this.runner.api.loadImageArchive(stream, size, signal);
      } finally {
        stream.destroy();
      }
    });
  }
  private async preparePython(signal: AbortSignal) {
    signal.throwIfAborted();
    try {
      const result = await this.runner.preflight(signal);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      if (
        !(error instanceof LocalCommandError) ||
        error.code !== 'DAEMON_HTTP_404'
      )
        throw error;
    }
    const path = join(this.root, 'archives', this.release.archive.fileName);
    await this.download(
      'python',
      path,
      {
        ...this.release.archive,
        sha256: this.release.archive.sha256.replace(/^sha256:/, ''),
        url: new URL(
          `/api/v1/bridge/runtime-assets/v1/linux-${this.release.architecture}/${this.release.archive.sha256.replace(/^sha256:/, '')}.docker.tar.gz`,
          this.config.server,
        ).toString(),
      },
      signal,
    );
    await this.importImage(
      'python',
      path,
      this.release.archive.sizeBytes,
      signal,
    );
    signal.throwIfAborted();
    const result = await this.runner.preflight(signal, true);
    signal.throwIfAborted();
    return result;
  }
  async prepareNodeImage(signal: AbortSignal) {
    await this.prepareVM(signal);
    return this.prepareComponent('node', () => this.prepareNode(signal));
  }
  private async prepareNode(signal: AbortSignal) {
    signal.throwIfAborted();
    const release = managedNodePayloadForPlatform(`macos-${process.arch}`);
    if (!this.started || !release)
      throw new LocalCommandError('PROJECT_RUNTIME_UNAVAILABLE');
    const inspect = () =>
      this.step('node', 'image_check', signal, async () => {
        const image = await this.step('node', 'engine_socket', signal, () =>
          this.runner.api.json<{
            Id: string;
            Architecture: string;
            Os: string;
          }>(
            'GET',
            `/images/${release.imageId}/json`,
            undefined,
            15_000,
            signal,
          ),
        );
        signal.throwIfAborted();
        if (
          image.Id !== release.imageId ||
          image.Architecture !== release.architecture ||
          image.Os !== 'linux'
        )
          throw new LocalCommandError('TOOLCHAIN_CHANGED');
      });
    try {
      await inspect();
      return;
    } catch (error) {
      signal.throwIfAborted();
      if (
        !(error instanceof LocalCommandError) ||
        error.code !== 'DAEMON_HTTP_404'
      )
        throw error;
    }
    const path = join(this.root, 'archives', release.archive.fileName);
    await this.download(
      'node',
      path,
      {
        ...release.archive,
        sha256: release.archive.sha256.slice('sha256:'.length),
        url: new URL(
          `/api/v1/bridge/runtime-assets/v1/linux-${release.architecture}/${release.archive.sha256.slice('sha256:'.length)}.docker.tar.gz`,
          this.config.server,
        ).toString(),
      },
      signal,
    );
    await this.importImage('node', path, release.archive.sizeBytes, signal);
    await inspect();
  }
  async stop() {
    if (!this.vmStop)
      this.vmStop = this.stopVM().finally(() => {
        this.vmStop = undefined;
      });
    return this.vmStop;
  }
  private async stopVM() {
    try {
      await this.stopAndConfirmVM();
    } catch (cause) {
      const error = new LocalCommandError('STOP_NOT_CONFIRMED');
      error.cause = cause;
      throw error;
    }
  }
  private async stopAndConfirmVM() {
    const binary = join(this.tools, 'bin', 'colima');
    const exists = (path: string) =>
      lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    if (!(await exists(binary))) {
      // Download-only cancellation before any start has no owned VM effect.
      // Existing profile metadata or any attempted start needs a real query.
      if (
        !this.started &&
        !this.vmStartRequested &&
        !this.ownedExitUnconfirmed &&
        !(await exists(
          join(this.vmHome, 'c', '_lima', `colima-${managedSandboxProfile}`),
        ))
      )
        return;
      throw new LocalCommandError('STOP_NOT_CONFIRMED');
    }
    // Only our private profile; no global/default/Node VM stop or removal.
    let stopFailure: unknown;
    try {
      await this.step('vm', 'vm_stop', undefined, async () => {
        const result = await runOwnedStopProcess(
          binary,
          ['stop', '--profile', managedSandboxProfile],
          {
            env: this.environment(),
            timeoutMs: this.processTimeouts.stop,
          },
        );
        if (result.exitCode !== 0 || result.interrupted) {
          const error = new LocalCommandError('VM_STOP_COMMAND_FAILED');
          error.cause = result;
          throw error;
        }
      });
    } catch (error) {
      stopFailure = error;
      if (error instanceof OwnedStopProcessExitUnconfirmed)
        this.ownedExitUnconfirmed = true;
      // Even a failed/killed CLI can have stopped the VM. Only the independent
      // profile read below can confirm that; a successful CLI alone cannot.
    }
    try {
      await this.step('vm', 'vm_status', undefined, async () => {
        let result;
        try {
          result = await runOwnedStopProcess(
            binary,
            ['list', '--profile', managedSandboxProfile, '--json'],
            {
              env: this.environment(),
              timeoutMs: this.processTimeouts.status,
            },
          );
        } catch (error) {
          if (error instanceof OwnedStopProcessExitUnconfirmed)
            this.ownedExitUnconfirmed = true;
          throw error;
        }
        if (
          result.exitCode !== 0 ||
          result.interrupted ||
          this.ownedExitUnconfirmed
        ) {
          const error = new LocalCommandError('STOP_NOT_CONFIRMED');
          error.cause = result;
          throw error;
        }
        // Pinned Colima 0.10.3 `list --json` emits one JSON object per line and
        // --profile filters to this profile. Empty success means no such VM.
        const rows: unknown[] = result.stdout
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
        if (
          rows.length > 1 ||
          rows.some(
            (row) =>
              !row ||
              typeof row !== 'object' ||
              !('name' in row) ||
              row.name !== managedSandboxProfile ||
              !('status' in row) ||
              row.status !== 'Stopped',
          )
        )
          throw new LocalCommandError('STOP_NOT_CONFIRMED');
      });
    } catch (statusFailure) {
      if (stopFailure) throw new AggregateError([stopFailure, statusFailure]);
      throw statusFailure;
    }
    this.started = false;
    this.vmStartRequested = false;
  }
}
