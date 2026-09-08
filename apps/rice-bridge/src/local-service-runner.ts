import {
  RuntimeLocalCommandSchema,
  RuntimeLocalCommandResultSchema,
  RuntimeLocalServiceEventSchema,
  RuntimeLocalServiceInputSchema,
  type RuntimeLocalCommand,
  type RuntimeLocalCommandResult,
  type RuntimeLocalServiceEvent,
  type RuntimeLocalServiceInput,
} from '@allrice/contracts';
import type {
  LocalCommandRunner,
  LocalCommandOutput,
} from './local-command-runner.js';
import {
  LocalCommandError,
  readLocalCommandInputs,
} from './local-command-inputs.js';
import { LocalCommandOutputFilter } from './local-command-output.js';
import { LocalServiceControl } from './local-service-control.js';
import { localServiceSupervisor } from './local-service-supervisor.js';

export interface LocalServiceLease {
  leaseExpiresAt: string;
  stopRequested: boolean;
  inputs: RuntimeLocalServiceInput[];
}
type Reason = RuntimeLocalCommandResult['reason'];
interface Container {
  Id: string;
  Config: { Image: string; Labels: Record<string, string> };
  State: {
    Running: boolean;
    Status: string;
    ExitCode: number;
    OOMKilled: boolean;
  };
}
const attemptLabel = 'xyz.bplabs.allrice.attempt';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** A service has a start/readiness lifecycle but its returned Promise is still
 * the final stopped evidence. LocalProcessManager owns that Promise concurrently. */
export class LocalServiceRunner {
  constructor(private readonly runner: LocalCommandRunner) {}

