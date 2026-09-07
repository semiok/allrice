import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';

import {
  RuntimeBridgeDispatchSchema,
  RuntimeBridgeReceiptAckSchema,
  RuntimeBridgeStartResponseSchema,
  RuntimeOperationSnapshotSchema,
  runtimeContractEqual,
  type RuntimeBridgeDispatch,
} from '@allrice/contracts';

import { bridgeRequest } from './client.js';
import type { BridgeConfig } from './config.js';
import { executeLocalCommand } from './executor.js';
import { executeChangeset } from './changeset-executor.js';
import { BridgeJournalError, type BridgeJournal } from './journal.js';
import { LocalCommandError } from './local-command-inputs.js';
import type { LocalCommandRunner } from './local-command-runner.js';

export const runtimeBridgeOperationPath = '/api/v1/bridge/device/operations';

/** All retries in this adapter deliver evidence; they never repeat execution. */
export class RuntimeBridgeOperationClient {
  constructor(
    private readonly input: {
      config: BridgeConfig;
      token: string;
      journal: BridgeJournal;
      runner?: LocalCommandRunner;
      signal?: AbortSignal;
      // Test seams retain the real filesystem journal and HTTP adapter.
      execute?: typeof executeLocalCommand;
    },
  ) {
    input.journal.assertIdentity(input.config.server, input.config.deviceId);
  }

  async flush() {
    for (const receipt of await this.input.journal.pending()) {
      const ack = RuntimeBridgeReceiptAckSchema.parse(
        await bridgeRequest({
          server: this.input.config.server,
          path: `${runtimeBridgeOperationPath}/${receipt.attempt.operationId}/receipts`,
          method: 'POST',
          token: this.input.token,
          body: receipt,
          maximumResponseBytes: 32_768,
        }),
      );
      if (ack.receiptId !== receipt.receiptId)
        throw new BridgeJournalError('JOURNAL_ACK_MISMATCH');
      await this.input.journal.acknowledge(receipt.receiptId);
    }
    return (await this.input.journal.pending(1)).length === 0;
  }

  async pollOnce() {
    if (this.input.runner)
      for (const dispatch of await this.input.journal.unknownLocalCommands()) {
        if (dispatch.payload.capability !== 'local.process.execute') continue;
        const { operationId, attemptId } = dispatch.snapshot.binding.attempt;
        try {
          const result = await this.input.runner.recover(
            attemptId,
            dispatch.payload,
          );
          if (result) {
            await this.input.journal.reconcileLocalCommand(operationId, result);
            await this.input.runner
              .cleanup(attemptId, result.containerId)
              .catch(() => undefined);
          }
        } catch {
          /* Keep unknown and its immutable evidence; never guess or replay. */
        }
      }
    // A failed/full outbox prevents acquiring more work, providing backpressure.
    if (!(await this.flush())) return false;
    const response = await bridgeRequest<{ dispatch: unknown }>({
      server: this.input.config.server,
      path: `${runtimeBridgeOperationPath}/next`,
      method: 'POST',
      token: this.input.token,
      body: {
        supportsChangeset: true,
        ...(this.input.runner ? { supportsLocalCommand: true } : {}),
      },
      maximumResponseBytes: 750_000,
    });
    if (response.dispatch === null) return false;
    await this.handle(RuntimeBridgeDispatchSchema.parse(response.dispatch));
    await this.flush();
    return true;
  }

