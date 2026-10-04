import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuntimeLocalCommandSchema,
  RuntimeLocalCommandResultSchema,
  RuntimeProjectScopeSchema,
  RuntimeProjectPreparationEvidenceSchema,
  localProjectResultMatchesPayload,
  ProjectSnapshotSchema,
  type RuntimeLocalCommand,
  type RuntimeProjectScope,
  type RuntimeLocalCommandResult,
  ProjectServiceSourceUpdateSchema,
} from '@allrice/contracts';
import { mutateProjectCache, reserveProjectVolume } from './project-cache.js';
import type { LocalDockerApi } from './local-docker-api.js';
import {
  LocalCommandError,
  readLocalCommandInputs,
  readSavedProjectInputs,
} from './local-command-inputs.js';
import {
  ProjectEvents,
  projectStagingArchives,
  createLocalPythonArchive,
} from '@allrice/project-runtime';
import {
  projectCacheKey,
  projectSourceDigest,
  validateProjectPreparation,
  type ProjectPreparation,
} from './project-preparation.js';
import {
  nodeProjectSupervisor,
  pythonProjectSupervisor,
} from './project-supervisor.js';
import type { LocalCommandOutput } from './local-command-runner.js';
import type { ProjectServiceRunnerOptions } from './local-service-runner.js';
import { LocalServiceControl } from './local-service-control.js';

const attemptLabel = 'xyz.bplabs.allrice.attempt',
  payloadLabel = 'xyz.bplabs.allrice.project.payload',
  cacheLabel = 'xyz.bplabs.allrice.project.cache';
const digest = (command: RuntimeLocalCommand) =>
  createHash('sha256')
    .update(JSON.stringify(RuntimeLocalCommandSchema.parse(command)))
    .digest('hex');
type Options = {
  attemptId: string;
  leaseExpiresAt?: string;
  /** Absolute operation budget, including preflight and preparation. */
  deadlineUnixMs?: number;
  scope?: RuntimeProjectScope;
  signal?: AbortSignal;
  maintainLease?: () => Promise<boolean>;
  onOutput?: (chunk: LocalCommandOutput) => void;
  service?: ProjectServiceRunnerOptions;
};
type Container = {
  Id: string;
  Config: { Image: string; Labels: Record<string, string> };
  Mounts: { Type: string; Name: string; Destination: string }[];
  State: {
    Running: boolean;
    Status: string;
    ExitCode: number;
    OOMKilled: boolean;
  };
};
type Volume = {
  Name: string;
  Driver: string;
  Options: Record<string, string> | null;
  Labels: Record<string, string>;
};
type Exit = {
  reason: RuntimeLocalCommandResult['reason'];
  code: number;
  installation: 'succeeded' | 'failed' | 'interrupted';
};

/** Same operation ledger and Docker boundary, with immutable inputs on an
 * executable VM volume. Only package-manager cache persists between commands.
 */
