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
import type { ManagedPythonPayloadRelease } from '@allrice/contracts';
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
  }
  private environment() {
    return managedSandboxEnvironment(this.vmHome, this.tools);
  }
  private async extract(archive: string, target: string, signal: AbortSignal) {
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
    await exec('/usr/bin/tar', ['-xzf', archive, '-C', target], {
      signal,
      timeout: 60_000,
      maxBuffer: 4096,
    });
  }
  async prepareManaged(signal: AbortSignal) {
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
      return this.runner.preflight(signal);
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
      await downloadManagedRuntimeAsset(
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
        await this.extract(
          join(this.root, 'archives', distribution.lima.fileName),
          stage,
          signal,
        );
        await this.extract(
          join(this.root, 'archives', distribution.agents.fileName),
          stage,
          signal,
        );
        await this.extract(
          join(this.root, 'archives', distribution.docker.fileName),
          stage,
          signal,
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
    // Every resume is bounded and rewrites our fixed flags, not user defaults.
    try {
      await exec(
        binary,
        managedSandboxStartArguments(
          join(this.root, 'archives', distribution.guest.fileName),
          distribution.nativeArchitecture,
        ),
        {
          env: this.environment(),
          signal,
          timeout: 180_000,
          maxBuffer: 256_000,
        },
      );
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
      assertManagedSandboxConfiguration(yaml);
      try {
        return await this.runner.preflight(signal);
      } catch (error) {
        if (
          !(error instanceof LocalCommandError) ||
          error.code !== 'DAEMON_HTTP_404'
        )
          throw error;
      }
      const archive = await downloadManagedRuntimeAsset(
        join(this.root, 'archives', this.release.archive.fileName),
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
      void archive;
      await this.runner.api.loadImageArchive(
        createReadStream(
          join(this.root, 'archives', this.release.archive.fileName),
        ),
        this.release.archive.sizeBytes,
        signal,
      );
      return await this.runner.preflight(signal, true);
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }
  async prepareNodeImage(signal: AbortSignal) {
    signal.throwIfAborted();
    const release = managedNodePayloadForPlatform(`macos-${process.arch}`);
    if (!this.started || !release)
      throw new LocalCommandError('PROJECT_RUNTIME_UNAVAILABLE');
    const inspect = async () => {
      const image = await this.runner.api.json<{
        Id: string;
        Architecture: string;
        Os: string;
      }>('GET', `/images/${release.imageId}/json`);
      if (
        image.Id !== release.imageId ||
        image.Architecture !== release.architecture ||
        image.Os !== 'linux'
      )
        throw new LocalCommandError('TOOLCHAIN_CHANGED');
    };
    try {
      await inspect();
      return;
    } catch (error) {
      if (
        !(error instanceof LocalCommandError) ||
        error.code !== 'DAEMON_HTTP_404'
      )
        throw error;
    }
    const path = join(this.root, 'archives', release.archive.fileName);
    await downloadManagedRuntimeAsset(
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
    await this.runner.api.loadImageArchive(
      createReadStream(path),
      release.archive.sizeBytes,
      signal,
    );
    await inspect();
  }
  async stop() {
    const binary = join(this.tools, 'bin', 'colima');
    if (!(await lstat(binary).catch(() => null))) return;
    // Only our private profile; no global/default/Node VM stop or removal.
    await exec(binary, ['stop', '--profile', managedSandboxProfile], {
      env: this.environment(),
      timeout: 30_000,
      maxBuffer: 65_536,
    });
    this.started = false;
  }
}