  async handle(dispatch: RuntimeBridgeDispatch) {
    const { journal, config, token } = this.input;
    const operationId = dispatch.snapshot.binding.attempt.operationId;
    if ((await journal.receive(dispatch)) === 'duplicate') return;
    const grant = config.grants.find(
      (item) => item.id === dispatch.snapshot.binding.execution.grantId,
    );
    const root = grant
      ? await realpath(grant.rootPath).catch(() => null)
      : null;
    if (
      !grant ||
      !root ||
      grant.rootFingerprint !== dispatch.grantRootFingerprint ||
      createHash('sha256').update(root).digest('hex') !==
        dispatch.grantRootFingerprint
    ) {
      await journal.outcome(operationId, {
        status: 'failed',
        effects: 'none',
        summary: 'Local folder grant does not match this dispatch',
        errorCode: 'GRANT_MISMATCH',
      });
      return;
    }
    try {
      journal.assertWorkspace(root);
    } catch {
      await journal.outcome(operationId, {
        status: 'failed',
        effects: 'none',
        summary:
          'Choose a project folder that does not contain the Bridge journal',
        errorCode: 'WORKSPACE_CONTAINS_JOURNAL',
      });
      return;
    }
    if (Date.parse(dispatch.leaseExpiresAt) <= Date.now()) {
      await journal.uncertain(operationId, 'lease_lost');
      return;
    }
    if (
      dispatch.payload.capability === 'local.process.execute' &&
      !this.input.runner
    ) {
      await journal.outcome(operationId, {
        status: 'failed',
        effects: 'none',
        summary: '本机未配置经验证的隔离执行环境',
        errorCode: 'LOCAL_RUNNER_UNAVAILABLE',
      });
      return;
    }
    const start = await journal.begin(operationId);
    try {
      const permission = RuntimeBridgeStartResponseSchema.parse(
        await bridgeRequest({
          server: config.server,
          path: `${runtimeBridgeOperationPath}/${operationId}/start`,
          method: 'POST',
          token,
          body: {
            contractVersion: 1,
            receiptId: start.receiptId,
            attempt: dispatch.snapshot.binding.attempt,
            leaseToken: dispatch.leaseToken,
          },
          maximumResponseBytes: 200_000,
        }),
      );
      if (
        !permission.mayExecute ||
        permission.snapshot.status !== 'running' ||
        permission.snapshot.cancelRequestId !== null ||
        !runtimeContractEqual(
          permission.snapshot.binding,
          dispatch.snapshot.binding,
        ) ||
        Date.parse(dispatch.leaseExpiresAt) <= Date.now()
      ) {
        await journal.uncertain(operationId, 'lease_lost');
        return;
      }
    } catch {
      // A start response can be lost AFTER the server recorded started. There
      // is no safe reason to repeat start or execute after this ambiguity.
      await journal.uncertain(operationId, 'connection_lost');
      return;
    }
    if (dispatch.payload.capability === 'local.process.execute') {
      await this.executeProcess(dispatch, root);
      return;
    }
    if (dispatch.payload.capability === 'local.fs.changeset') {
      const result = await executeChangeset(root, dispatch.payload, {
        checkpoint: (index, file) =>
          journal.changesetCheckpoint(operationId, index, file),
        authorize: async () => {
          if (this.input.signal?.aborted) return false;
          try {
            const current = await bridgeRequest<{
              snapshot: unknown;
              leaseExpiresAt: string;
            }>({
              server: config.server,
              path: `${runtimeBridgeOperationPath}/${operationId}/heartbeat`,
              method: 'POST',
              token,
              body: {
                contractVersion: 1,
                attempt: dispatch.snapshot.binding.attempt,
                leaseToken: dispatch.leaseToken,
              },
              timeoutMs: 2500,
              maximumResponseBytes: 200_000,
            });
            const snapshot = RuntimeOperationSnapshotSchema.parse(
              current.snapshot,
            );
            return (
              !this.input.signal?.aborted &&
              snapshot.status === 'running' &&
              snapshot.cancelRequestId === null &&
              runtimeContractEqual(
                snapshot.binding,
                dispatch.snapshot.binding,
              ) &&
              Date.parse(current.leaseExpiresAt) > Date.now()
            );
          } catch {
            return false;
          }
        },
      });
      const applied = result.files.filter((f) => f.status === 'applied').length;
      if (result.files.some((f) => f.status === 'unknown'))
        await journal.uncertain(operationId, 'receipt_missing', {
          summary: '部分文件写入结果待核实，不自动重做',
          output: result,
        });
      else if (!applied && result.files.some((f) => f.status === 'canceled'))
        await journal.stopped(
          operationId,
          result,
          '执行授权失效，尚未写入任何文件',
        );
      else
        await journal.outcome(operationId, {
          status:
            applied === result.files.length
              ? 'succeeded'
              : applied
                ? 'partial'
                : 'failed',
          effects:
            applied === result.files.length
              ? 'applied'
              : applied
                ? 'partial'
                : 'none',
          summary: `已确认处理 ${applied}/${result.files.length} 个文件；详见逐文件记录`,
          output: result,
        });
      return;
    }
    let result: Awaited<ReturnType<typeof executeLocalCommand>>;
    try {
      result = await (this.input.execute ?? executeLocalCommand)(
        root,
        dispatch.payload,
      );
    } catch {
      // Existing write helpers can throw after a rename/mkdir. They cannot
      // prove that no effect occurred, so do not fabricate a failed/none result.
      await journal.uncertain(operationId, 'receipt_missing');
      return;
    }
    try {
      await journal.outcome(operationId, {
        status: 'succeeded',
        effects: ['local.fs.write', 'local.fs.mkdir'].includes(
          dispatch.payload.capability,
        )
          ? 'applied'
          : 'none',
        output: result.output,
        summary: result.summary,
      });
    } catch (error) {
      // Oversized output is omitted rather than turning a completed write into
      // failed. Durable evidence still reports the actual known effect.
      if (
        !(error instanceof BridgeJournalError) ||
        error.code !== 'JOURNAL_RESULT_TOO_LARGE'
      )
        throw error;
      await journal.outcome(operationId, {
        status: 'succeeded',
        effects: ['local.fs.write', 'local.fs.mkdir'].includes(
          dispatch.payload.capability,
        )
          ? 'applied'
          : 'none',
        summary:
          'Operation completed; output exceeded the journal limit and was omitted',
        output: { truncated: true, reason: 'output_limit' },
      });
    }
  }

