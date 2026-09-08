import {
  RuntimeLocalServiceExchangeResponseSchema,
  runtimeContractEqual,
  type RuntimeBridgeDispatch,
} from '@allrice/contracts';
import { bridgeRequest } from './client.js';
import type { BridgeConfig } from './config.js';
import type { BridgeJournal } from './journal.js';
import type { LocalCommandRunner } from './local-command-runner.js';
import { LocalCommandError } from './local-command-inputs.js';
import { LocalServiceRunner } from './local-service-runner.js';

const managers = new WeakMap<BridgeJournal, LocalProcessManager>();
export function localProcessManager(input: ManagerInput) {
  let manager = managers.get(input.journal);
  if (!manager) {
    manager = new LocalProcessManager(input);
    managers.set(input.journal, manager);
  } else manager.update(input);
  return manager;
}
export async function stopLocalProcesses(journal: BridgeJournal) {
  await managers.get(journal)?.close();
}

/** Recovery/terminal delivery only. Ignores all control values and cannot write
 * stdin or resume a service; the server must not renew leases for this request. */
export async function flushLocalServiceEvents(input: {
  journal: BridgeJournal;
  config: BridgeConfig;
  token: string;
  request?: typeof bridgeRequest;
}) {
  const services = input.journal.serviceJournal();
  for (const dispatch of await input.journal.pendingServiceDispatches()) {
    const id = dispatch.snapshot.binding.attempt.operationId;
    for (let batch = 0; batch < 4; batch++) {
      const events = await services.pending(id);
      if (!events.length) break;
      const response = RuntimeLocalServiceExchangeResponseSchema.parse(
        await (input.request ?? bridgeRequest)({
          server: input.config.server,
          path: `/api/v1/bridge/device/operations/${id}/service`,
          method: 'POST',
          token: input.token,
          body: {
            contractVersion: 1,
            attempt: dispatch.snapshot.binding.attempt,
            leaseToken: dispatch.leaseToken,
            events,
            deliveryOnly: true,
          },
          maximumResponseBytes: 100000,
          timeoutMs: 2500,
        }),
      );
      if (
        !runtimeContractEqual(
          response.snapshot.binding,
          dispatch.snapshot.binding,
        ) ||
        response.inputs.length
      )
        throw new LocalCommandError('SERVICE_ACK_MISMATCH');
      await services.acknowledge(id, response.acceptedSequence);
      if (response.acceptedSequence < events.at(-1)!.sequence) break;
    }
  }
}
interface ManagerInput {
  journal: BridgeJournal;
  config: BridgeConfig;
  token: string;
  runner: LocalCommandRunner;
  signal?: AbortSignal;
  request?: typeof bridgeRequest;
}

/** Bounded live Promise ownership; durable journal/PG remain authoritative.
 * Scope is the originating active Run, not an immortal session daemon. */
export class LocalProcessManager {
  private readonly active = new Map<
    string,
    { runId: string; abort: AbortController; done: Promise<void> }
  >();
  constructor(private input: ManagerInput) {}
  update(input: ManagerInput) {
    this.input = input;
  }
  get capacity() {
    return this.active.size < 2;
  }
  get activeCount() {
    return this.active.size;
  }

