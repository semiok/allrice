import {
  RuntimeLocalCommandSchema,
  RuntimeLocalCommandResultSchema,
  localCommandToolchainImageV1,
  type RuntimeLocalCommand,
  type RuntimeLocalCommandResult,
} from '@allrice/contracts';
import { LocalCommandOutputFilter } from './local-command-output.js';

import { LocalDockerApi } from './local-docker-api.js';
import {
  LocalCommandError,
  readLocalCommandInputs,
} from './local-command-inputs.js';
import { localCommandSupervisor } from './local-command-supervisor.js';

interface Container {
  Id: string;
  Config: { Image: string; Labels: Record<string, string> };
  State: {
    Running: boolean;
    Status: string;
    ExitCode: number;
    OOMKilled: boolean;
    FinishedAt: string;
  };
}
type StopReason = RuntimeLocalCommandResult['reason'];
export interface LocalCommandOutput {
  sequence: number;
  stream: 'stdout' | 'stderr';
  text: string;
}

const label = 'xyz.bplabs.allrice.attempt';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Explicit, fixed local backend. Callers still need current server approval and leases. */
export class LocalCommandRunner {
  readonly api: LocalDockerApi;
  constructor(readonly config: { socketPath: string; imageDigest: string }) {
    if (config.imageDigest !== localCommandToolchainImageV1)
      throw new LocalCommandError('PINNED_IMAGE_REQUIRED');
    this.api = new LocalDockerApi(config.socketPath);
  }

  async preflight() {
    await this.api.verifySocket();
    const info = await this.api.json<{
      OSType: string;
      CgroupVersion: string;
      MemoryLimit: boolean;
      SwapLimit: boolean;
      PidsLimit: boolean;
      CpuCfsQuota: boolean;
      SecurityOptions: string[];
    }>('GET', '/info');
    if (
      info.OSType !== 'linux' ||
      info.CgroupVersion !== '2' ||
      !info.MemoryLimit ||
      !info.SwapLimit ||
      !info.PidsLimit ||
      !info.CpuCfsQuota ||
      !info.SecurityOptions.some((s) => s.startsWith('name=seccomp'))
    ) {
      throw new LocalCommandError('ISOLATION_UNAVAILABLE');
    }
    const image = await this.api.json<{
      Id: string;
      Os: string;
      Architecture: string;
    }>('GET', `/images/${this.config.imageDigest}/json`);
    if (image.Id !== this.config.imageDigest || image.Os !== 'linux')
      throw new LocalCommandError('TOOLCHAIN_CHANGED');
    return {
      backend: 'local-vm-container-v1' as const,
      imageDigest: image.Id,
      architecture: image.Architecture,
    };
  }