  private async executeProcess(dispatch: RuntimeBridgeDispatch, root: string) {
    if (
      dispatch.payload.capability !== 'local.process.execute' ||
      !this.input.runner
    )
      throw new Error('LOCAL_RUNNER_UNAVAILABLE');
    const { runner, journal, config, token } = this.input;
    const { operationId, attemptId } = dispatch.snapshot.binding.attempt;
    const body = {
      contractVersion: 1,
      attempt: dispatch.snapshot.binding.attempt,
      leaseToken: dispatch.leaseToken,
    };
    let outputQueue = Promise.resolve(),
      outputFailed = false;
    try {
      const result = await runner.execute(root, dispatch.payload, {
        attemptId,
        signal: this.input.signal,
        leaseExpiresAt: dispatch.leaseExpiresAt,
        maintainLease: async () => {
          if (outputFailed || this.input.signal?.aborted) return false;
          try {
            const current = await bridgeRequest<{
              snapshot: unknown;
              leaseExpiresAt: string;
            }>({
              server: config.server,
              path: `${runtimeBridgeOperationPath}/${operationId}/heartbeat`,
              method: 'POST',
              token,
              body,
              maximumResponseBytes: 200_000,
              timeoutMs: 2500,
            });
            const snapshot = RuntimeOperationSnapshotSchema.parse(
              current.snapshot,
            );
            return (
              snapshot.status === 'running' &&
              snapshot.cancelRequestId === null &&
              runtimeContractEqual(
                snapshot.binding,
                dispatch.snapshot.binding,
              ) &&
              Date.parse(current.leaseExpiresAt) > Date.now()
            );
          } catch {
            return false;
          }
        },
        onOutput: (chunk) => {
          outputQueue = outputQueue
            .then(async () => {
              if (outputFailed) return;
              await bridgeRequest({
                server: config.server,
                path: `${runtimeBridgeOperationPath}/${operationId}/output`,
                method: 'POST',
                token,
                body: {
                  ...body,
                  sequence: chunk.sequence,
                  stream: chunk.stream,
                  content: chunk.text,
                },
                maximumResponseBytes: 4096,
                timeoutMs: 2500,
              });
            })
            .catch(() => {
              outputFailed = true;
            });
        },
      });
      // A dropped streaming chunk does not erase the complete bounded local result.
      // Evidence is committed before disposal; ACK retries can never rerun a command.
      if (['canceled', 'lease_lost'].includes(result.reason)) {
        await journal.stopped(
          operationId,
          result,
          `本地命令已停止（${result.reason}），原工作区未修改`,
        );
      } else {
        await journal.outcome(operationId, {
          status:
            result.reason === 'exited' && result.exitCode === 0
              ? 'succeeded'
              : 'failed',
          effects: 'none',
          output: result,
          summary: `本地隔离命令退出 ${result.exitCode}（${result.reason}），原工作区未修改`,
        });
      }
      await runner
        .cleanup(attemptId, result.containerId)
        .catch(() => undefined);
      await outputQueue;
    } catch (error) {
      // Before creating a container these failures prove no execution. Other
      // daemon/transport failures may be after start and must remain unknown.
      const noExecution =
        error instanceof LocalCommandError &&
        [
          'TOOLCHAIN_CHANGED',
          'ISOLATION_UNAVAILABLE',
          'UNSAFE_DAEMON_SOCKET',
          'INPUT_VERSION_CHANGED',
          'INPUT_PATH_CHANGED',
          'UNSAFE_INPUT_FILE',
          'SENSITIVE_INPUT',
          'INPUT_LIMIT',
          'EXECUTION_REVOKED',
        ].includes(error.code);
      if (noExecution)
        await journal.outcome(operationId, {
          status: 'failed',
          effects: 'none',
          summary: '本地执行前检查未通过，命令未运行',
          errorCode: error.code,
        });
      else await journal.uncertain(operationId, 'receipt_missing');
    }
  }
}
