import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import {
  assertMcpSchemaSubset,
  RuntimeLocalMcpPayloadSchema,
  RuntimeLocalMcpPhaseSchema,
  RuntimeLocalMcpResultSchema,
  type McpDiscoveredTool,
  type RuntimeLocalMcpCredentialReference,
  type RuntimeLocalMcpPayload,
  type RuntimeLocalMcpResult,
} from '@allrice/contracts';
import type { LocalCommandRunner } from './local-command-runner.js';
import { LocalServiceControl } from './local-service-control.js';
import { LocalCommandError } from './local-command-inputs.js';
import { readLocalMcpInputs } from './local-mcp-inputs.js';
import { localMcpSupervisor } from './local-mcp-supervisor.js';
import {
  LocalMcpError,
  localMcpDigest,
  localMcpToolDigest,
  normalizeLocalMcpTools,
  parseLocalMcpResult,
} from './local-mcp-protocol.js';

type Reason = RuntimeLocalMcpResult['reason'];
type Phase = RuntimeLocalMcpResult['phase'];
export interface LocalMcpLease {
  leaseExpiresAt: string;
  stopRequested: boolean;
}
export interface LocalMcpRunnerOptions {
  attemptId: string;
  hardDeadlineAt: string;
  signal?: AbortSignal;
  maintainLease: () => Promise<LocalMcpLease>;
  /** Must commit an immutable local intent before resolving. A prior prepared
   * intent is UNKNOWN, not permission to write a second protocol request. */
  prepareCall: (intent: { requestId: string; digest: string }) => Promise<void>;
  /** Resolve this exact ref against server/device/connection/source binding.
   * Called before start and each renewal; missing/revoked/changed stops work. */
  resolveCredential?: (
    reference: RuntimeLocalMcpCredentialReference,
  ) => Promise<string>;
  validateTools?: (tools: McpDiscoveredTool[]) => void | Promise<void>;
  onLifecycle?: (event: {
    type: 'starting' | 'phase';
    attemptId: string;
    containerId: string;
    phase: Phase;
  }) => Promise<void>;
}
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
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const label = 'xyz.bplabs.allrice.mcp-attempt';
function validateSchema(schema: Record<string, unknown>) {
  assertMcpSchemaSubset(schema);
  return new AjvJsonSchemaValidator().getValidator(schema);
}
export function validateLocalMcpTools(tools: McpDiscoveredTool[]) {
  for (const tool of tools) {
    validateSchema(tool.inputSchema);
    if (tool.outputSchema) validateSchema(tool.outputSchema);
  }
}
async function bounded<T>(task: Promise<T>, milliseconds = 2500): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new LocalMcpError('LOCAL_MCP_REVOKED')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Only talks to the configured local VM's Unix Docker API. Neither the
 * runner nor the MCP transport invokes child_process on the macOS host. */
export class LocalMcpRunner {
  constructor(private readonly runner: LocalCommandRunner) {}

  private async inspect(attemptId: string, id: string) {
    if (!uuid.test(attemptId) || !/^[a-f0-9]{64}$/.test(id))
      throw new LocalMcpError('LOCAL_MCP_UNKNOWN');
    const value = await this.runner.api.json<Container>(
      'GET',
      `/containers/${id}/json`,
    );
    if (
      value.Id !== id ||
      value.Config.Image !== this.runner.config.imageDigest ||
      value.Config.Labels[label] !== attemptId
    )
      throw new LocalMcpError('LOCAL_MCP_UNKNOWN');
    return value;
  }