export class ProjectCommandRunner {
  private probed = false;
  private probing?: Promise<void>;
  constructor(
    readonly input: {
      api: LocalDockerApi;
      preparation: ProjectPreparation;
      nodeImage: string;
      pythonImage: string;
      architecture: 'amd64' | 'arm64';
    },
  ) {}
  async preflight(signal?: AbortSignal) {
    signal?.throwIfAborted();
    for (const image of [this.input.nodeImage, this.input.pythonImage]) {
      const i = await this.input.api.json<{
        Id: string;
        Architecture: string;
        Os: string;
      }>('GET', `/images/${image}/json`);
      if (
        i.Id !== image ||
        i.Architecture !== this.input.architecture ||
        i.Os !== 'linux'
      )
        throw new LocalCommandError('TOOLCHAIN_CHANGED');
    }
    if (!this.probed) {
      this.probing ??= this.probe(signal)
        .then(() => {
          this.probed = true;
        })
        .finally(() => {
          this.probing = undefined;
        });
      await this.probing;
    }
    signal?.throwIfAborted();
    return {
      version: 1 as const,
      available: true as const,
      nodeImage: this.input.nodeImage,
      pythonImage: this.input.pythonImage,
      pnpmVersion: '10.33.3' as const,
      uvVersion: '0.8.22' as const,
    };
  }
  private async probe(signal?: AbortSignal) {
    const root = await mkdtemp(join(tmpdir(), 'allrice-project-probe-'));
    const scope = {
      organizationId: '00000000-0000-4000-8000-000000000001',
      workspaceId: '00000000-0000-4000-8000-000000000002',
      ownerId: '00000000-0000-4000-8000-000000000003',
    };
    try {
      for (const manager of ['pnpm', 'uv'] as const) {
        const contents =
          manager === 'pnpm'
            ? {
                'package.json':
                  '{"name":"allrice-project-probe","version":"1.0.0","packageManager":"pnpm@10.33.3"}',
                'pnpm-lock.yaml':
                  "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n",
                'probe.cjs':
                  "const fs=require('node:fs');const v=JSON.parse(fs.readFileSync('/tmp/work/tools/package/package.json')).version;if(v!=='10.33.3')throw Error(v);console.log('project pnpm probe: '+v)",
              }
            : {
                'requirements.lock': '',
                'probe.py':
                  "import subprocess,sys\nv=subprocess.check_output(['/tmp/work/tools/uv','--version'],text=True).strip()\nassert v.startswith('uv 0.8.22'),v\nassert sys.version.split()[0]=='3.11.13',sys.version\nprint('project uv probe: 0.8.22 / Python 3.11.13')\n",
              };
        const files = [];
        for (const [path, text] of Object.entries(contents)) {
          await writeFile(join(root, path), text!);
          files.push({
            path,
            sha256: `sha256:${createHash('sha256').update(text!).digest('hex')}`,
          });
        }
        files.sort((a, b) => a.path.localeCompare(b.path));
        const lockPath =
          manager === 'pnpm' ? 'pnpm-lock.yaml' : 'requirements.lock';
        let command = RuntimeLocalCommandSchema.parse({
          capability: 'local.process.execute',
          arguments: {
            executable:
              manager === 'pnpm'
                ? '/usr/local/bin/node'
                : '/workspace/.venv/bin/python',
            args: [manager === 'pnpm' ? 'probe.cjs' : 'probe.py'],
            path: '.',
            files,
            imageDigest:
              manager === 'pnpm'
                ? this.input.nodeImage
                : this.input.pythonImage,
            isolation: 'local-vm-container-v1',
            network: 'none',
            limits: {
              timeoutMs: 60000,
              outputBytes: 16384,
              memoryMiB: 512,
              cpuMillis: 1000,
              pids: 64,
            },
            projectPreparation: {
              version: 1,
              projectId: '00000000-0000-4000-8000-000000000004',
              sourceDigest: projectSourceDigest(files),
              lockChecksum: files.find((f) => f.path === lockPath)!.sha256,
              offline: false,
              manager,
              managerVersion: manager === 'pnpm' ? '10.33.3' : '0.8.22',
              lockPath,
              scripts: 'disabled',
              packages: [],
            },
          },
        });
        const snapshot = ProjectSnapshotSchema.parse({
          version: 1,
          projectId: command.arguments.projectPreparation!.projectId,
          sourceDigest: command.arguments.projectPreparation!.sourceDigest,
          files: files.map((f) => ({
            ...f,
            sizeBytes: Buffer.byteLength(
              contents[f.path as keyof typeof contents]!,
            ),
            contentBase64: Buffer.from(
              contents[f.path as keyof typeof contents]!,
            ).toString('base64'),
          })),
        });
        command = RuntimeLocalCommandSchema.parse({
          ...command,
          arguments: {
            ...command.arguments,
            projectSource: {
              version: 1,
              project: {
                projectId: snapshot.projectId,
                snapshot: {
                  kind: 'artifact',
                  id: randomUUID(),
                  checksum: `sha256:${createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')}`,
                },
              },
              snapshot,
              architecture: this.input.architecture,
              cacheKey: projectCacheKey({
                spec: command.arguments.projectPreparation!,
                scope,
                image: command.arguments.imageDigest,
                architecture: this.input.architecture,
              }),
              origin: {
                jobId: randomUUID(),
                workerId: randomUUID(),
                attempt: 0,
                leaseTokenDigest: '0'.repeat(64),
              },
            },
          },
        });
        const attemptId = randomUUID(),
          result = await this.execute(null, command, {
            attemptId,
            scope,
            signal: AbortSignal.any([
              AbortSignal.timeout(65000),
              ...(signal ? [signal] : []),
            ]),
          });
        try {
          if (
            result.reason !== 'exited' ||
            result.exitCode !== 0 ||
            result.projectPreparation?.installation !== 'succeeded' ||
            !localProjectResultMatchesPayload(command, result)
          )
            throw new LocalCommandError('PROJECT_RUNTIME_UNAVAILABLE');
        } finally {
          await this.cleanup(attemptId, result.containerId);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  private image(command: RuntimeLocalCommand) {
    return command.arguments.projectPreparation?.manager === 'uv'
      ? this.input.pythonImage
      : this.input.nodeImage;
  }
  async assertServiceTarget(
    attempt: string,
    id: string,
    command: RuntimeLocalCommand,
    serviceId: string,
  ) {
    const c = await this.inspect(attempt, id, command);
    const host = await this.input.api.json<{
      HostConfig: {
        NetworkMode: string;
        ReadonlyRootfs: boolean;
        Binds: unknown[] | null;
        PortBindings: Record<string, unknown> | null;
      };
    }>('GET', `/containers/${id}/json`);
    if (
      !c.State.Running ||
      c.Config.Labels['xyz.bplabs.allrice.service'] !== serviceId ||
      c.Config.Labels['xyz.bplabs.allrice.backend'] !==
        'local-vm-container-v1' ||
      host.HostConfig.NetworkMode !== 'none' ||
      !host.HostConfig.ReadonlyRootfs ||
      host.HostConfig.Binds?.length ||
      Object.keys(host.HostConfig.PortBindings ?? {}).length
    )
      throw new LocalCommandError('CONTAINER_IDENTITY_CHANGED');
  }
  private async inspect(
    attempt: string,
    id: string,
    command?: RuntimeLocalCommand,
  ) {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new LocalCommandError('INVALID_CONTAINER_ID');
    const c = await this.input.api.json<Container>(
      'GET',
      `/containers/${id}/json`,
    );
    if (
      c.Id !== id ||
      c.Config.Labels[attemptLabel] !== attempt ||
      (command &&
        (c.Config.Image !== this.image(command) ||
          c.Config.Labels[payloadLabel] !== digest(command))) ||
      !c.Mounts.some(
        (m) =>
          m.Type === 'volume' &&
          m.Name === `allrice-project-work-${attempt}` &&
          m.Destination === '/tmp/work',
      ) ||
      c.Mounts.some((m) => m.Type === 'bind')
    )
      throw new LocalCommandError('CONTAINER_IDENTITY_CHANGED');
    const cacheKey = c.Config.Labels[cacheLabel];
    if (
      !/^sha256:[a-f0-9]{64}$/.test(cacheKey ?? '') ||
      !c.Mounts.some(
        (m) =>
          m.Type === 'volume' &&
          m.Name === `allrice-project-cache-${cacheKey!.slice(7)}` &&
          m.Destination === '/cache',
      )
    )
      throw new LocalCommandError('CONTAINER_IDENTITY_CHANGED');
    await this.inspectVolume(`allrice-project-work-${attempt}`, {
      [attemptLabel]: attempt,
      [payloadLabel]: c.Config.Labels[payloadLabel]!,
      [cacheLabel]: cacheKey!,
    });
    await this.inspectVolume(`allrice-project-cache-${cacheKey!.slice(7)}`, {
      [cacheLabel]: cacheKey!,
    });
    return c;
  }
  private async inspectVolume(name: string, labels: Record<string, string>) {
    const volume = await this.input.api.json<Volume>('GET', `/volumes/${name}`);
    if (
      volume.Name !== name ||
      volume.Driver !== 'local' ||
      Object.keys(volume.Options ?? {}).length ||
      Object.entries(labels).some(
        ([key, value]) => volume.Labels?.[key] !== value,
      )
    )
      throw new LocalCommandError('PROJECT_CACHE_UNSAFE');
    return volume;
  }
  async execute(
    root: string | null,
    input: RuntimeLocalCommand,
    options: Options,
  ) {
    const command = RuntimeLocalCommandSchema.parse(input),
      a = command.arguments;
    if (
      !!a.background?.projectService !== !!options.service ||
      (options.service && !a.projectSource)
    )
      throw new LocalCommandError('SERVICE_CONFIG_INVALID');
    const serviceLease = options.service
      ? await options.service.maintainLease()
      : null;
    const previewHost = serviceLease?.projectService?.previewHost;
    if (
      options.service &&
      (!previewHost ||
        !previewHost.startsWith(`rice-preview-${options.service.processId}.`) ||
        !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(previewHost) ||
        serviceLease?.stopRequested ||
        Date.parse(serviceLease!.leaseExpiresAt) <= Date.now())
    )
      throw new LocalCommandError('SERVICE_PREVIEW_UNAVAILABLE');
    const scope = RuntimeProjectScopeSchema.safeParse(options.scope);
    if (!scope.success) throw new LocalCommandError('PROJECT_SCOPE_REQUIRED');
    if (
      !/^[a-f0-9-]{36}$/.test(options.attemptId) ||
      a.imageDigest !== this.image(command)
    )
      throw new LocalCommandError('TOOLCHAIN_CHANGED');
    const leaseDeadline =
      options.leaseExpiresAt === undefined
        ? Infinity
        : Date.parse(options.leaseExpiresAt) - 250;
    const operationDeadline =
      options.deadlineUnixMs ?? Date.now() + a.limits.timeoutMs;
    const deadlineUnixMs = Math.min(operationDeadline, leaseDeadline);
    if (!(deadlineUnixMs > Date.now()))
      throw new LocalCommandError('EXECUTION_REVOKED');
    const deadlineReason =
      operationDeadline <= leaseDeadline ? 'timeout' : 'lease_lost';
    const deadlineSignal = AbortSignal.timeout(
      Math.max(1, deadlineUnixMs - Date.now()),
    );
    if (
      a.projectSource
        ? root !== null ||
          a.projectSource.architecture !== this.input.architecture
        : root === null
    )
      throw new LocalCommandError('GRANT_MISMATCH');
    const bundle = a.projectSource
        ? readSavedProjectInputs(command)
        : await readLocalCommandInputs(root!, command),
      spec = validateProjectPreparation(command, bundle.files);
    const revoked = new AbortController(),
      signal = AbortSignal.any([
        revoked.signal,
        ...(options.signal ? [options.signal] : []),
        deadlineSignal,
      ]);
    const check = async () => {
      if (
        signal.aborted ||
        (options.maintainLease && !(await options.maintainLease()))
      ) {
        revoked.abort();
        throw new LocalCommandError('EXECUTION_REVOKED');
      }
    };
    let checking = false;
    let workVolumeCreated: string | undefined;
    let createdContainer: string | undefined;
    let startRequested = false;
    const heartbeat = setInterval(() => {
      if (checking) return;
      checking = true;
      void check()
        .catch(() => revoked.abort())
        .finally(() => {
          checking = false;
        });
    }, 1000);
    try {
      await check();
      const tool = await this.input.preparation.tool(
        spec.manager,
        this.input.architecture,
        signal,
        spec.offline,
      );
      const prepared = await this.input.preparation.archives({
        command,
        files: bundle.files,
        scope: scope.data,
        signal,
        maintainLease: options.maintainLease,
      });
      await check();
      const cacheKey = projectCacheKey({
        spec,
        scope: scope.data,
        image: this.image(command),
        architecture: this.input.architecture,
      });
      if (a.projectSource && a.projectSource.cacheKey !== cacheKey)
        throw new LocalCommandError('PROJECT_CACHE_UNSAFE');
      const cacheVolume = `allrice-project-cache-${cacheKey.slice(7)}`,
        workVolume = `allrice-project-work-${options.attemptId}`;
      const evidence = {
        version: 1,
        projectId: spec.projectId,
        sourceDigest: spec.sourceDigest,
        lockChecksum: spec.lockChecksum,
        cacheKey,
        manager: spec.manager,
        managerVersion: spec.managerVersion,
        platform: `linux-${this.input.architecture}`,
        runtimeImage: this.image(command),
        packageCount: spec.packages.length,
        archiveHits: prepared.archiveHits,
        downloadedArchives: prepared.downloadedArchives,
        downloadedBytes: prepared.downloadedBytes,
        cacheVolume,
        sourceDirectoryModified: false,
        hostEnvironmentModified: false,
      };
      const labels = {
        [attemptLabel]: options.attemptId,
        [payloadLabel]: digest(command),
        [cacheLabel]: cacheKey,
        'xyz.bplabs.allrice.project.evidence': JSON.stringify(evidence),
      };
      const c = await mutateProjectCache(
        this.input.api.socketPath,
        async () => {
          await reserveProjectVolume(this.input.api, cacheVolume);
          for (const [name, volumeLabels] of [
            [cacheVolume, { [cacheLabel]: cacheKey }],
            [workVolume, labels],
          ] as const) {
            const v = await this.input.api.json<Volume>(
              'POST',
              '/volumes/create',
              {
                Name: name,
                Driver: 'local',
                Labels: volumeLabels,
              },
            );
            if (
              v.Name !== name ||
              v.Driver !== 'local' ||
              Object.keys(v.Options ?? {}).length
            )
              throw new LocalCommandError('PROJECT_CACHE_UNSAFE');
            // Docker may omit labels from the create response for an existing
            // volume. Inspect the actual saved volume instead of relabeling it.
            await this.inspectVolume(name, volumeLabels);
            if (name === workVolume) workVolumeCreated = name;
          }
          return this.input.api.json<{ Id: string }>(
            'POST',
            `/containers/create?name=allrice-project-${options.attemptId}`,
            {
              Image: this.image(command),
              Entrypoint:
                spec.manager === 'pnpm'
                  ? ['/usr/local/bin/node']
                  : ['/opt/python/bin/python'],
              Cmd:
                spec.manager === 'pnpm'
                  ? ['--input-type=module', '--eval', nodeProjectSupervisor]
                  : ['-I', '-c', pythonProjectSupervisor],
              User: '0:0',
              WorkingDir: '/tmp/work',
              Tty: false,
              OpenStdin: !!options.service,
              StdinOnce: false,
              ...(options.service
                ? {
                    Env: [
                      `ALLRICE_SERVICE_ID=${options.service.processId}`,
                      `ALLRICE_SERVICE_ATTEMPT=${options.attemptId}`,
                      `ALLRICE_SERVICE_PREVIEW_HOST=${previewHost}`,
                    ],
                  }
                : {}),
              Labels: {
                ...labels,
                ...(options.service
                  ? {
                      'xyz.bplabs.allrice.service': options.service.processId,
                      'xyz.bplabs.allrice.backend': 'local-vm-container-v1',
                    }
                  : {}),
              },
              HostConfig: {
                NetworkMode: 'none',
                ReadonlyRootfs: true,
                CapDrop: ['ALL'],
                CapAdd: [
                  'CHOWN',
                  'FOWNER',
                  'DAC_OVERRIDE',
                  'SETUID',
                  'SETGID',
                  'KILL',
                ],
                SecurityOpt: ['no-new-privileges'],
                PidsLimit: a.limits.pids,
                Memory: a.limits.memoryMiB * 1024 ** 2,
                MemorySwap: a.limits.memoryMiB * 1024 ** 2,
                CpuPeriod: 100000,
                CpuQuota: a.limits.cpuMillis * 100,
                Mounts: [
                  { Type: 'volume', Source: workVolume, Target: '/tmp/work' },
                  { Type: 'volume', Source: cacheVolume, Target: '/cache' },
                ],
                Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=32m,mode=1777' },
                ShmSize: 16 * 1024 ** 2,
                LogConfig: {
                  Type: 'json-file',
                  Config: { 'max-size': '1m', 'max-file': '1' },
                },
                RestartPolicy: { Name: 'no' },
                AutoRemove: false,
                Ulimits: [
                  { Name: 'nofile', Soft: 256, Hard: 256 },
                  { Name: 'core', Soft: 0, Hard: 0 },
                ],
              },
            },
          );
        },
      );
      const id = c.Id;
      createdContainer = id;
      await this.inspect(options.attemptId, id, command);
      if (options.service)
        await options.service.onEvent({
          type: 'starting',
          processId: options.service.processId,
          attemptId: options.attemptId,
          sequence: 0,
          containerId: id,
          hardDeadlineAt: options.service.hardDeadlineAt,
        });
      let start: Promise<unknown> | undefined,
        stopPromise: Promise<void> | undefined,
        stopReason: Exit['reason'] | undefined;
      const stop = (why: Exit['reason']) => {
        stopReason ??= why;
        return (stopPromise ??= (async () => {
          await start?.catch(() => undefined);
          const c = await this.inspect(options.attemptId, id, command);
          if (c.State.Running)
            await this.input.api.json(
              'POST',
              `/containers/${id}/kill?signal=KILL`,
            );
          if (
            (await this.inspect(options.attemptId, id, command)).State.Running
          )
            throw new LocalCommandError('STOP_NOT_CONFIRMED');
        })());
      };
      const abortReason = (): Exit['reason'] =>
        options.signal?.aborted
          ? 'canceled'
          : deadlineSignal.aborted
            ? deadlineReason
            : 'lease_lost';
      const abort = () => {
        void stop(abortReason()).catch(() => undefined);
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        for (const bytes of projectStagingArchives({
          command,
          files: bundle.files,
          tool,
          prepared,
          deadlineUnixMs,
          deadlineReason,
        }))
          await this.input.api.putArchive(id, '/tmp/work', bytes, signal);
        await check();
        startRequested = true;
        start = this.input.api.json('POST', `/containers/${id}/start`);
        await start;
        if (signal.aborted) await stop(abortReason());
        const observed = options.service
          ? await this.readService(id, command, options.service, signal, stop)
          : await this.read(
              id,
              a.limits.outputBytes,
              a.limits.timeoutMs + 15000,
              options.onOutput,
              a.outputs,
            );
        await stopPromise;
        const c = await this.inspect(options.attemptId, id, command);
        if (c.State.Running || c.State.Status !== 'exited')
          throw new LocalCommandError('STOP_NOT_CONFIRMED');
        const reason = this.exitReason(c, observed.exit, stopReason);
        return RuntimeLocalCommandResultSchema.parse({
          backend: 'local-vm-container-v1',
          containerId: id,
          imageDigest: this.image(command),
          stopped: true,
          exitCode: c.State.ExitCode,
          reason,
          stdout: observed.stdout,
          stderr: observed.stderr,
          truncated: observed.truncated,
          workCopy: 'local_isolated_copy',
          sourceDirectoryModified: false,
          ...(a.outputs
            ? {
                artifacts:
                  reason === 'exited' && c.State.ExitCode === 0
                    ? observed.artifacts
                    : [],
              }
            : {}),
          projectPreparation: {
            ...evidence,
            installation: stopReason
              ? 'interrupted'
              : (observed.exit?.installation ?? 'failed'),
            ...(a.projectSource
              ? {
                  savedSource: {
                    project: a.projectSource.project,
                    restoredDigest: observed.sourceDigest ?? null,
                  },
                }
              : {}),
          },
        });
      } catch (e) {
        await stop('supervisor_failed').catch(() => undefined);
        if (!start) {
          await this.cleanup(options.attemptId, id);
          if (e instanceof LocalCommandError) throw e;
          throw new LocalCommandError('EXECUTION_REVOKED');
        }
        throw new LocalCommandError('RUNNER_RESULT_UNKNOWN');
      } finally {
        signal.removeEventListener('abort', abort);
      }
    } catch (error) {
      // Remove only resources whose identity was verified, and only before a
      // start request. An uncertain started attempt stays for journal recovery.
      if (!startRequested) {
        if (createdContainer) {
          await this.cleanup(options.attemptId, createdContainer).catch(
            () => undefined,
          );
        } else if (workVolumeCreated) {
          await this.inspectVolume(workVolumeCreated, {
            [attemptLabel]: options.attemptId,
            [payloadLabel]: digest(command),
          })
            .then(() =>
              this.input.api.json('DELETE', `/volumes/${workVolumeCreated}`),
            )
            .catch(() => undefined);
        }
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }
  /** Same container, dependency preparation and physical receipt as foreground
   * projects. Only trusted PID1 owns control; source changes are journaled before
   * staging and acknowledged before the server advances its visible revision. */
  private async readService(
    id: string,
    command: RuntimeLocalCommand,
    options: ProjectServiceRunnerOptions,
    signal: AbortSignal,
    stop: (reason: Exit['reason']) => Promise<void>,
  ) {
    let sequence = 0,
      control: LocalServiceControl | undefined,
      busy = false,
      ended = false;
    const acks = new Map<
      number,
      {
        resolve: () => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    let facts = Promise.resolve();
    const events = new ProjectEvents(
      command.arguments.limits.outputBytes,
      (output) => {
        facts = facts.then(() => options.onOutput?.(output));
      },
      [],
      (event) => {
        if (event.type === 'control_ack') {
          const ack = acks.get(Number(event.sequence));
          if (!ack) throw new LocalCommandError('INVALID_CONTROL_ACK');
          clearTimeout(ack.timer);
          acks.delete(Number(event.sequence));
          ack.resolve();
        } else if (event.type === 'service') {
          const value = event.event as Parameters<
            ProjectServiceRunnerOptions['onEvent']
          >[0];
          if (
            value.processId !== options.processId ||
            value.attemptId !== options.attemptId ||
            value.type !== 'ready'
          )
            throw new LocalCommandError('SERVICE_ACK_MISMATCH');
          facts = facts.then(() => options.onEvent(value));
        } else
          facts = facts.then(() =>
            options.onSourceApplied?.({
              updateId: String(event.updateId),
              sourceDigest: String(event.sourceDigest),
            }),
          );
        void facts.catch(() => stop('lease_lost').catch(() => undefined));
      },
    );
    const send = async (frame: Record<string, unknown>) => {
      const index = sequence++;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          acks.delete(index);
          reject(new LocalCommandError('SERVICE_CONTROL_TIMEOUT'));
        }, 2000);
        acks.set(index, { resolve, reject, timer });
        void control!
          .send({ ...frame, attemptId: options.attemptId, sequence: index })
          .catch((error) => {
            clearTimeout(timer);
            acks.delete(index);
            reject(error);
          });
      });
    };
    const logs = this.input.api.logs(
      id,
      (bytes) => events.push(bytes),
      Math.max(1000, Date.parse(options.hardDeadlineAt) - Date.now()) + 15000,
    );
    void logs.catch(() => stop('supervisor_failed').catch(() => undefined));
    let tickTask: Promise<void> | undefined,
      timer: ReturnType<typeof setInterval> | undefined;
    const tick = async () => {
      if (busy || ended) return;
      busy = true;
      try {
        const lease = await options.maintainLease();
        if (ended) return;
        const deadline = Math.min(
          Date.parse(options.hardDeadlineAt),
          Date.parse(lease.leaseExpiresAt),
          Date.now() + 5000,
        );
        if (lease.stopRequested || signal.aborted || deadline <= Date.now()) {
          await stop(signal.aborted ? 'canceled' : 'lease_lost');
          return;
        }
        await send({ type: 'renew', leaseDeadlineMs: deadline });
        const update = lease.projectService?.sourceUpdate;
        if (update) {
          const parsed = ProjectServiceSourceUpdateSchema.parse(update);
          if (!options.prepareSource || !options.onSourceApplied)
            throw new LocalCommandError('SERVICE_SOURCE_JOURNAL_REQUIRED');
          if ((await options.prepareSource(parsed)) === 'new') {
            await this.inspect(options.attemptId, id, command);
            const bytes = Buffer.from(JSON.stringify(parsed)),
              checksum =
                'sha256:' + createHash('sha256').update(bytes).digest('hex');
            await this.input.api.putArchive(
              id,
              '/tmp/work',
              createLocalPythonArchive([
                {
                  path: '.allrice/source-' + parsed.updateId + '.json',
                  bytes,
                  mode: 0o444,
                },
              ]),
              signal,
            );
            // Staging cannot authorize applying beyond the short lease.
            await send({ type: 'source', updateId: parsed.updateId, checksum });
            await facts;
          }
        }
      } catch {
        if (!ended) await stop('lease_lost').catch(() => undefined);
      } finally {
        busy = false;
      }
    };
    try {
      control = await LocalServiceControl.connect(
        this.input.api.socketPath,
        id,
      );
      await tick();
      timer = setInterval(() => {
        if (!tickTask)
          tickTask = tick().finally(() => {
            tickTask = undefined;
          });
      }, 1000);
      await logs;
      ended = true;
      await facts;
      return events.finish();
    } finally {
      ended = true;
      clearInterval(timer);
      control?.close();
      for (const a of acks.values()) {
        clearTimeout(a.timer);
        a.reject(new LocalCommandError('SERVICE_CONTROL_UNAVAILABLE'));
      }
      acks.clear();
      await tickTask?.catch(() => undefined);
    }
  }
  private async read(
    id: string,
    maximum: number,
    timeout: number,
    onOutput?: Options['onOutput'],
    outputs?: RuntimeLocalCommand['arguments']['outputs'],
    serviceReceiptOnly = false,
  ) {
    // Recovery reads trusted facts only after killing the original container.
    // Accept its service/source receipts without renewing or replaying controls.
    const events = new ProjectEvents(
      maximum,
      onOutput,
      outputs,
      serviceReceiptOnly ? () => undefined : undefined,
    );
    await this.input.api.logs(id, (bytes) => events.push(bytes), timeout);
    return events.finish();
  }

  async recover(attempt: string, command: RuntimeLocalCommand) {
    let c: Container;
    try {
      c = await this.input.api.json<Container>(
        'GET',
        `/containers/allrice-project-${attempt}/json`,
      );
    } catch (e) {
      if (e instanceof LocalCommandError && e.code === 'DAEMON_HTTP_404')
        return null;
      throw e;
    }
    c = await this.inspect(attempt, c.Id, command);
    if (c.State.Running)
      await this.input.api.json('POST', `/containers/${c.Id}/kill?signal=KILL`);
    if (c.State.Status === 'created') return null;
    const observed = await this.read(
      c.Id,
      command.arguments.limits.outputBytes,
      10000,
      undefined,
      command.arguments.outputs,
      !!command.arguments.background?.projectService,
    );
    c = await this.inspect(attempt, c.Id, command);
    if (c.State.Running || c.State.Status !== 'exited')
      throw new LocalCommandError('STOP_NOT_CONFIRMED');
    const spec = command.arguments.projectPreparation!;
    const evidence = RuntimeProjectPreparationEvidenceSchema.parse({
      ...JSON.parse(c.Config.Labels['xyz.bplabs.allrice.project.evidence']!),
      installation: observed.exit?.installation ?? 'interrupted',
      ...(command.arguments.projectSource
        ? {
            savedSource: {
              project: command.arguments.projectSource.project,
              restoredDigest: observed.sourceDigest ?? null,
            },
          }
        : {}),
    });
    if (
      evidence.sourceDigest !== spec.sourceDigest ||
      evidence.lockChecksum !== spec.lockChecksum ||
      evidence.projectId !== spec.projectId ||
      evidence.runtimeImage !== command.arguments.imageDigest
    )
      throw new LocalCommandError('CONTAINER_IDENTITY_CHANGED');
    const result = RuntimeLocalCommandResultSchema.parse({
      backend: 'local-vm-container-v1',
      containerId: c.Id,
      imageDigest: c.Config.Image,
      stopped: true,
      exitCode: c.State.ExitCode,
      reason: this.exitReason(c, observed.exit, undefined, 'lease_lost'),
      stdout: observed.stdout,
      stderr: observed.stderr,
      truncated: observed.truncated,
      workCopy: 'local_isolated_copy',
      sourceDirectoryModified: false,
      ...(command.arguments.outputs
        ? {
            artifacts:
              this.exitReason(c, observed.exit, undefined, 'lease_lost') ===
                'exited' && c.State.ExitCode === 0
                ? observed.artifacts
                : [],
          }
        : {}),
      projectPreparation: evidence,
    });
    if (!localProjectResultMatchesPayload(command, result))
      throw new LocalCommandError('CONTAINER_IDENTITY_CHANGED');
    return result;
  }
  private exitReason(
    c: Container,
    exit?: Exit,
    stoppedFor?: Exit['reason'],
    missing: Exit['reason'] = 'supervisor_failed',
  ): Exit['reason'] {
    if (c.State.Running || c.State.Status !== 'exited')
      throw new LocalCommandError('STOP_NOT_CONFIRMED');
    if (c.State.OOMKilled) return 'memory_limit';
    return (
      stoppedFor ?? (exit?.code === c.State.ExitCode ? exit.reason : missing)
    );
  }
  async cleanup(attempt: string, id: string) {
    const c = await this.inspect(attempt, id);
    if (c.State.Running) throw new LocalCommandError('STOP_NOT_CONFIRMED');
    await this.input.api.json('DELETE', `/containers/${id}`);
    await this.input.api.json(
      'DELETE',
      `/volumes/allrice-project-work-${attempt}`,
    );
  }
}