  async execute(
    root: string,
    input: RuntimeLocalCommand,
    options: {
      attemptId: string;
      signal?: AbortSignal;
      leaseExpiresAt?: string;
      onOutput?: (chunk: LocalCommandOutput) => void;
      /** Revalidates policy, grant, cancellation and attempt independently of execution. */
      maintainLease?: () => Promise<boolean>;
    },
  ): Promise<RuntimeLocalCommandResult> {
    const command = RuntimeLocalCommandSchema.parse(input);
    if (!uuid.test(options.attemptId))
      throw new LocalCommandError('INVALID_ATTEMPT');
    if (command.arguments.imageDigest !== this.config.imageDigest)
      throw new LocalCommandError('TOOLCHAIN_CHANGED');
    await this.preflight();
    const bundle = await readLocalCommandInputs(root, command);
    if (
      options.signal?.aborted ||
      (options.maintainLease && !(await options.maintainLease()))
    )
      throw new LocalCommandError('EXECUTION_REVOKED');
    const leaseDeadline =
      options.leaseExpiresAt === undefined
        ? Infinity
        : Date.parse(options.leaseExpiresAt);
    if (!(leaseDeadline > Date.now() + 500))
      throw new LocalCommandError('EXECUTION_REVOKED');
    const deadlineUnixMs = Math.min(
      Date.now() + command.arguments.limits.timeoutMs,
      leaseDeadline - 250,
    );
    const encoded = Buffer.from(
      JSON.stringify({ ...bundle, deadlineUnixMs }),
    ).toString('base64');
    const parts = encoded.match(/.{1,32768}/g) ?? [];
    const limits = command.arguments.limits;
    const container = await this.api.json<{ Id: string }>(
      'POST',
      `/containers/create?name=allrice-${options.attemptId}`,
      {
        Image: this.config.imageDigest,
        Entrypoint: ['/usr/local/bin/node'],
        Cmd: ['--input-type=module', '--eval', localCommandSupervisor],
        User: '0:0',
        WorkingDir: '/',
        OpenStdin: false,
        Tty: false,
        Env: [
          `ALLRICE_INPUT_PARTS=${parts.length}`,
          ...parts.map((part, i) => `ALLRICE_INPUT_${i}=${part}`),
        ],
        Labels: {
          [label]: options.attemptId,
          'xyz.bplabs.allrice.backend': 'local-vm-container-v1',
        },
        HostConfig: {
          NetworkMode: 'none',
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          CapAdd: ['CHOWN', 'SETUID', 'SETGID'],
          SecurityOpt: ['no-new-privileges'],
          PidsLimit: limits.pids,
          Memory: limits.memoryMiB * 1024 * 1024,
          MemorySwap: limits.memoryMiB * 1024 * 1024,
          CpuPeriod: 100_000,
          CpuQuota: limits.cpuMillis * 100,
          Tmpfs: {
            '/workspace': 'rw,nosuid,nodev,size=32m,mode=0755',
            '/tmp': 'rw,nosuid,nodev,noexec,size=16m,mode=1777',
          },
          ShmSize: 16 * 1024 * 1024,
          LogConfig: {
            Type: 'json-file',
            Config: { 'max-size': '1m', 'max-file': '1' },
          },
          RestartPolicy: { Name: 'no' },
          AutoRemove: false,
          Ulimits: [
            { Name: 'nofile', Soft: 128, Hard: 128 },
            { Name: 'core', Soft: 0, Hard: 0 },
          ],
        },
      },
    );
    const id = container.Id;
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new LocalCommandError('INVALID_CONTAINER_ID');
    let stoppedFor: StopReason | null = null,
      stopPromise: Promise<void> | undefined;
    const stop = (reason: StopReason) => {
      stoppedFor ??= reason;
      stopPromise ??= this.api
        .json('POST', `/containers/${id}/kill?signal=KILL`)
        .then(() => undefined)
        .catch(async () => {
          const state = await this.inspect(options.attemptId, id);
          if (state.State.Running)
            throw new LocalCommandError('STOP_NOT_CONFIRMED');
        });
      return stopPromise;
    };
    let stdout = '',
      stderr = '',
      pending = '',
      sequence = 0,
      receivedBytes = 0;
    const filters = {
      stdout: new LocalCommandOutputFilter(),
      stderr: new LocalCommandOutputFilter(),
    };
    let publishedBytes = 0,
      outputTruncated = false;
    const publish = (stream: 'stdout' | 'stderr', text: string) => {
      if (!text) return;
      const available = limits.outputBytes - publishedBytes;
      if (Buffer.byteLength(text) > available) {
        outputTruncated = true;
        return;
      }
      publishedBytes += Buffer.byteLength(text);
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      options.onOutput?.({ sequence: sequence++, stream, text });
    };
    let exit: { reason: StopReason; code: number } | null = null;
    let heartbeatBusy = false;
    // Cancel/lease failure before start cannot be undone by a delayed start request.
    if (
      options.signal?.aborted ||
      Date.now() >= deadlineUnixMs ||
      (options.maintainLease && !(await options.maintainLease()))
    ) {
      await this.api.json('DELETE', `/containers/${id}`);
      throw new LocalCommandError('EXECUTION_REVOKED');
    }
    await this.api.json('POST', `/containers/${id}/start`);
    const onAbort = () => {
      void stop('canceled').catch(() => undefined);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const wallTimer = setTimeout(
      () => {
        void stop('timeout').catch(() => undefined);
      },
      Math.max(1, deadlineUnixMs - Date.now()),
    );
    const heartbeat = setInterval(() => {
      if (!options.maintainLease || heartbeatBusy) return;
      heartbeatBusy = true;
      void options
        .maintainLease()
        .then((allowed) => (allowed ? undefined : stop('lease_lost')))
        .catch(() => stop('lease_lost'))
        .catch(() => undefined)
        .finally(() => {
          heartbeatBusy = false;
        });
    }, 1000);
    try {
      await this.api.logs(
        id,
        (bytes) => {
          pending += bytes.toString('utf8');
          if (pending.length > 250_000)
            throw new LocalCommandError('INVALID_SUPERVISOR_OUTPUT');
          for (
            let newline = pending.indexOf('\n');
            newline >= 0;
            newline = pending.indexOf('\n')
          ) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            const event = JSON.parse(line) as Record<string, unknown>;
            if (
              (event.type === 'stdout' || event.type === 'stderr') &&
              typeof event.data === 'string'
            ) {
              const buffer = Buffer.from(event.data, 'base64');
              receivedBytes += buffer.length;
              if (receivedBytes > limits.outputBytes)
                throw new LocalCommandError('SUPERVISOR_OUTPUT_LIMIT');
              publish(event.type, filters[event.type].push(buffer));
            } else if (event.type === 'exit') {
              if (
                ![
                  'exited',
                  'timeout',
                  'output_limit',
                  'memory_limit',
                  'supervisor_failed',
                ].includes(String(event.reason)) ||
                !Number.isInteger(event.code)
              )
                throw new LocalCommandError('INVALID_SUPERVISOR_EXIT');
              exit = {
                reason: event.reason as StopReason,
                code: Number(event.code),
              };
            } else if (event.type !== 'signal')
              throw new LocalCommandError('INVALID_SUPERVISOR_OUTPUT');
          }
        },
        limits.timeoutMs + 15_000,
      );
      if (stopPromise) await stopPromise;
      for (const stream of ['stdout', 'stderr'] as const)
        publish(stream, filters[stream].push(Buffer.alloc(0), true));
      const inspected = await this.inspect(options.attemptId, id);
      if (inspected.State.Running || inspected.State.Status !== 'exited')
        throw new LocalCommandError('STOP_NOT_CONFIRMED');
      const observed = exit as { reason: StopReason; code: number } | null;
      const reason = inspected.State.OOMKilled
        ? 'memory_limit'
        : (stoppedFor ??
          (observed?.code === inspected.State.ExitCode
            ? observed.reason
            : 'supervisor_failed'));
      return RuntimeLocalCommandResultSchema.parse({
        backend: 'local-vm-container-v1',
        containerId: id,
        imageDigest: this.config.imageDigest,
        stopped: true,
        exitCode: inspected.State.ExitCode,
        reason,
        stdout,
        stderr,
        truncated:
          reason === 'output_limit' ||
          pending.length > 0 ||
          outputTruncated ||
          filters.stdout.truncated ||
          filters.stderr.truncated,
        workCopy: 'local_isolated_copy',
        sourceDirectoryModified: false,
      });
    } catch {
      await stop('supervisor_failed').catch(() => undefined);
      // Docker evidence is retained. Transport failure never fabricates a stopped result.
      throw new LocalCommandError('RUNNER_RESULT_UNKNOWN');
    } finally {
      clearTimeout(wallTimer);
      clearInterval(heartbeat);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Reconcile ONLY a journal-owned unknown attempt. Never start/replay it. */
  async recover(
    attemptId: string,
    input: RuntimeLocalCommand,
  ): Promise<RuntimeLocalCommandResult | null> {
    await this.api.verifySocket();
    if (!uuid.test(attemptId)) throw new LocalCommandError('INVALID_ATTEMPT');
    const command = RuntimeLocalCommandSchema.parse(input);
    if (command.arguments.imageDigest !== this.config.imageDigest)
      throw new LocalCommandError('TOOLCHAIN_CHANGED');
    let existing: Container;
    try {
      existing = await this.api.json<Container>(
        'GET',
        `/containers/allrice-${attemptId}/json`,
      );
    } catch (error) {
      if (
        error instanceof LocalCommandError &&
        error.code === 'DAEMON_HTTP_404'
      )
        return null;
      throw error;
    }
    const before = await this.inspect(attemptId, existing.Id);
    // A running orphan has no live Bridge authorization loop. Stop it, do not
    // resume solely because the daemon survived the previous Bridge process.
    if (before.State.Running)
      await this.api.json(
        'POST',
        `/containers/${existing.Id}/kill?signal=KILL`,
      );
    if (before.State.Status === 'created') return null;
    let pending = '',
      stdout = '',
      stderr = '',
      rawBytes = 0;
    const filters = {
      stdout: new LocalCommandOutputFilter(),
      stderr: new LocalCommandOutputFilter(),
    };
    let observed: { reason: StopReason; code: number } | null = null;
    await this.api.logs(
      existing.Id,
      (bytes) => {
        pending += bytes.toString('utf8');
        while (pending.includes('\n')) {
          const index = pending.indexOf('\n'),
            line = pending.slice(0, index);
          pending = pending.slice(index + 1);
          const event = JSON.parse(line) as Record<string, unknown>;
          if (
            (event.type === 'stdout' || event.type === 'stderr') &&
            typeof event.data === 'string'
          ) {
            const buffer = Buffer.from(event.data, 'base64');
            rawBytes += buffer.length;
            if (rawBytes > command.arguments.limits.outputBytes)
              throw new LocalCommandError('SUPERVISOR_OUTPUT_LIMIT');
            const text = filters[event.type].push(buffer);
            if (event.type === 'stdout') stdout += text;
            else stderr += text;
          } else if (
            event.type === 'exit' &&
            Number.isInteger(event.code) &&
            [
              'exited',
              'timeout',
              'output_limit',
              'memory_limit',
              'supervisor_failed',
            ].includes(String(event.reason))
          ) {
            observed = {
              reason: event.reason as StopReason,
              code: Number(event.code),
            };
          } else if (event.type !== 'signal')
            throw new LocalCommandError('INVALID_SUPERVISOR_OUTPUT');
        }
      },
      5000,
    );
    stdout += filters.stdout.push(Buffer.alloc(0), true);
    stderr += filters.stderr.push(Buffer.alloc(0), true);
    const state = await this.inspect(attemptId, existing.Id);
    if (state.State.Running || state.State.Status !== 'exited')
      throw new LocalCommandError('STOP_NOT_CONFIRMED');
    const terminal = observed as { reason: StopReason; code: number } | null;
    let truncated =
      pending.length > 0 ||
      filters.stdout.truncated ||
      filters.stderr.truncated;
    if (
      Buffer.byteLength(stdout) + Buffer.byteLength(stderr) >
      command.arguments.limits.outputBytes
    ) {
      stdout = '';
      stderr = '';
      truncated = true;
    }
    const reason = state.State.OOMKilled
      ? 'memory_limit'
      : terminal?.code === state.State.ExitCode
        ? terminal.reason
        : before.State.Running
          ? 'lease_lost'
          : 'supervisor_failed';
    return RuntimeLocalCommandResultSchema.parse({
      backend: 'local-vm-container-v1',
      containerId: existing.Id,
      imageDigest: this.config.imageDigest,
      stopped: true,
      exitCode: state.State.ExitCode,
      reason,
      stdout,
      stderr,
      truncated: truncated || reason === 'output_limit',
      workCopy: 'local_isolated_copy',
      sourceDirectoryModified: false,
    });
  }

  async inspect(attemptId: string, id: string) {
    if (!uuid.test(attemptId) || !/^[a-f0-9]{64}$/.test(id))
      throw new LocalCommandError('INVALID_CONTAINER_ID');
    const container = await this.api.json<Container>(
      'GET',
      `/containers/${id}/json`,
    );
    if (
      container.Id !== id ||
      container.Config.Labels[label] !== attemptId ||
      container.Config.Image !== this.config.imageDigest
    )
      throw new LocalCommandError('CONTAINER_IDENTITY_CHANGED');
    return container;
  }

  /** Call only AFTER the corresponding evidence is durable in the Bridge journal. */
  async cleanup(attemptId: string, id: string) {
    const container = await this.inspect(attemptId, id);
    if (container.State.Running || container.State.Status !== 'exited')
      throw new LocalCommandError('STOP_NOT_CONFIRMED');
    await this.api.json('DELETE', `/containers/${id}`);
  }
}
