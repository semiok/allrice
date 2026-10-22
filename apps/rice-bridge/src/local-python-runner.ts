import {
  LocalSandboxNetwork,
  requireLocalSandboxNetwork,
} from './local-sandbox-network.js';
import type { SandboxNetworkLease } from '@allrice/contracts';
import type { SandboxExecutionBudgetController } from '@allrice/project-runtime';
import {
  LocalExecutionControl,
  requireLocalExecutionBudget,
} from './local-execution-control.js';
import { BridgeControlError, firstControlFailure } from './control-request.js';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createInputArchive, bufferedInput } from '@allrice/project-runtime';
import type { RuntimeInputSource } from '@allrice/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  RuntimeLocalPythonPayloadSchema,
  RuntimeLocalPythonResultSchema,
  RuntimeLocalPythonProfileSchema,
  RuntimeLocalPythonCheckpointSchema,
  runtimeContractEqual,
  type RuntimeLocalPythonCheckpoint,
  type RuntimeLocalPythonPayload,
  type RuntimeLocalPythonResult,
  type ManagedPythonPayloadRelease,
} from '@allrice/contracts';
import { LocalDockerApi } from './local-docker-api.js';
import { LocalCommandError } from './local-command-inputs.js';
import {
  inputDownloadAbortReason,
  LocalPythonInputDownloadError,
} from './local-python-download-error.js';
import { readLocalPythonArchive } from './local-python-archive.js';
import { localPythonSupervisor } from './local-python-supervisor.js';
import type { LocalPythonTransport } from './local-python-client.js';
import {
  withPreparationStep,
  type PreparationObserver,
  type PreparationStep,
} from './preparation-progress.js';

const attemptLabel = 'xyz.bplabs.allrice.python.attempt',
  digestLabel = 'xyz.bplabs.allrice.python.payload';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = (p: RuntimeLocalPythonPayload) =>
  createHash('sha256')
    .update(JSON.stringify(RuntimeLocalPythonPayloadSchema.parse(p)))
    .digest('hex');
interface Container {
  Id: string;
  Name?: string;
  Config: { Image: string; Labels: Record<string, string> };
  Mounts: { Type: string; Name: string; Destination: string }[];
  State: {
    Running: boolean;
    Status: string;
    ExitCode: number;
    OOMKilled: boolean;
  };
}