  async execute(
    root: string,
    value: RuntimeLocalMcpPayload,
    options: LocalMcpRunnerOptions,
  ): Promise<RuntimeLocalMcpResult> {
    const input = RuntimeLocalMcpPayloadSchema.parse(value),
      args = input.arguments;
    const hardDeadlineMs = Date.parse(options.hardDeadlineAt);
    if (
      !uuid.test(options.attemptId) ||
      !Number.isFinite(hardDeadlineMs) ||
      hardDeadlineMs <= Date.now() ||
      hardDeadlineMs > Date.now() + args.limits.timeoutMs + 1000 ||
      args.imageDigest !== this.runner.config.imageDigest
    )
      throw new LocalMcpError('LOCAL_MCP_REVOKED');
    let profile: Awaited<ReturnType<LocalCommandRunner['preflight']>>;
    try {
      profile = await this.runner.preflight();
    } catch {
      throw new LocalMcpError('LOCAL_MCP_UNAVAILABLE');
    }
    const bundle = await readLocalMcpInputs(root, input);
    let credential: string | null = null;
    const currentCredential = async () => {
      if (args.credential === null) return null;
      if (!options.resolveCredential)
        throw new LocalMcpError('LOCAL_MCP_CREDENTIAL_UNAVAILABLE');
      const token = await bounded(options.resolveCredential(args.credential));
      if (!/^[\x21-\x7e]{8,4096}$/.test(token))
        throw new LocalMcpError('LOCAL_MCP_CREDENTIAL_UNAVAILABLE');
      return token;
    };
    const authorize = async () => {
      if (!(await bounded(this.runner.localMcpEnabled())))
        throw new LocalMcpError('LOCAL_MCP_DISABLED');
      const lease = await bounded(options.maintainLease());
      const deadline = Math.min(
        hardDeadlineMs,
        Date.parse(lease.leaseExpiresAt),
        Date.now() + 5000,
      );
      if (
        lease.stopRequested ||
        options.signal?.aborted ||
        !Number.isFinite(deadline) ||
        deadline <= Date.now() ||
        (credential !== null && (await currentCredential()) !== credential)
      )
        throw new LocalMcpError('LOCAL_MCP_REVOKED');
      if (deadline <= Date.now() || options.signal?.aborted)
        throw new LocalMcpError('LOCAL_MCP_REVOKED');
      return deadline;
    };
    await authorize();
    credential = await currentCredential();
    await authorize();
    const encoded = Buffer.from(
      JSON.stringify({
        ...bundle,
        attemptId: options.attemptId,
        hardDeadlineMs,
      }),
    ).toString('base64');
    const parts = encoded.match(/.{1,32768}/g) ?? [];
    if (!parts.length || parts.length > 32)
      throw new LocalMcpError('LOCAL_MCP_LIMIT');
    const api = this.runner.api,
      limits = args.limits;
    // No credentials in Docker create/inspect metadata, argv, labels or logs.
    let created: { Id: string };
    try {
      created = await api.json<{ Id: string }>(
        'POST',
        `/containers/create?name=allrice-mcp-${options.attemptId}&platform=linux%2F${profile.architecture}`,
        {
          Image: args.imageDigest,
          Entrypoint: ['/usr/local/bin/node'],
          Cmd: ['--input-type=module', '--eval', localMcpSupervisor],
          User: '0:0',
          WorkingDir: '/',
          OpenStdin: true,
          StdinOnce: false,
          Tty: false,
          Env: [
            `ALLRICE_INPUT_PARTS=${parts.length}`,
            ...parts.map((part, index) => `ALLRICE_INPUT_${index}=${part}`),
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
    } catch {
      throw new LocalMcpError('LOCAL_MCP_UNKNOWN');
    }
    const id = created.Id;
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new LocalMcpError('LOCAL_MCP_UNKNOWN');
    let phase: Phase = 'starting',
      stoppedFor: Reason | undefined;
    let callAttempted = false,
      stopConfirmed = false,
      resultKnown = false;
    let discovered: McpDiscoveredTool[] | undefined,
      toolResult: RuntimeLocalMcpResult['toolResult'];
    let control: LocalServiceControl | undefined,
      controlSequence = 0,
      done = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined,
      tickTask: Promise<void> | undefined;
    let stopTask: Promise<void> | undefined,
      readyTask: Promise<void> | undefined,
      logs: Promise<void> | undefined;
    let eventQueue = Promise.resolve(),
      queued = 0,
      eventFailed = false;
    let observedExit: { reason: Reason; code: number } | undefined;
    const acknowledgments = new Map<
      number,
      {
        resolve: () => void;
        reject: () => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const stop = (reason: Reason) => {
      stoppedFor ??=
        Date.now() >= hardDeadlineMs &&
        ['lease_lost', 'canceled'].includes(reason)
          ? 'timeout'
          : reason;
      stopTask ??= (async () => {
        const state = await this.inspect(options.attemptId, id);
        if (state.State.Running)
          await api.json('POST', `/containers/${id}/kill?signal=KILL`);
      })();
      return stopTask;
    };
    const send = async (frame: Record<string, unknown>) => {
      if (done || !control) throw new LocalMcpError('LOCAL_MCP_UNKNOWN');
      const sequence = controlSequence++;
      const acknowledged = new Promise<void>((resolve, reject) => {
        const rejectSafe = () => reject(new LocalMcpError('LOCAL_MCP_UNKNOWN'));
        acknowledgments.set(sequence, {
          resolve,
          reject: rejectSafe,
          timer: setTimeout(() => {
            acknowledgments.delete(sequence);
            rejectSafe();
          }, 2500),
        });
      });
      void acknowledged.catch(() => undefined);
      try {
        await control.send({
          ...frame,
          attemptId: options.attemptId,
          sequence,
        });
        await acknowledged;
      } catch {
        const pending = acknowledgments.get(sequence);
        if (pending) {
          clearTimeout(pending.timer);
          acknowledgments.delete(sequence);
          pending.reject();
        }
        throw new LocalMcpError('LOCAL_MCP_UNKNOWN');
      }
    };
    const onReady = async (raw: unknown) => {
      const tools = normalizeLocalMcpTools(raw);
      validateLocalMcpTools(tools);
      await bounded(Promise.resolve(options.validateTools?.(tools)));
      if (input.capability === 'local.mcp.call') {
        const actual = tools.find(
          (tool) => tool.name === input.arguments.tool.name,
        );
        if (
          !actual ||
          localMcpToolDigest(actual) !== input.arguments.tool.digest
        )
          throw new LocalMcpError('LOCAL_MCP_SCHEMA_CHANGED');
        if (
          !validateSchema(actual.inputSchema)(input.arguments.toolArguments)
            .valid
        )
          throw new LocalMcpError('LOCAL_MCP_PROTOCOL');
        const intent = {
          requestId: options.attemptId,
          digest: localMcpDigest({
            tool: actual.name,
            arguments: input.arguments.toolArguments,
          }),
        };
        await bounded(options.prepareCall(intent));
        await authorize();
        if (done || eventFailed) throw new LocalMcpError('LOCAL_MCP_UNKNOWN');
        // Conservative from BEFORE pipe delivery: lost ACK cannot justify retry.
        callAttempted = true;
        await send({ type: 'call', ...intent });
      } else {
        await authorize();
        discovered = tools;
        resultKnown = true;
        await send({ type: 'finish' });
      }
    };
    const onAbort = () => {
      void stop('canceled').catch(() => undefined);
    };
    try {
      await bounded(
        Promise.resolve(
          options.onLifecycle?.({
            type: 'starting',
            attemptId: options.attemptId,
            containerId: id,
            phase,
          }),
        ),
      );
      await authorize();
      await api.json('POST', `/containers/${id}/start`);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      let buffer = Buffer.alloc(0);
      logs = api.logs(
        id,
        (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          let at;
          while ((at = buffer.indexOf(10)) >= 0) {
            const line = buffer.subarray(0, at);
            buffer = buffer.subarray(at + 1);
            if (line.length > 200_000)
              throw new LocalMcpError('LOCAL_MCP_LIMIT');
            const frame = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(line),
            ) as Record<string, unknown>;
            // ACK parsing never queues behind persistence or a pending send().
            if (frame.type === 'control_ack') {
              const pending = acknowledgments.get(Number(frame.sequence));
              if (!pending) throw new LocalMcpError('LOCAL_MCP_PROTOCOL');
              clearTimeout(pending.timer);
              acknowledgments.delete(Number(frame.sequence));
              pending.resolve();
              continue;
            }
            if (
              frame.type !== 'mcp' ||
              frame.attemptId !== options.attemptId ||
              ++queued > 32
            )
              throw new LocalMcpError('LOCAL_MCP_PROTOCOL');
            eventQueue = eventQueue
              .then(async () => {
                if (frame.event === 'phase') {
                  phase = RuntimeLocalMcpPhaseSchema.parse(frame.phase);
                  if (phase === 'calling') callAttempted = true;
                  await bounded(
                    Promise.resolve(
                      options.onLifecycle?.({
                        type: 'phase',
                        attemptId: options.attemptId,
                        containerId: id,
                        phase,
                      }),
                    ),
                  );
                } else if (frame.event === 'ready') {
                  if (readyTask) throw new LocalMcpError('LOCAL_MCP_PROTOCOL');
                  readyTask = onReady(frame.tools).catch(async (error) => {
                    eventFailed = true;
                    await stop(
                      error instanceof LocalMcpError &&
                        error.code === 'LOCAL_MCP_SCHEMA_CHANGED'
                        ? 'schema_changed'
                        : 'unknown',
                    ).catch(() => undefined);
                  });
                } else if (frame.event === 'result') {
                  if (
                    input.capability !== 'local.mcp.call' ||
                    !callAttempted ||
                    resultKnown
                  )
                    throw new LocalMcpError('LOCAL_MCP_PROTOCOL');
                  const result = parseLocalMcpResult(frame.toolResult);
                  const schema = input.arguments.tool.outputSchema;
                  if (
                    schema &&
                    ((!result.structuredContent && !result.isError) ||
                      (result.structuredContent &&
                        !validateSchema(schema)(result.structuredContent)
                          .valid))
                  )
                    throw new LocalMcpError('LOCAL_MCP_PROTOCOL');
                  toolResult = result;
                  resultKnown = true;
                } else if (frame.event === 'exit') {
                  if (observedExit)
                    throw new LocalMcpError('LOCAL_MCP_PROTOCOL');
                  const reason = RuntimeLocalMcpResultSchema.shape.reason.parse(
                    frame.reason,
                  );
                  if (
                    !Number.isInteger(frame.code) ||
                    Number(frame.code) < 0 ||
                    Number(frame.code) > 255
                  )
                    throw new LocalMcpError('LOCAL_MCP_PROTOCOL');
                  if (frame.callAttempted === true) callAttempted = true;
                  observedExit = { reason, code: Number(frame.code) };
                } else throw new LocalMcpError('LOCAL_MCP_PROTOCOL');
              })
              .catch(async () => {
                eventFailed = true;
                await stop('protocol_error').catch(() => undefined);
              })
              .finally(() => {
                queued--;
              });
          }
          if (buffer.length > 200_000)
            throw new LocalMcpError('LOCAL_MCP_LIMIT');
        },
        Math.max(1000, hardDeadlineMs - Date.now()) + 15000,
      );
      void logs.catch(() => undefined);
      control = await LocalServiceControl.connect(api.socketPath, id);
      await send({ type: 'renew', leaseDeadlineMs: await authorize() });
      await send({ type: 'start', credential });
      const tick = async () => {
        try {
          if (Date.now() >= hardDeadlineMs) {
            await stop('timeout');
            return;
          }
          const deadline = await authorize();
          if (!done) await send({ type: 'renew', leaseDeadlineMs: deadline });
        } catch {
          if (!done) await stop('lease_lost').catch(() => undefined);
        }
      };
      heartbeat = setInterval(() => {
        if (!done && !tickTask)
          tickTask = tick().finally(() => {
            tickTask = undefined;
          });
      }, 1000);
      await logs;
      await eventQueue;
      // A terminal PID1 frame may arrive before finish/call control ACK. No
      // ACK retry is needed: immutable result evidence wins over that lost ACK.
      done = true;
      for (const ack of acknowledgments.values()) {
        clearTimeout(ack.timer);
        ack.resolve();
      }
      acknowledgments.clear();
      await readyTask;
      if (stopTask) await stopTask.catch(() => undefined);
      const final = await this.inspect(options.attemptId, id);
      stopConfirmed = !final.State.Running && final.State.Status === 'exited';
      if (!stopConfirmed) throw new LocalMcpError('LOCAL_MCP_UNKNOWN');
      const terminal = observedExit as
        { reason: Reason; code: number } | undefined;
      const reason: Reason = final.State.OOMKilled
        ? 'memory_limit'
        : (stoppedFor ??
          (terminal?.code === final.State.ExitCode
            ? terminal.reason
            : 'unknown'));
      return RuntimeLocalMcpResultSchema.parse({
        backend: 'local-vm-container-v1',
        containerId: id,
        imageDigest: args.imageDigest,
        phase,
        reason,
        stopConfirmed,
        callAttempted,
        resultKnown,
        ...(resultKnown && discovered ? { tools: discovered } : {}),
        ...(resultKnown && toolResult ? { toolResult } : {}),
        stderr: '',
        truncated:
          eventFailed || buffer.length > 0 || reason === 'output_limit',
        workCopy: 'local_isolated_copy',
        sourceDirectoryModified: false,
      });
    } catch {
      done = true;
      await stop('unknown').catch(() => undefined);
      await logs?.catch(() => undefined);
      await eventQueue;
      const state = await this.inspect(options.attemptId, id).catch(() => null);
      stopConfirmed =
        state !== null &&
        !state.State.Running &&
        state.State.Status === 'exited';
      return RuntimeLocalMcpResultSchema.parse({
        backend: 'local-vm-container-v1',
        containerId: id,
        imageDigest: args.imageDigest,
        phase,
        reason: 'unknown',
        stopConfirmed,
        callAttempted,
        resultKnown,
        ...(resultKnown && discovered ? { tools: discovered } : {}),
        ...(resultKnown && toolResult ? { toolResult } : {}),
        stderr: '',
        truncated: true,
        workCopy: 'local_isolated_copy',
        sourceDirectoryModified: false,
      });
    } finally {
      done = true;
      credential = null;
      if (heartbeat) clearInterval(heartbeat);
      control?.close();
      options.signal?.removeEventListener('abort', onAbort);
      for (const ack of acknowledgments.values()) {
        clearTimeout(ack.timer);
        ack.reject();
      }
      acknowledgments.clear();
      await tickTask;
      await readyTask;
    }
  }

  /** Dispose only after the corresponding bounded result/unknown is durable.
   * Container name/label is an ownership identity, never a license to replay. */
  async cleanup(attemptId: string, containerId: string) {
    const state = await this.inspect(attemptId, containerId);
    if (state.State.Running || state.State.Status !== 'exited')
      throw new LocalMcpError('LOCAL_MCP_UNKNOWN');
    await this.runner.api.json('DELETE', `/containers/${containerId}`);
  }

  /** Cold recovery never initializes MCP, reads a credential or calls a tool.
   * Stop only an exact owned orphan. Root preserves journal unknown/result. */
  async stopOrphan(
    attemptId: string,
  ): Promise<{ containerId: string; stopped: boolean } | null> {
    if (!uuid.test(attemptId)) throw new LocalMcpError('LOCAL_MCP_UNKNOWN');
    await this.runner.api.verifySocket();
    let container: Container;
    try {
      container = await this.runner.api.json<Container>(
        'GET',
        `/containers/allrice-mcp-${attemptId}/json`,
      );
    } catch (error) {
      if (
        error instanceof LocalCommandError &&
        error.code === 'DAEMON_HTTP_404'
      )
        return null;
      throw new LocalMcpError('LOCAL_MCP_UNKNOWN');
    }
    const state = await this.inspect(attemptId, container.Id);
    if (state.State.Running)
      await this.runner.api.json(
        'POST',
        `/containers/${container.Id}/kill?signal=KILL`,
      );
    const final = await this.inspect(attemptId, container.Id);
    return {
      containerId: container.Id,
      stopped:
        !final.State.Running &&
        ['created', 'exited'].includes(final.State.Status),
    };
  }
}