  async start(dispatch: RuntimeBridgeDispatch, root: string) {
    const { journal, runner } = this.input;
    const payload = dispatch.payload;
    const { operationId, attemptId } = dispatch.snapshot.binding.attempt;
    if (
      payload.capability !== 'local.process.execute' ||
      !payload.arguments.background
    )
      throw Error('SERVICE_REQUIRED');
    if (
      !this.capacity ||
      [...this.active.values()].some(
        (value) => value.runId === dispatch.snapshot.binding.task.runId,
      )
    )
      throw new LocalCommandError('SERVICE_CONCURRENCY_LIMIT');
    const serviceJournal = journal.serviceJournal();
    const abort = new AbortController();
    const signal = this.input.signal
      ? AbortSignal.any([abort.signal, this.input.signal])
      : abort.signal;
    let hardDeadlineAt: string | undefined;
    const exchange = async () => {
      const response = RuntimeLocalServiceExchangeResponseSchema.parse(
        await (this.input.request ?? bridgeRequest)({
          server: this.input.config.server,
          path: `/api/v1/bridge/device/operations/${operationId}/service`,
          method: 'POST',
          token: this.input.token,
          body: {
            contractVersion: 1,
            attempt: dispatch.snapshot.binding.attempt,
            leaseToken: dispatch.leaseToken,
            events: await serviceJournal.pending(operationId),
          },
          maximumResponseBytes: 100000,
          timeoutMs: 2500,
        }),
      );
      if (
        !runtimeContractEqual(
          response.snapshot.binding,
          dispatch.snapshot.binding,
        ) ||
        (hardDeadlineAt !== undefined &&
          response.hardDeadlineAt !== hardDeadlineAt)
      )
        throw new LocalCommandError('SERVICE_AUTHORITY_CHANGED');
      hardDeadlineAt = response.hardDeadlineAt;
      await serviceJournal.acknowledge(operationId, response.acceptedSequence);
      return {
        ...response,
        stopRequested:
          response.stopRequested ||
          response.snapshot.status !== 'running' ||
          response.snapshot.cancelRequestId !== null,
      };
    };
    // Before any Docker side effect, obtain the immutable server-owned deadline.
    const first = await exchange();
    if (first.stopRequested || Date.parse(first.hardDeadlineAt) <= Date.now())
      throw new LocalCommandError('EXECUTION_REVOKED');
    const done = (async () => {
      try {
        const result = await new LocalServiceRunner(runner).execute(
          root,
          payload,
          {
            processId: operationId,
            attemptId,
            hardDeadlineAt: first.hardDeadlineAt,
            signal,
            maintainLease: exchange,
            prepareInput: (input) => serviceJournal.prepare(operationId, input),
            onEvent: async (event) => {
              await serviceJournal.event(operationId, event);
              // Bind durable container identity before Docker start. Later events
              // are batched into the short heartbeat and their ACK is delivery-only.
              if (event.type === 'starting') await exchange();
            },
            onOutput: async (output) => {
              await (this.input.request ?? bridgeRequest)({
                server: this.input.config.server,
                path: `/api/v1/bridge/device/operations/${operationId}/output`,
                method: 'POST',
                token: this.input.token,
                body: {
                  contractVersion: 1,
                  attempt: dispatch.snapshot.binding.attempt,
                  leaseToken: dispatch.leaseToken,
                  sequence: output.sequence,
                  stream: output.stream,
                  content: output.text,
                },
                maximumResponseBytes: 4096,
                timeoutMs: 2500,
              });
            },
          },
        );
        // Preserve exact terminal evidence even if event/HTTP delivery is lost.
        await exchange().catch(() => undefined);
        if (['canceled', 'lease_lost'].includes(result.reason))
          await journal.stopped(
            operationId,
            result,
            `后台服务已停止（${result.reason}）；原工作区未修改`,
          );
        else
          await journal.outcome(operationId, {
            status:
              result.reason === 'exited' && result.exitCode === 0
                ? 'succeeded'
                : 'failed',
            effects: 'none',
            output: result,
            summary: `后台服务退出 ${result.exitCode}（${result.reason}）；原工作区未修改`,
          });
        await runner
          .cleanup(attemptId, result.containerId)
          .catch(() => undefined);
      } catch (error) {
        const noExecution =
          error instanceof LocalCommandError &&
          [
            'SERVICE_CONFIG_INVALID',
            'EXECUTION_REVOKED',
            'TOOLCHAIN_CHANGED',
            'ISOLATION_UNAVAILABLE',
            'INPUT_VERSION_CHANGED',
            'INPUT_PATH_CHANGED',
            'UNSAFE_INPUT_FILE',
            'SENSITIVE_INPUT',
            'INPUT_LIMIT',
          ].includes(error.code);
        if (noExecution)
          await journal.outcome(operationId, {
            status: 'failed',
            effects: 'none',
            errorCode: error.code,
            summary: '后台服务未开始；隔离环境或授权条件不满足',
          });
        else
          await journal.uncertain(operationId, 'receipt_missing', {
            summary: '后台服务结果待核对；不自动重启或重放输入',
          });
      }
    })().finally(() => this.active.delete(operationId));
    // A journal failure is surfaced during polling/close, not an unhandled rejection.
    void done.catch(() => abort.abort());
    this.active.set(operationId, {
      runId: dispatch.snapshot.binding.task.runId,
      abort,
      done,
    });
  }

  async close() {
    const current = [...this.active.values()];
    for (const task of current) task.abort.abort();
    await Promise.allSettled(current.map((task) => task.done));
  }
}