/** One private Engine, pinned image and existing operation attempt. No host mounts. */
export class LocalPythonRunner {
  readonly api: LocalDockerApi;
  onPreparationStep?: PreparationObserver;
  private probed = false;
  constructor(
    readonly config: {
      socketPath: string;
      release: ManagedPythonPayloadRelease;
    },
  ) {
    if (!config.release.nativeSupported)
      throw new LocalCommandError('UNSUPPORTED_NATIVE_PLATFORM');
    this.api = new LocalDockerApi(config.socketPath);
  }
  async preflight(signal: AbortSignal, deep = !this.probed) {
    const release = this.config.release;
    const step = <T>(name: PreparationStep, operation: () => Promise<T>) =>
      withPreparationStep(this.onPreparationStep, 'python', name, async () => {
        signal.throwIfAborted();
        const value = await operation();
        signal.throwIfAborted();
        return value;
      });
    await step('engine_socket', () => this.api.verifySocket());
    const info = await step('engine_info', () =>
      this.api.json<{
        OSType: string;
        Architecture: string;
        CgroupVersion: string;
        MemoryLimit: boolean;
        SwapLimit: boolean;
        PidsLimit: boolean;
        CpuCfsQuota: boolean;
        SecurityOptions: string[];
      }>('GET', '/info', undefined, 15_000, signal),
    );
    if (
      info.OSType !== 'linux' ||
      !(
        release.architecture === 'amd64'
          ? ['x86_64', 'amd64']
          : ['aarch64', 'arm64']
      ).includes(info.Architecture) ||
      info.CgroupVersion !== '2' ||
      !info.MemoryLimit ||
      !info.SwapLimit ||
      !info.PidsLimit ||
      !info.CpuCfsQuota ||
      !info.SecurityOptions.some((s) => s.startsWith('name=seccomp'))
    )
      throw new LocalCommandError('ISOLATION_UNAVAILABLE');
    const image = await step('image_check', () =>
      this.api.json<{
        Id: string;
        Os: string;
        Architecture: string;
      }>('GET', `/images/${release.imageId}/json`, undefined, 15_000, signal),
    );
    if (
      image.Id !== release.imageId ||
      image.Os !== 'linux' ||
      image.Architecture !== release.architecture
    )
      throw new LocalCommandError('TOOLCHAIN_CHANGED');
    if (deep || !this.probed) {
      const attempt = randomUUID();
      const name = `allrice-python-probe-${attempt}`;
      let probeId: string | undefined;
      let createRequested = false;
      try {
        const probe = await step('probe_create', () => {
          createRequested = true;
          return this.api.json<{ Id: string }>(
            'POST',
            `/containers/create?name=${name}`,
            {
              Image: release.imageId,
              Entrypoint: ['/opt/python/bin/python'],
              Cmd: ['-I', '/opt/allrice/probe.py', 'probe'],
              User: '65532:65532',
              Env: ['MPLBACKEND=Agg', 'LANG=C.UTF-8'],
              Labels: {
                [attemptLabel]: attempt,
                'xyz.bplabs.allrice.python.probe': '1',
              },
              HostConfig: this.hostConfig(512, 1000, 64),
            },
            15_000,
            signal,
          );
        });
        if (!/^[a-f0-9]{64}$/.test(probe.Id))
          throw new LocalCommandError('INVALID_DAEMON_RESPONSE');
        const created = await step('probe_inspect', () =>
          this.api.json<Container>(
            'GET',
            `/containers/${probe.Id}/json`,
            undefined,
            15_000,
            signal,
          ),
        );
        this.assertProbeIdentity(created, name, attempt, probe.Id);
        probeId = probe.Id;
        await step('probe_start', () =>
          this.api.json(
            'POST',
            `/containers/${probe.Id}/start`,
            undefined,
            15_000,
            signal,
          ),
        );
        let logs = '';
        await step('probe_logs', () =>
          this.api.logs(
            probe.Id,
            (bytes) => {
              logs += bytes.toString('utf8');
              if (Buffer.byteLength(logs) > 32768)
                throw new LocalCommandError('INVALID_PROFILE_PROBE');
            },
            60_000,
            signal,
          ),
        );
        const state = await step('probe_inspect', () =>
          this.api.json<Container>(
            'GET',
            `/containers/${probe.Id}/json`,
            undefined,
            15_000,
            signal,
          ),
        );
        this.assertProbeIdentity(state, name, attempt, probe.Id);
        if (
          state.State.Running ||
          state.State.Status !== 'exited' ||
          state.State.ExitCode !== 0
        )
          throw new LocalCommandError('PROFILE_PROBE_FAILED');
        const proof = JSON.parse(logs.trim()) as Record<string, unknown>;
        const office = proof.officeChecker as
            Record<string, unknown> | undefined,
          png = proof.pngChecker as Record<string, unknown> | undefined,
          font = proof.font as Record<string, unknown> | undefined,
          checks = proof.checks as Record<string, unknown> | undefined;
        if (
          proof.architecture !== release.architecture ||
          proof.pythonVersion !== release.pythonVersion ||
          proof.packagesChecksum !== release.packagesChecksum ||
          office?.sha256 !== release.officeChecker.sha256 ||
          office?.upstream !== release.officeChecker.upstream ||
          png?.sha256 !== release.pngChecker.sha256 ||
          font?.sha256 !== release.font.sha256 ||
          font?.fileName !== release.font.fileName ||
          checks?.cjkAggPng !== true ||
          checks?.corruptPngRejected !== true
        )
          throw new LocalCommandError('PROFILE_PROBE_FAILED');
      } finally {
        // The canceled preparation signal must not abandon an owned side effect.
        if (createRequested)
          await withPreparationStep(
            this.onPreparationStep,
            'python',
            'probe_cleanup',
            () => this.removeProbe(name, attempt, probeId),
          );
      }
      signal.throwIfAborted();
      this.probed = true;
    }
    signal.throwIfAborted();
    return RuntimeLocalPythonProfileSchema.parse({
      contractVersion: 1,
      profileVersion: 1,
      backend: 'local-vm-container-v1',
      imageId: release.imageId,
      architecture: release.architecture,
      pythonVersion: release.pythonVersion,
      packagesChecksum: release.packagesChecksum,
      officeCheckerChecksum: release.officeChecker.sha256,
      pngCheckerChecksum: release.pngChecker.sha256,
      fontChecksum: release.font.sha256,
      available: true,
      purposes: ['office', 'python_charts'],
      officeGeneration: true,
      officeFormulaCalculation: false,
      officePreview: false,
      stopConfirmed: true,
      pythonChartsContractVersion: 1,
      ...(process.env.ALLRICE_BRIDGE_SANDBOX_EXECUTION_V1_ENABLED !== '0' &&
      process.env.ALLRICE_BRIDGE_SANDBOX_NETWORK_V1_ENABLED !== '0'
        ? { sandboxNetworkVersion: 1 }
        : {}),
      ...(process.env.ALLRICE_BRIDGE_SANDBOX_EXECUTION_V1_ENABLED !== '0'
        ? { sandboxExecutionVersion: 1 }
        : {}),
      inputStreamingVersion: 1,
    });
  }
  private assertProbeIdentity(
    state: Container,
    name: string,
    attempt: string,
    id?: string,
  ) {
    if (
      !/^[a-f0-9]{64}$/.test(state?.Id) ||
      (id !== undefined && state.Id !== id) ||
      ![name, `/${name}`].includes(state.Name ?? '') ||
      state.Config?.Labels?.[attemptLabel] !== attempt ||
      state.Config?.Labels?.['xyz.bplabs.allrice.python.probe'] !== '1' ||
      state.Config?.Image !== this.config.release.imageId ||
      typeof state.State?.Running !== 'boolean'
    )
      throw new LocalCommandError('CONTAINER_IDENTITY_CHANGED');
  }
  private async removeProbe(name: string, attempt: string, knownId?: string) {
    const cleanup = new AbortController();
    const timer = setTimeout(() => cleanup.abort(), 10_000);
    const inspect = async (reference: string) => {
      const state = await this.api
        .json<Container>(
          'GET',
          `/containers/${reference}/json`,
          undefined,
          10_000,
          cleanup.signal,
        )
        .catch((error: unknown) => {
          if (
            error instanceof LocalCommandError &&
            error.code === 'DAEMON_HTTP_404'
          )
            return null;
          throw error;
        });
      if (state) this.assertProbeIdentity(state, name, attempt, knownId);
      return state;
    };
    try {
      let state = await inspect(knownId ?? name);
      // A lost create response is not evidence that create did not commit.
      // Wait for this unique name, without ever retrying the create request.
      while (!state && knownId === undefined) {
        await delay(50, undefined, { signal: cleanup.signal });
        state = await inspect(name);
      }
      if (state) {
        const id = state.Id;
        knownId = id;
        if (state.State.Running) {
          // Even a lost kill response is reconciled by inspection, not a retry.
          await this.api
            .json(
              'POST',
              `/containers/${id}/kill?signal=KILL`,
              undefined,
              10_000,
              cleanup.signal,
            )
            .catch(() => undefined);
        }
        const stopped = await inspect(id);
        if (stopped?.State.Running)
          throw new LocalCommandError('STOP_NOT_CONFIRMED');
        if (stopped) {
          await this.api
            .json(
              'DELETE',
              `/containers/${id}`,
              undefined,
              10_000,
              cleanup.signal,
            )
            .catch(() => undefined);
          if (await inspect(id))
            throw new LocalCommandError('STOP_NOT_CONFIRMED');
        }
      }
      if (await inspect(name))
        throw new LocalCommandError('STOP_NOT_CONFIRMED');
      cleanup.signal.throwIfAborted();
    } catch {
      throw new LocalCommandError('STOP_NOT_CONFIRMED');
    } finally {
      clearTimeout(timer);
    }
  }
  private hostConfig(memory: number, cpu: number, pids: number) {
    return {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      CapAdd: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE', 'SETUID', 'SETGID', 'KILL'],
      SecurityOpt: ['no-new-privileges'],
      PidsLimit: pids,
      Memory: memory * 1024 * 1024,
      MemorySwap: memory * 1024 * 1024,
      CpuPeriod: 100_000,
      CpuQuota: cpu * 100,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=32m,mode=1777' },
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
    };
  }
  private async inspect(
    attempt: string,
    id: string,
    payload: RuntimeLocalPythonPayload,
  ) {
    if (!uuid.test(attempt) || !/^[a-f0-9]{64}$/.test(id))
      throw new LocalCommandError('INVALID_ATTEMPT');
    const c = await this.api.json<Container>('GET', `/containers/${id}/json`);
    if (
      c.Id !== id ||
      c.Config.Image !== this.config.release.imageId ||
      c.Config.Labels[attemptLabel] !== attempt ||
      c.Config.Labels[digestLabel] !== digest(payload) ||
      !c.Mounts.some(
        (m) =>
          m.Type === 'volume' &&
          m.Name === `allrice-python-${attempt}` &&
          m.Destination === '/tmp/work',
      ) ||
      c.Mounts.some((m) => m.Type === 'bind')
    )
      throw new LocalCommandError('CONTAINER_IDENTITY_CHANGED');
    return c;
  }
  private async inputs(
    payload: RuntimeLocalPythonPayload,
    transport: LocalPythonTransport,
    signal: AbortSignal,
    maintainLease: () => Promise<boolean>,
  ) {
    const revoked = new AbortController(),
      bounded = AbortSignal.any([signal, revoked.signal]);
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void maintainLease()
        .then((alive) => {
          if (!alive) revoked.abort();
        })
        .catch(() => revoked.abort())
        .finally(() => {
          checking = false;
        });
    }, 500);
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'allrice-python-input-'));
      const files: RuntimeInputSource[] = [];
      for (const [index, file] of payload.arguments.inputs.entries()) {
        const path = join(directory, String(index));
        const handle = await open(path, 'wx', 0o600);
        let received = 0;
        const hash = createHash('sha256');
        const write = async (chunk: Uint8Array) => {
          bounded.throwIfAborted();
          received += chunk.length;
          if (received > file.sizeBytes)
            throw new LocalCommandError('INPUT_VERSION_CHANGED');
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await handle
              .write(chunk, offset, chunk.length - offset)
              .catch((error) => {
                if (error.code === 'ENOSPC' || error.code === 'EDQUOT')
                  throw new LocalCommandError('INPUT_STORAGE_FULL');
                throw error;
              });
            if (!bytesWritten)
              throw new LocalCommandError('INPUT_DOWNLOAD_UNAVAILABLE');
            offset += bytesWritten;
          }
        };
        try {
          const legacy = await transport.download(file, bounded, write);
          if (legacy.length) await write(legacy);
          if (
            received !== file.sizeBytes ||
            `sha256:${hash.digest('hex')}` !== file.checksum
          )
            throw new LocalCommandError('INPUT_VERSION_CHANGED');
        } finally {
          await handle.close();
        }
        files.push({
          path: `input/${file.path}`,
          sizeBytes: file.sizeBytes,
          checksum: file.checksum,
          async open(signal) {
            signal.throwIfAborted();
            return Readable.toWeb(createReadStream(path, { signal }), {
              strategy: {
                highWaterMark: 65536,
                size: (chunk) => chunk.byteLength,
              },
            }) as ReadableStream<Uint8Array>;
          },
        });
      }
      bounded.throwIfAborted();
      if (!(await maintainLease()))
        throw new LocalCommandError('EXECUTION_REVOKED');
      return {
        files,
        cleanup: () => rm(directory!, { recursive: true, force: true }),
      };
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true });
      if (bounded.aborted) {
        if (error instanceof LocalPythonInputDownloadError)
          throw new LocalPythonInputDownloadError('EXECUTION_REVOKED', {
            ...error.diagnostic,
            reason: inputDownloadAbortReason(bounded.reason),
          });
        throw new LocalCommandError('EXECUTION_REVOKED');
      }
      if (error instanceof LocalCommandError) throw error;
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        ['ENOSPC', 'EDQUOT'].includes(String(error.code))
      )
        throw new LocalCommandError('INPUT_STORAGE_FULL');
      throw new LocalCommandError('INPUT_DOWNLOAD_UNAVAILABLE');
    } finally {
      clearInterval(timer);
    }
  }
  async execute(
    input: RuntimeLocalPythonPayload,
    options: {
      attemptId: string;
      executionBudget?: SandboxExecutionBudgetController;
      networkLease?: SandboxNetworkLease;
      transport: LocalPythonTransport;
      signal?: AbortSignal;
      maintainLease: () => Promise<boolean>;
    },
  ) {
    const payload = RuntimeLocalPythonPayloadSchema.parse(input),
      a = payload.arguments;
    const budget = options.executionBudget;
    requireLocalExecutionBudget(payload, budget, options.maintainLease);
    requireLocalSandboxNetwork(
      payload,
      options.networkLease,
      options.attemptId,
    );
    if (!uuid.test(options.attemptId))
      throw new LocalCommandError('INVALID_ATTEMPT');
    if (
      a.imageId !== this.config.release.imageId ||
      a.architecture !== this.config.release.architecture
    )
      throw new LocalCommandError('TOOLCHAIN_CHANGED');
    const aborted = new AbortController(),
      signal = AbortSignal.any([
        aborted.signal,
        ...(options.signal ? [options.signal] : []),
        AbortSignal.timeout(
          budget
            ? Math.max(1, budget.state.hardDeadlineAt - Date.now()) + 35000
            : a.limits.timeoutMs + 35_000,
        ),
      ]);
    const preparationSignal = budget
      ? AbortSignal.any([
          signal,
          AbortSignal.timeout(
            Math.max(1, budget.state.deadlineAt - Date.now()),
          ),
        ])
      : signal;
    await this.preflight(preparationSignal);
    if (!(await options.maintainLease()))
      throw new LocalCommandError('EXECUTION_REVOKED');
    const files = await this.inputs(
      payload,
      options.transport,
      preparationSignal,
      options.maintainLease,
    );
    try {
      return await this.executeStaged(
        payload,
        options,
        aborted,
        signal,
        files.files,
      );
    } finally {
      await files.cleanup();
    }
  }
  private async executeStaged(
    payload: RuntimeLocalPythonPayload,
    options: Parameters<LocalPythonRunner['execute']>[1],
    aborted: AbortController,
    signal: AbortSignal,
    files: RuntimeInputSource[],
  ) {
    const a = payload.arguments;
    const budget = options.executionBudget;
    const volumeName = `allrice-python-${options.attemptId}`;
    const labels = {
      [attemptLabel]: options.attemptId,
      [digestLabel]: digest(payload),
    };
    const volume = await this.api.json<{
      Name: string;
      Labels: Record<string, string>;
    }>('POST', '/volumes/create', {
      Name: volumeName,
      Driver: 'local',
      Labels: labels,
    });
    if (
      volume.Name !== volumeName ||
      volume.Labels[attemptLabel] !== options.attemptId ||
      volume.Labels[digestLabel] !== digest(payload)
    )
      throw new LocalCommandError('CONTAINER_IDENTITY_CHANGED');
    const container = await this.api.json<{ Id: string }>(
      'POST',
      `/containers/create?name=${volumeName}`,
      {
        Image: a.imageId,
        Entrypoint: ['/opt/python/bin/python'],
        Cmd: ['-I', '-c', localPythonSupervisor],
        User: '0:0',
        WorkingDir: '/tmp/work',
        OpenStdin: !!budget,
        StdinOnce: false,
        Tty: false,
        Labels: labels,
        HostConfig: {
          ...this.hostConfig(
            a.limits.memoryMiB,
            a.limits.cpuMillis,
            a.limits.pids,
          ),
          Mounts: [
            {
              Type: 'volume',
              Source: volumeName,
              Target: '/tmp/work',
              ReadOnly: false,
            },
          ],
        },
      },
    );
    const id = container.Id;
    let reason: RuntimeLocalPythonResult['reason'] | null = null,
      checking = false;
    let stopPromise: Promise<void> | undefined,
      startPending: Promise<unknown> | undefined;
    const stop = (why: RuntimeLocalPythonResult['reason']) => {
      reason ??= why;
      aborted.abort();
      return (stopPromise ??= (async () => {
        await startPending?.catch(() => undefined);
        const c = await this.inspect(options.attemptId, id, payload);
        if (c.State.Running)
          await this.api.json('POST', `/containers/${id}/kill?signal=KILL`);
        const current = await this.inspect(options.attemptId, id, payload);
        if (current.State.Running)
          throw new LocalCommandError('STOP_NOT_CONFIRMED');
      })());
    };
    const onAbort = () => {
      void stop('canceled').catch(() => undefined);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    let executionControl: LocalExecutionControl | undefined;
    let network: LocalSandboxNetwork | undefined;
    const timer = setInterval(() => {
      if (checking || executionControl) return;
      checking = true;
      void options
        .maintainLease()
        .then((alive) => {
          if (!alive) return stop('lease_lost');
        })
        .catch(() => stop('lease_lost'))
        .finally(() => {
          checking = false;
        });
    }, 1000);
    const deadlineUnixMs =
      budget?.state.deadlineAt ?? Date.now() + a.limits.timeoutMs;
    const deadline = setTimeout(
      () => {
        void stop('timeout').catch(() => undefined);
      },
      budget
        ? Math.max(1, budget.state.hardDeadlineAt - Date.now())
        : a.limits.timeoutMs + 22_000,
    );
    try {
      await this.api.putInputArchive(
        id,
        createInputArchive(
          [
            ...files,
            bufferedInput('main.py', Buffer.from(a.script)),
            bufferedInput(
              '.allrice/config.json',
              Buffer.from(
                JSON.stringify({
                  arguments: a,
                  ...(options.networkLease ? { runtimeNetwork: true } : {}),
                  deadlineUnixMs,
                  ...(budget
                    ? {
                        executionControl: {
                          version: 1,
                          attemptId: options.attemptId,
                          hardDeadlineAt: budget.state.hardDeadlineAt,
                        },
                      }
                    : {}),
                }),
              ),
            ),
          ],
          signal,
        ),
        signal,
      );
      if (
        signal.aborted ||
        (budget && Date.now() >= budget.state.deadlineAt) ||
        !(await options.maintainLease())
      ) {
        await stop('lease_lost');
      } else {
        await this.inspect(options.attemptId, id, payload);
        signal.throwIfAborted();
        startPending = this.api.json('POST', `/containers/${id}/start`);
        await startPending;
        if (signal.aborted) await stop('canceled');
        if (budget) {
          executionControl = new LocalExecutionControl({
            api: this.api,
            containerId: id,
            attemptId: options.attemptId,
            attemptLabel,
            budget,
            maintainLease: options.maintainLease,
            stop,
          });
          await executionControl.start();
        }
        if (options.networkLease) {
          network = new LocalSandboxNetwork({
            api: this.api,
            containerId: id,
            attemptId: options.attemptId,
            attemptLabel,
            lease: options.networkLease,
            allowExecution: () => executionControl!.allowNetwork(),
            signal,
            maintainLease: options.maintainLease,
            stop,
            relayRuntime: 'python',
          });
          await network.start();
        }
      }
      let state = await this.inspect(options.attemptId, id, payload);
      while (state.State.Running) {
        await delay(100);
        state = await this.inspect(options.attemptId, id, payload);
      }
      await network?.finish();
      await executionControl?.finish();
      if (
        budget &&
        state.State.ExitCode === 124 &&
        Date.now() >= budget.state.deadlineAt
      )
        await stop('timeout');
      if (stopPromise) await stopPromise;
      if (state.State.Status !== 'exited' && state.State.Status !== 'created')
        throw new LocalCommandError('STOP_NOT_CONFIRMED');
      const result = await this.result(
        payload,
        options.attemptId,
        id,
        options.transport,
        signal,
        reason ?? (state.State.OOMKilled ? 'memory_limit' : null),
      );
      return RuntimeLocalPythonResultSchema.parse({
        ...result,
        ...(budget ? { execution: budget.observation } : {}),
        ...(network?.evidence ?? {}),
        ...(firstControlFailure(executionControl?.failure, network?.failure)
          ? {
              controlFailure: firstControlFailure(
                executionControl?.failure,
                network?.failure,
              ),
            }
          : {}),
      });
    } catch (cause) {
      try {
        await stop(reason ?? 'supervisor_failed');
        if (
          reason === 'canceled' ||
          reason === 'lease_lost' ||
          reason === 'timeout'
        )
          return RuntimeLocalPythonResultSchema.parse({
            ...(await this.result(
              payload,
              options.attemptId,
              id,
              undefined,
              AbortSignal.timeout(5000),
              reason,
            )),
            ...(budget ? { execution: budget.observation } : {}),
            ...(network?.evidence ?? {}),
            ...(firstControlFailure(executionControl?.failure, network?.failure)
              ? {
                  controlFailure: firstControlFailure(
                    executionControl?.failure,
                    network?.failure,
                  ),
                }
              : {}),
          });
      } catch {
        /* No stop proof: retain the attempt for reconciliation. */
      }
      const error = new LocalCommandError('PYTHON_RESULT_UNKNOWN');
      const failure = firstControlFailure(
        executionControl?.failure,
        network?.failure,
      );
      error.cause = failure ? new BridgeControlError(failure) : cause;
      throw error;
    } finally {
      await network?.finish();
      await executionControl?.finish();
      clearInterval(timer);
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
  private async result(
    payload: RuntimeLocalPythonPayload,
    attempt: string,
    id: string,
    transport: LocalPythonTransport | undefined,
    signal: AbortSignal,
    forced: RuntimeLocalPythonResult['reason'] | null,
  ) {
    const state = await this.inspect(attempt, id, payload);
    if (state.State.Running) throw new LocalCommandError('STOP_NOT_CONFIRMED');
    let checkpoint: RuntimeLocalPythonCheckpoint | null = null;
    // JSON may escape each captured control byte to six characters. Account
    // for the combined 64 KiB output budget plus all declared metadata.
    try {
      const tar = await this.api.getArchive(
        id,
        '/tmp/work/.allrice/result.json',
        510_000,
        AbortSignal.timeout(5000),
      );
      checkpoint = RuntimeLocalPythonCheckpointSchema.parse(
        JSON.parse(
          readLocalPythonArchive(tar, 'result.json', 500_000).toString('utf8'),
        ),
      );
    } catch {
      if (!forced) throw new LocalCommandError('PYTHON_RESULT_UNKNOWN');
    }
    const reason = forced ?? checkpoint!.reason,
      artifacts: RuntimeLocalPythonResult['artifacts'] = [];
    if (reason === 'exited' && state.State.ExitCode === 0) {
      if (
        !checkpoint ||
        checkpoint.exitCode !== 0 ||
        checkpoint.artifacts.length !== payload.arguments.outputs.length ||
        new Set(checkpoint.artifacts.map((file) => file.objectId)).size !==
          checkpoint.artifacts.length ||
        !transport
      )
        throw new LocalCommandError('PYTHON_RESULT_UNKNOWN');
      let total = 0;
      for (const file of checkpoint.artifacts) {
        const output = payload.arguments.outputs.find((o) =>
          Object.entries(o).every(
            ([k, v]) => file[k as keyof typeof file] === v,
          ),
        );
        if (
          !output ||
          file.validation !==
            (payload.arguments.purpose === 'office'
              ? 'dsh_office'
              : file.format === 'png'
                ? 'trusted_png'
                : 'utf8') ||
          (file.format === 'png'
            ? !file.png || file.png.checksum !== file.checksum
            : file.png !== undefined)
        )
          throw new LocalCommandError('ARTIFACT_PATH_CHANGED');
        const tar = await this.api.getArchive(
            id,
            `/tmp/work/output/${output.path}`,
            payload.arguments.limits.artifactBytes + 10000,
            signal,
          ),
          bytes = readLocalPythonArchive(
            tar,
            basename(output.path),
            payload.arguments.limits.artifactBytes,
          );
        total += bytes.length;
        if (
          total > payload.arguments.limits.artifactBytes ||
          bytes.length !== file.sizeBytes ||
          `sha256:${createHash('sha256').update(bytes).digest('hex')}` !==
            file.checksum
        )
          throw new LocalCommandError('ARTIFACT_VERSION_CHANGED');
        const metadata = {
          checksum: file.checksum,
          sizeBytes: file.sizeBytes,
          mediaType: file.mediaType,
          validation: file.validation,
          ...(file.png ? { png: file.png } : {}),
        };
        const uploaded = await transport.upload(
          output,
          metadata,
          bytes,
          signal,
        );
        if (
          !runtimeContractEqual(uploaded, {
            ...output,
            ...metadata,
            collected: true,
          })
        )
          throw new LocalCommandError('ARTIFACT_VERSION_CHANGED');
        artifacts.push(uploaded);
      }
    }
    return RuntimeLocalPythonResultSchema.parse({
      backend: 'local-vm-container-v1',
      profileVersion: 1,
      purpose: payload.arguments.purpose,
      containerId: id,
      imageId: payload.arguments.imageId,
      architecture: payload.arguments.architecture,
      stopped: true,
      exitCode:
        reason === 'exited'
          ? state.State.ExitCode
          : Math.max(1, state.State.ExitCode),
      reason,
      stdout: checkpoint?.stdout ?? '',
      stderr: checkpoint?.stderr ?? '',
      truncated: checkpoint?.truncated ?? false,
      artifacts,
      workCopy: 'local_isolated_copy',
      sourceDirectoryModified: false,
    });
  }
  /** An unknown attempt never starts, and cannot invent successful collection. */
  async recover(attempt: string, payload: RuntimeLocalPythonPayload) {
    const c = await this.api
      .json<Container>('GET', `/containers/allrice-python-${attempt}/json`)
      .catch((error) => {
        if (
          error instanceof LocalCommandError &&
          error.code === 'DAEMON_HTTP_404'
        )
          return null;
        throw error;
      });
    if (!c) return null;
    await this.inspect(attempt, c.Id, payload);
    if (c.State.Running)
      await this.api.json('POST', `/containers/${c.Id}/kill?signal=KILL`);
    // A stopped successful checkpoint may have uploaded artifacts without a
    // terminal journal receipt. Preserve unknown for object/receipt reconciliation.
    return this.result(
      payload,
      attempt,
      c.Id,
      undefined,
      AbortSignal.timeout(5000),
      c.State.Status === 'created' || c.State.Running ? 'lease_lost' : null,
    );
  }
  async cleanup(
    attempt: string,
    id: string,
    payload: RuntimeLocalPythonPayload,
  ) {
    const c = await this.inspect(attempt, id, payload);
    if (c.State.Running) throw new LocalCommandError('STOP_NOT_CONFIRMED');
    await this.api.json('DELETE', `/containers/${id}`);
    const volume = await this.api.json<{ Labels: Record<string, string> }>(
      'GET',
      `/volumes/allrice-python-${attempt}`,
    );
    if (
      volume.Labels[attemptLabel] !== attempt ||
      volume.Labels[digestLabel] !== digest(payload)
    )
      throw new LocalCommandError('CONTAINER_IDENTITY_CHANGED');
    await this.api.json('DELETE', `/volumes/allrice-python-${attempt}`);
  }
}