  async execute(
    root: string,
    input: RuntimeLocalCommand,
    options: {
      processId: string;
      attemptId: string;
      hardDeadlineAt: string;
      signal?: AbortSignal;
      maintainLease: () => Promise<LocalServiceLease>;
      onEvent: (event: RuntimeLocalServiceEvent) => Promise<void>;
      prepareInput: (
        input: RuntimeLocalServiceInput,
      ) => Promise<'new' | 'delivered'>;
      onOutput?: (output: LocalCommandOutput) => Promise<void>;
    },
  ): Promise<RuntimeLocalCommandResult> {
    const command = RuntimeLocalCommandSchema.parse(input);
    if (command.arguments.imageDigest !== this.runner.config.imageDigest)
      throw new LocalCommandError('TOOLCHAIN_CHANGED');
    const config = command.arguments.background;
    const hardDeadlineMs = Date.parse(options.hardDeadlineAt);
    if (
      !config ||
      !uuid.test(options.attemptId) ||
      !uuid.test(options.processId) ||
      !Number.isFinite(hardDeadlineMs) ||
      hardDeadlineMs <= Date.now() ||
      hardDeadlineMs > Date.now() + config.durationMs + 1000
    )
      throw new LocalCommandError('SERVICE_CONFIG_INVALID');
    await this.runner.preflight();
    const bundle = await readLocalCommandInputs(root, command);
    const first = await options.maintainLease();
    if (
      options.signal?.aborted ||
      first.stopRequested ||
      Date.parse(first.leaseExpiresAt) <= Date.now()
    )
      throw new LocalCommandError('EXECUTION_REVOKED');
    const encoded = Buffer.from(
      JSON.stringify({
        ...bundle,
        hardDeadlineMs,
        processId: options.processId,
        attemptId: options.attemptId,
      }),
    ).toString('base64');
    const parts = encoded.match(/.{1,32768}/g) ?? [];
    if (parts.length > 32) throw new LocalCommandError('RUNNER_INPUT_LIMIT');
    const api = this.runner.api,
      limits = command.arguments.limits;
    const container = await api.json<{ Id: string }>(
      'POST',
      `/containers/create?name=allrice-${options.attemptId}`,
      {
        Image: this.runner.config.imageDigest,
        Entrypoint: ['/usr/local/bin/node'],
        Cmd: ['--input-type=module', '--eval', localServiceSupervisor],
        User: '0:0',
        WorkingDir: '/',
        OpenStdin: true,
        StdinOnce: false,
        Tty: false,
        Env: [
          `ALLRICE_INPUT_PARTS=${parts.length}`,
          ...parts.map((part, i) => `ALLRICE_INPUT_${i}=${part}`),
        ],
        Labels: {
          [attemptLabel]: options.attemptId,
          'xyz.bplabs.allrice.backend': 'local-vm-container-v1',
          'xyz.bplabs.allrice.service': options.processId,
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
          CpuPeriod: 100000,
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
    const inspect = async () => {
      const value = await api.json<Container>('GET', `/containers/${id}/json`);
      if (
        value.Id !== id ||
        value.Config.Image !== this.runner.config.imageDigest ||
        value.Config.Labels[attemptLabel] !== options.attemptId ||
        value.Config.Labels['xyz.bplabs.allrice.service'] !== options.processId
      )
        throw new LocalCommandError('SERVICE_IDENTITY_MISMATCH');
      return value;
    };
    // Persist container ownership and the exact hard deadline BEFORE starting.
    try {
      await options.onEvent({
        type: 'starting',
        processId: options.processId,
        attemptId: options.attemptId,
        sequence: 0,
        containerId: id,
        hardDeadlineAt: options.hardDeadlineAt,
      });
      const current = await options.maintainLease();
      if (
        options.signal?.aborted ||
        current.stopRequested ||
        Date.parse(current.leaseExpiresAt) <= Date.now() ||
        hardDeadlineMs <= Date.now()
      )
        throw new LocalCommandError('EXECUTION_REVOKED');
    } catch (error) {
      // Created but never started has no process tree. Removal is not an effect replay.
      await api.json('DELETE', `/containers/${id}`).catch(() => undefined);
      throw error;
    }
    let stoppedFor: Reason | null = null,
      stopPromise: Promise<void> | undefined;
    const stop = (reason: Reason) => {
      stoppedFor ??= reason;
      stopPromise ??= api
        .json('POST', `/containers/${id}/kill?signal=KILL`)
        .then(() => undefined)
        .catch(async () => {
          if ((await inspect()).State.Running)
            throw new LocalCommandError('STOP_NOT_CONFIRMED');
        });
      return stopPromise;
    };
    let control: LocalServiceControl | undefined,
      controlSequence = 0;
    const acks = new Map<
      number,
      {
        resolve: () => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const send = async (frame: Record<string, unknown>) => {
      const sequence = controlSequence++;
      const acknowledged = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          acks.delete(sequence);
          reject(new LocalCommandError('SERVICE_CONTROL_ACK_LOST'));
        }, 2500);
        acks.set(sequence, { resolve, reject, timer });
      });
      // A write timeout is uncertain too; never resend this sequence/input effect.
      try {
        await control!.send({
          ...frame,
          attemptId: options.attemptId,
          sequence,
        });
        await acknowledged;
      } catch (error) {
        const ack = acks.get(sequence);
        if (ack) {
          clearTimeout(ack.timer);
          acks.delete(sequence);
          ack.resolve();
        }
        throw error;
      }
    };
    let stdout = '',
      stderr = '',
      pending = '',
      sequence = 0,
      received = 0,
      published = 0,
      queued = 0;
    const filters = {
      stdout: new LocalCommandOutputFilter(),
      stderr: new LocalCommandOutputFilter(),
    };
    let outputQueue = Promise.resolve(),
      outputDelivery = Promise.resolve(),
      deliveryFailed = false,
      queueFailed = false,
      exit: { reason: Reason; code: number } | null = null;
    const publish = async (stream: 'stdout' | 'stderr', text: string) => {
      if (!text) return;
      published += Buffer.byteLength(text);
      if (published > limits.outputBytes || sequence >= 256)
        throw new LocalCommandError('SUPERVISOR_OUTPUT_LIMIT');
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      const chunk = { sequence: sequence++, stream, text };
      // Bounded stdout persistence/HTTP must never block control ACK parsing.
      // The total queued content is bounded by the same operation output budget.
      outputDelivery = outputDelivery
        .then(async () => {
          if (!deliveryFailed) await options.onOutput?.(chunk);
        })
        .catch(() => {
          deliveryFailed = true;
          void stop('lease_lost').catch(() => undefined);
        });
    };
    const handleEvent = async (event: Record<string, unknown>) => {
      if (event.type === 'service') {
        const e = RuntimeLocalServiceEventSchema.parse(event.event);
        if (
          e.processId !== options.processId ||
          e.attemptId !== options.attemptId ||
          e.type === 'starting'
        )
          throw new LocalCommandError('INVALID_SUPERVISOR_OUTPUT');
        if (e.type === 'input_request') {
          const filter = new LocalCommandOutputFilter();
          e.request.prompt =
            filter.push(Buffer.from(e.request.prompt), true).slice(0, 500) ||
            '进程请求输入';
        }
        await options.onEvent(e);
      } else if (event.type === 'control_ack') {
        const ack = acks.get(Number(event.sequence));
        if (!ack) throw new LocalCommandError('INVALID_CONTROL_ACK');
        clearTimeout(ack.timer);
        acks.delete(Number(event.sequence));
        ack.resolve();
      } else if (
        (event.type === 'stdout' || event.type === 'stderr') &&
        typeof event.data === 'string'
      ) {
        const bytes = Buffer.from(event.data, 'base64');
        received += bytes.length;
        if (received > limits.outputBytes)
          throw new LocalCommandError('SUPERVISOR_OUTPUT_LIMIT');
        await publish(event.type, filters[event.type].push(bytes));
      } else if (event.type === 'exit') {
        const reason = RuntimeLocalCommandResultSchema.shape.reason.parse(
          event.reason,
        );
        if (
          !Number.isInteger(event.code) ||
          Number(event.code) < 0 ||
          Number(event.code) > 255
        )
          throw new LocalCommandError('INVALID_SUPERVISOR_EXIT');
        exit = { reason, code: Number(event.code) };
      } else throw new LocalCommandError('INVALID_SUPERVISOR_OUTPUT');
    };
    let heartbeat: ReturnType<typeof setInterval> | undefined,
      heartbeatTask: Promise<void> | undefined,
      serviceEnded = false,
      busy = false;
    const onAbort = () => {
      void stop('canceled').catch(() => undefined);
    };
    let logs: Promise<void> | undefined;
    try {
      await api.json('POST', `/containers/${id}/start`);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      logs = api.logs(
        id,
        (chunk) => {
          pending += chunk.toString('utf8');
          if (pending.length > 250000)
            throw new LocalCommandError('INVALID_SUPERVISOR_OUTPUT');
          let newline;
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (++queued > 32)
              throw new LocalCommandError('SERVICE_EVENT_BACKPRESSURE');
            outputQueue = outputQueue
              .then(() =>
                handleEvent(JSON.parse(line) as Record<string, unknown>),
              )
              .catch(() => {
                queueFailed = true;
                void stop('supervisor_failed').catch(() => undefined);
              })
              .finally(() => {
                queued--;
              });
          }
        },
        Math.max(1000, hardDeadlineMs - Date.now()) + 15000,
      );
      // Observe immediately; the awaited path below still retains the failure.
      void logs.catch(() => undefined);
      control = await LocalServiceControl.connect(api.socketPath, id);
      const tick = async () => {
        if (busy) return;
        busy = true;
        try {
          const lease = await options.maintainLease();
          if (serviceEnded) return;
          if (lease.stopRequested || options.signal?.aborted) {
            await stop('canceled');
            return;
          }
          const deadline = Math.min(
            hardDeadlineMs,
            Date.parse(lease.leaseExpiresAt),
            Date.now() + 5000,
          );
          if (
            !Number.isFinite(deadline) ||
            deadline <= Date.now() ||
            queueFailed
          ) {
            await stop('lease_lost');
            return;
          }
          await send({ type: 'renew', leaseDeadlineMs: deadline });
          for (const value of lease.inputs) {
            const input = RuntimeLocalServiceInputSchema.parse(value);
            if ((await options.prepareInput(input)) === 'new')
              await send({ type: 'input', input });
          }
        } catch {
          if (!serviceEnded) await stop('lease_lost').catch(() => undefined);
        } finally {
          busy = false;
        }
      };
      await tick();
      heartbeat = setInterval(() => {
        if (!serviceEnded && !heartbeatTask)
          heartbeatTask = tick().finally(() => {
            heartbeatTask = undefined;
          });
      }, 1000);
      await logs;
      serviceEnded = true;
      await outputQueue;
      if (stopPromise) await stopPromise;
      for (const stream of ['stdout', 'stderr'] as const)
        await publish(stream, filters[stream].push(Buffer.alloc(0), true));
      await outputDelivery;
      const final = await inspect();
      if (final.State.Running || final.State.Status !== 'exited')
        throw new LocalCommandError('STOP_NOT_CONFIRMED');
      const observed = exit as { reason: Reason; code: number } | null;
      return RuntimeLocalCommandResultSchema.parse({
        backend: 'local-vm-container-v1',
        containerId: id,
        imageDigest: this.runner.config.imageDigest,
        stopped: true,
        exitCode: final.State.ExitCode,
        reason: final.State.OOMKilled
          ? 'memory_limit'
          : (stoppedFor ??
            (observed?.code === final.State.ExitCode
              ? observed.reason
              : 'supervisor_failed')),
        stdout,
        stderr,
        truncated:
          queueFailed ||
          pending.length > 0 ||
          filters.stdout.truncated ||
          filters.stderr.truncated ||
          observed?.reason === 'output_limit',
        workCopy: 'local_isolated_copy',
        sourceDirectoryModified: false,
      });
    } catch {
      serviceEnded = true;
      await stop('supervisor_failed').catch(() => undefined);
      if (logs) await logs.catch(() => undefined);
      await outputQueue;
      throw new LocalCommandError('RUNNER_RESULT_UNKNOWN');
    } finally {
      serviceEnded = true;
      if (heartbeat) clearInterval(heartbeat);
      control?.close();
      options.signal?.removeEventListener('abort', onAbort);
      for (const ack of acks.values()) {
        clearTimeout(ack.timer);
        ack.reject(new LocalCommandError('SERVICE_ENDED'));
      }
      acks.clear();
      await heartbeatTask;
      await outputDelivery;
    }
  }
}
