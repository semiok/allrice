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
  createLocalPythonArchive,
  readLocalPythonArchive,
} from './local-python-archive.js';
import { localPythonSupervisor } from './local-python-supervisor.js';
import type { LocalPythonTransport } from './local-python-client.js';

const attemptLabel = 'xyz.bplabs.allrice.python.attempt',
  digestLabel = 'xyz.bplabs.allrice.python.payload';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = (p: RuntimeLocalPythonPayload) =>
  createHash('sha256')
    .update(JSON.stringify(RuntimeLocalPythonPayloadSchema.parse(p)))
    .digest('hex');
interface Container {
  Id: string;
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
    await this.api.verifySocket();
    signal.throwIfAborted();
    const info = await this.api.json<{
      OSType: string;
      Architecture: string;
      CgroupVersion: string;
      MemoryLimit: boolean;
      SwapLimit: boolean;
      PidsLimit: boolean;
      CpuCfsQuota: boolean;
      SecurityOptions: string[];
    }>('GET', '/info');
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
    const image = await this.api.json<{
      Id: string;
      Os: string;
      Architecture: string;
    }>('GET', `/images/${release.imageId}/json`);
    if (
      image.Id !== release.imageId ||
      image.Os !== 'linux' ||
      image.Architecture !== release.architecture
    )
      throw new LocalCommandError('TOOLCHAIN_CHANGED');
    if (deep || !this.probed) {
      const attempt = randomUUID();
      const probe = await this.api.json<{ Id: string }>(
        'POST',
        `/containers/create?name=allrice-python-probe-${attempt}`,
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
      );
      let logs = '';
      const abort = () => {
        void this.api
          .json('POST', `/containers/${probe.Id}/kill?signal=KILL`)
          .catch(() => undefined);
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        await this.api.json('POST', `/containers/${probe.Id}/start`);
        if (signal.aborted) {
          await this.api.json(
            'POST',
            `/containers/${probe.Id}/kill?signal=KILL`,
          );
          signal.throwIfAborted();
        }
        await this.api.logs(
          probe.Id,
          (bytes) => {
            logs += bytes.toString('utf8');
            if (Buffer.byteLength(logs) > 32768)
              throw new LocalCommandError('INVALID_PROFILE_PROBE');
          },
          60_000,
        );
        signal.throwIfAborted();
        const state = await this.api.json<Container>(
          'GET',
          `/containers/${probe.Id}/json`,
        );
        if (
          state.Id !== probe.Id ||
          state.Config.Image !== release.imageId ||
          state.Config.Labels[attemptLabel] !== attempt ||
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
        signal.removeEventListener('abort', abort);
        await this.removeProbe(probe.Id, attempt);
      }
      this.probed = true;
    }
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
    });
  }
  private async removeProbe(id: string, attempt: string) {
    const state = await this.api.json<Container>(
      'GET',
      `/containers/${id}/json`,
    );
    if (
      state.Config.Labels[attemptLabel] !== attempt ||
      state.Config.Image !== this.config.release.imageId
    )
      throw new LocalCommandError('CONTAINER_IDENTITY_CHANGED');
    if (state.State.Running)
      await this.api.json('POST', `/containers/${id}/kill?signal=KILL`);
    const stopped = await this.api.json<Container>(
      'GET',
      `/containers/${id}/json`,
    );
    if (stopped.State.Running)
      throw new LocalCommandError('STOP_NOT_CONFIRMED');
    await this.api.json('DELETE', `/containers/${id}`);
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
    try {
      const files = [];
      for (const file of payload.arguments.inputs)
        files.push({
          path: `input/${file.path}`,
          bytes: await transport.download(file, bounded),
          mode: 0o444,
        });
      bounded.throwIfAborted();
      if (!(await maintainLease()))
        throw new LocalCommandError('EXECUTION_REVOKED');
      return files;
    } catch (error) {
      if (bounded.aborted) throw new LocalCommandError('EXECUTION_REVOKED');
      if (error instanceof LocalCommandError) throw error;
      throw new LocalCommandError('INPUT_DOWNLOAD_UNAVAILABLE');
    } finally {
      clearInterval(timer);
    }
  }
  async execute(
    input: RuntimeLocalPythonPayload,
    options: {
      attemptId: string;
      transport: LocalPythonTransport;
      signal?: AbortSignal;
      maintainLease: () => Promise<boolean>;
    },
  ) {
    const payload = RuntimeLocalPythonPayloadSchema.parse(input),
      a = payload.arguments;
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
        AbortSignal.timeout(a.limits.timeoutMs + 35_000),
      ]);
    await this.preflight(signal);
    if (!(await options.maintainLease()))
      throw new LocalCommandError('EXECUTION_REVOKED');
    const files = await this.inputs(
      payload,
      options.transport,
      signal,
      options.maintainLease,
    );
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
        OpenStdin: false,
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
    const timer = setInterval(() => {
      if (checking) return;
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
    const deadlineUnixMs = Date.now() + a.limits.timeoutMs;
    const deadline = setTimeout(() => {
      void stop('timeout').catch(() => undefined);
    }, a.limits.timeoutMs + 22_000);
    try {
      await this.api.putArchive(
        id,
        '/tmp/work',
        createLocalPythonArchive([
          ...files,
          { path: 'main.py', bytes: Buffer.from(a.script), mode: 0o444 },
          {
            path: '.allrice/config.json',
            bytes: Buffer.from(
              JSON.stringify({ arguments: a, deadlineUnixMs }),
            ),
          },
        ]),
        signal,
      );
      if (signal.aborted || !(await options.maintainLease())) {
        await stop('lease_lost');
      } else {
        await this.inspect(options.attemptId, id, payload);
        signal.throwIfAborted();
        startPending = this.api.json('POST', `/containers/${id}/start`);
        await startPending;
        if (signal.aborted) await stop('canceled');
      }
      let state = await this.inspect(options.attemptId, id, payload);
      while (state.State.Running) {
        await delay(100);
        state = await this.inspect(options.attemptId, id, payload);
      }
      if (stopPromise) await stopPromise;
      if (state.State.Status !== 'exited' && state.State.Status !== 'created')
        throw new LocalCommandError('STOP_NOT_CONFIRMED');
      return await this.result(
        payload,
        options.attemptId,
        id,
        options.transport,
        signal,
        reason ?? (state.State.OOMKilled ? 'memory_limit' : null),
      );
    } catch {
      try {
        await stop(reason ?? 'supervisor_failed');
        if (
          reason === 'canceled' ||
          reason === 'lease_lost' ||
          reason === 'timeout'
        )
          return await this.result(
            payload,
            options.attemptId,
            id,
            undefined,
            AbortSignal.timeout(5000),
            reason,
          );
      } catch {
        /* No stop proof: retain the attempt for reconciliation. */
      }
      throw new LocalCommandError('PYTHON_RESULT_UNKNOWN');
    } finally {
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
