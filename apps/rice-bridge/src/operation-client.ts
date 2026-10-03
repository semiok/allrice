import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';

import {
  RuntimeBridgeDispatchSchema,
  RuntimeBridgeReceiptAckSchema,
  RuntimeBridgeOutputAckSchema,
  RuntimeBridgeStartResponseSchema,
  RuntimeOperationSnapshotSchema,
  runtimeContractEqual,
  dependencyPreparationErrorLabels,
  localPdfPreExecutionDenialCodes,
  type RuntimeBridgeDispatch,
} from '@allrice/contracts';

import { bridgeRequest } from './client.js';
import type { BridgeConfig } from './config.js';
import { executeLocalCommand } from './executor.js';
import { fileGuardianReady } from './file-guardian-resources.js';
import { FileGuardianError } from './file-guardian.js';
import { executeLocalFile, LocalFileError } from './local-files.js';
import {
  localFileHttpTransport,
  isLocalFilePayload,
  flushLocalFileCommands,
} from './local-file-client.js';
import { executeChangeset } from './changeset-executor.js';
import {
  BridgeJournalError,
  bridgeDigest,
  type BridgeJournal,
} from './journal.js';
import { LocalCommandError } from './local-command-inputs.js';
import type { LocalCommandRunner } from './local-command-runner.js';
import type { LocalPythonRunner } from './local-python-runner.js';
import { localPythonHttpTransport } from './local-python-client.js';
import type { LocalPdfRunner } from './local-pdf-runner.js';
import { localPdfHttpTransport } from './local-pdf-client.js';
import { LocalMcpRunner, validateLocalMcpTools } from './local-mcp-runner.js';
import { readLocalMcpCredential } from './local-mcp-credentials.js';
import {
  localProcessManager,
  flushLocalServiceEvents,
} from './local-process-manager.js';

export const runtimeBridgeOperationPath = '/api/v1/bridge/device/operations';

/** All retries in this adapter deliver evidence; they never repeat execution. */
export class RuntimeBridgeOperationClient {
  constructor(
    private readonly input: {
      config: BridgeConfig;
      token: string;
      journal: BridgeJournal;
      runner?: LocalCommandRunner;
      pythonRunner?: LocalPythonRunner;
      pdfRunner?: LocalPdfRunner;
      signal?: AbortSignal;
      // Test seams retain the real filesystem journal and HTTP adapter.
      execute?: typeof executeLocalCommand;
      request?: typeof bridgeRequest;
      onActivity?: (active: boolean) => void;
      acquiring?: () => boolean;
      chooseFile?: (
        root: string,
        signal?: AbortSignal,
      ) => Promise<string | null>;
    },
  ) {
    input.journal.assertIdentity(input.config.server, input.config.deviceId);
  }

  private request: typeof bridgeRequest = (input) =>
    (this.input.request ?? bridgeRequest)(input);

  private async deliverOutput(
    chunk: Awaited<ReturnType<BridgeJournal['recordOutput']>>,
  ) {
    const ack = RuntimeBridgeOutputAckSchema.parse(
      await this.request({
        server: this.input.config.server,
        path: `${runtimeBridgeOperationPath}/${chunk.attempt.operationId}/output`,
        method: 'POST',
        token: this.input.token,
        body: chunk,
        maximumResponseBytes: 4096,
        timeoutMs: 2500,
      }),
    );
    if (
      ack.operationId !== chunk.attempt.operationId ||
      ack.sequence !== chunk.sequence ||
      ack.digest !== bridgeDigest(chunk)
    )
      throw new BridgeJournalError('JOURNAL_OUTPUT_ACK_MISMATCH');
    await this.input.journal.acknowledgeOutput(
      chunk.attempt.operationId,
      chunk.sequence,
    );
  }

  async flush() {
    await flushLocalFileCommands({
      ...this.input,
      server: this.input.config.server,
    });
    await flushLocalServiceEvents(this.input);
    for (const chunk of await this.input.journal.pendingOutput()) {
      await this.deliverOutput(chunk);
    }
    // Preserve per-attempt output order before terminal receipts. Bounded batches
    // provide backpressure rather than loading the complete journal into memory.
    if ((await this.input.journal.pendingOutput(1)).length) return false;
    for (const receipt of await this.input.journal.pendingForDelivery()) {
      const ack = RuntimeBridgeReceiptAckSchema.parse(
        await this.request({
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
      if (
        this.input.pdfRunner &&
        ['operation.outcome', 'operation.stopped'].includes(receipt.signal.type)
      )
        await this.input.pdfRunner
          .acknowledge(receipt.attempt.attemptId)
          .catch(() => undefined);
    }
    return (await this.input.journal.pending(1)).length === 0;
  }

  async pollOnce() {
    if (this.input.signal?.aborted) return false;
    if (this.input.pdfRunner)
      for (const dispatch of await this.input.journal.unknownLocalPdfOperations()) {
        if (dispatch.payload.capability !== 'local.pdf.read') continue;
        try {
          const result = await this.input.pdfRunner.recover(
            dispatch.snapshot.binding.attempt.attemptId,
            dispatch.payload,
          );
          if (result && result.process.reason !== 'process_unknown')
            await this.input.journal.reconcileLocalPdf(
              dispatch.snapshot.binding.attempt.operationId,
              result,
            );
        } catch {
          /* Immutable unknown evidence stays; never parse again. */
        }
      }
    if (this.input.pythonRunner)
      for (const dispatch of await this.input.journal.unknownLocalPythonOperations()) {
        if (dispatch.payload.capability !== 'local.python.execute') continue;
        const { operationId, attemptId } = dispatch.snapshot.binding.attempt;
        try {
          const result = await this.input.pythonRunner.recover(
            attemptId,
            dispatch.payload,
          );
          if (result) {
            await this.input.journal.reconcileLocalPython(operationId, result);
            await this.input.pythonRunner
              .cleanup(attemptId, result.containerId, dispatch.payload)
              .catch(() => undefined);
          }
        } catch {
          /* Retain immutable unknown evidence; no script or upload replay. */
        }
      }
    if (this.input.runner) {
      const mcpRunner = new LocalMcpRunner(this.input.runner);
      for (const dispatch of await this.input.journal.unknownLocalMcpOperations()) {
        // Reconcile only process ownership/termination. An interrupted MCP
        // call remains unknown; do not reconnect or execute it again.
        await mcpRunner
          .stopOrphan(dispatch.snapshot.binding.attempt.attemptId)
          .catch(() => undefined);
      }
    }
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
    if (this.input.signal?.aborted) return false;
    if (this.input.acquiring?.() === false) return false;
    const response = await this.request<{ dispatch: unknown }>({
      server: this.input.config.server,
      path: `${runtimeBridgeOperationPath}/next`,
      method: 'POST',
      token: this.input.token,
      body: {
        supportsClaimRecovery: true,
        supportsChangeset: true,
        supportsBinaryFiles: true,
        ...(fileGuardianReady()
          ? { supportsFileSurvey: true, supportsFileOrganization: true }
          : {}),
        ...(this.input.pythonRunner ? { supportsManagedPython: true } : {}),
        ...(this.input.pdfRunner ? { supportsPdfRead: true } : {}),
        ...(this.input.runner
          ? {
              supportsLocalCommand: true,
              supportsLocalMcp: await this.input.runner.localMcpEnabled(),
              supportsProjectDiagnostics: true,
              supportsNpmDependencies: true,
              supportsChangesetCandidate: true,
              supportsBackgroundServices:
                process.env.ALLRICE_LOCAL_SERVICE_ENABLED !== '0' &&
                localProcessManager({
                  ...this.input,
                  runner: this.input.runner,
                }).capacity,
            }
          : {}),
      },
      maximumResponseBytes: 750_000,
    });
    if (response.dispatch === null) return false;
    this.input.onActivity?.(true);
    try {
      await this.handle(RuntimeBridgeDispatchSchema.parse(response.dispatch));
    } finally {
      this.input.onActivity?.(false);
    }
    await this.flush();
    return true;
  }

  async handle(dispatch: RuntimeBridgeDispatch) {
    const { journal, config, token } = this.input;
    const operationId = dispatch.snapshot.binding.attempt.operationId;
    if ((await journal.receive(dispatch)) === 'duplicate') return;
    if (this.input.signal?.aborted) {
      if (dispatch.payload.capability === 'local.pdf.read') {
        await journal.outcome(operationId, {
          status: 'failed',
          effects: 'none',
          summary: 'Bridge 已停止领取，PDF 解析进程未启动',
          output: { errorCode: 'PDF_EXECUTION_REVOKED' },
          errorCode: 'PDF_EXECUTION_REVOKED',
        });
        return;
      }
      await journal.stopped(
        operationId,
        { reason: 'bridge_paused' },
        'Bridge 已停止领取；此操作未执行',
      );
      return;
    }
    const python = dispatch.payload.capability === 'local.python.execute';
    const pdf = dispatch.payload.capability === 'local.pdf.read';
    const grant = config.grants.find(
      (item) => item.id === dispatch.snapshot.binding.execution.grantId,
    );
    const root = grant
      ? await realpath(grant.rootPath).catch(() => null)
      : null;
    if (
      !python &&
      !pdf &&
      (!grant ||
        !root ||
        grant.rootFingerprint !== dispatch.grantRootFingerprint ||
        createHash('sha256').update(root).digest('hex') !==
          dispatch.grantRootFingerprint)
    ) {
      await journal.outcome(operationId, {
        status: 'failed',
        effects: 'none',
        summary: 'Local folder grant does not match this dispatch',
        errorCode: 'GRANT_MISMATCH',
      });
      return;
    }
    if (
      python &&
      (!this.input.pythonRunner ||
        dispatch.grantRootFingerprint !==
          createHash('sha256')
            .update(`allrice-managed-python-v1:${config.deviceId}`)
            .digest('hex'))
    ) {
      await journal.outcome(operationId, {
        status: 'failed',
        effects: 'none',
        summary: '固定私有运行环境授权与本机不匹配',
        errorCode: 'MANAGED_RUNTIME_GRANT_MISMATCH',
      });
      return;
    }
    if (
      pdf &&
      (!this.input.pdfRunner ||
        dispatch.grantRootFingerprint !==
          createHash('sha256')
            .update(`allrice-readonly-pdf-v1:${config.deviceId}`)
            .digest('hex'))
    ) {
      await journal.outcome(operationId, {
        status: 'failed',
        effects: 'none',
        summary: '本地固定只读 PDF 授权与本机不匹配，未执行',
        errorCode: 'PDF_EXECUTION_REVOKED',
        output: { errorCode: 'PDF_EXECUTION_REVOKED' },
      });
      return;
    }
    try {
      if (!python && !pdf) journal.assertWorkspace(root!);
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
      [
        'local.process.execute',
        'local.mcp.discover',
        'local.mcp.call',
      ].includes(dispatch.payload.capability) &&
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
        await this.request({
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
    if (this.input.signal?.aborted) {
      if (dispatch.payload.capability === 'local.pdf.read') {
        await journal.outcome(operationId, {
          status: 'failed',
          effects: 'none',
          summary: 'Bridge 已停止，PDF 解析进程未启动',
          output: { errorCode: 'PDF_EXECUTION_REVOKED' },
          errorCode: 'PDF_EXECUTION_REVOKED',
        });
        return;
      }
      await journal.stopped(
        operationId,
        { reason: 'bridge_paused' },
        'Bridge 已停止；此操作未执行',
      );
      return;
    }
    if (dispatch.payload.capability === 'local.python.execute') {
      await this.executePython(dispatch);
      return;
    }
    if (dispatch.payload.capability === 'local.pdf.read') {
      await this.executePdf(dispatch);
      return;
    }
    if (isLocalFilePayload(dispatch.payload)) {
      const channel = localFileHttpTransport({
        server: config.server,
        token,
        kind: 'operation',
        id: operationId,
        leaseToken: dispatch.leaseToken,
        signal: this.input.signal,
      });
      let applied = false;
      try {
        const output = await executeLocalFile(root!, dispatch.payload, {
          ...channel,
          signal: this.input.signal,
          chooseFile: this.input.chooseFile,
        });
        applied = ['saved', 'uploaded', 'opened', 'revealed'].includes(
          output.status,
        );
        await journal.outcome(operationId, {
          status: 'succeeded',
          effects: ['saved', 'uploaded', 'opened', 'revealed'].includes(
            output.status,
          )
            ? 'applied'
            : 'none',
          output,
          summary:
            output.status === 'saved'
              ? '已按原始字节保存到电脑'
              : output.status === 'uploaded'
                ? '已上传选定版本原始字节，可作为现有附件读取'
                : '本地文件版本/系统动作已核验',
        });
      } catch (error) {
        if (applied || (error instanceof LocalFileError && error.unknown))
          await journal.uncertain(operationId, 'receipt_missing', {
            summary: '文件操作结果待对账，不自动重做',
          });
        else if (
          error instanceof LocalFileError &&
          error.code === 'FILE_CANCELED'
        )
          await journal.stopped(
            operationId,
            { reason: error.code },
            '文件操作取消，尚未提交文件',
          );
        else
          await journal.outcome(operationId, {
            status: 'failed',
            effects: 'none',
            summary: '文件操作未完成，请重新选择当前版本或检查目录权限',
            errorCode:
              error instanceof LocalFileError
                ? error.code
                : 'LOCAL_FILE_FAILED',
          });
      }
      return;
    }
    if (dispatch.payload.capability === 'local.process.execute') {
      if (dispatch.payload.arguments.background) {
        if (
          process.env.ALLRICE_LOCAL_SERVICE_ENABLED === '0' ||
          !this.input.runner
        ) {
          await journal.outcome(operationId, {
            status: 'failed',
            effects: 'none',
            summary: '本机未启用后台服务',
            errorCode: 'SERVICE_DISABLED',
          });
          return;
        }
        try {
          await localProcessManager({
            ...this.input,
            runner: this.input.runner,
          }).start(dispatch, root!);
        } catch {
          await journal.outcome(operationId, {
            status: 'failed',
            effects: 'none',
            summary: '后台服务未启动；授权或并发条件不满足',
            errorCode: 'SERVICE_START_REJECTED',
          });
        }
        return;
      }
      await this.executeProcess(dispatch, root!);
      return;
    }
    if (
      dispatch.payload.capability === 'local.mcp.discover' ||
      dispatch.payload.capability === 'local.mcp.call'
    ) {
      await this.executeMcp(dispatch, root!);
      return;
    }
    if (dispatch.payload.capability === 'local.fs.changeset') {
      const result = await executeChangeset(root!, dispatch.payload, {
        signal: this.input.signal,
        checkpoint: (index, file) =>
          journal.changesetCheckpoint(operationId, index, file),
        authorize: async () => {
          if (this.input.signal?.aborted) return false;
          try {
            const current = await this.request<{
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
        root!,
        dispatch.payload,
        dispatch.payload.capability === 'local.fs.list' &&
          dispatch.payload.arguments.survey
          ? {
              signal: this.input.signal,
              authorize: () => this.executionCurrent(dispatch),
            }
          : undefined,
      );
    } catch (error) {
      if (
        dispatch.payload.capability === 'local.fs.list' &&
        dispatch.payload.arguments.survey
      ) {
        await journal.outcome(operationId, {
          status: 'failed',
          effects: 'none',
          summary: '目录检查未完成，未修改文件',
          errorCode:
            error instanceof FileGuardianError
              ? error.code
              : 'FILE_SURVEY_FAILED',
        });
        return;
      }
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

  private async executionCurrent(dispatch: RuntimeBridgeDispatch) {
    if (this.input.signal?.aborted) return false;
    try {
      const current = await this.request<{
        snapshot: unknown;
        leaseExpiresAt: string;
      }>({
        server: this.input.config.server,
        path: `${runtimeBridgeOperationPath}/${dispatch.snapshot.binding.attempt.operationId}/heartbeat`,
        method: 'POST',
        token: this.input.token,
        body: {
          contractVersion: 1,
          attempt: dispatch.snapshot.binding.attempt,
          leaseToken: dispatch.leaseToken,
        },
        timeoutMs: 2500,
        maximumResponseBytes: 200_000,
      });
      const snapshot = RuntimeOperationSnapshotSchema.parse(current.snapshot);
      return (
        !this.input.signal?.aborted &&
        snapshot.status === 'running' &&
        snapshot.cancelRequestId === null &&
        runtimeContractEqual(snapshot.binding, dispatch.snapshot.binding) &&
        Date.parse(current.leaseExpiresAt) > Date.now()
      );
    } catch {
      return false;
    }
  }

  private async executePdf(dispatch: RuntimeBridgeDispatch) {
    if (
      dispatch.payload.capability !== 'local.pdf.read' ||
      !this.input.pdfRunner
    )
      throw Error('PDF_EXECUTION_REVOKED');
    const { config, token, journal, pdfRunner } = this.input;
    const { operationId, attemptId } = dispatch.snapshot.binding.attempt;
    try {
      const result = await pdfRunner.execute(dispatch.payload, {
        attemptId,
        signal: this.input.signal,
        transport: localPdfHttpTransport({
          server: config.server,
          token,
          id: operationId,
          leaseToken: dispatch.leaseToken,
        }),
        maintainLease: async () => {
          if (this.input.signal?.aborted) return false;
          try {
            const current = await this.request<{
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
      });
      if (result.process.reason === 'process_unknown')
        await journal.uncertain(operationId, 'receipt_missing', {
          summary: '本地 PDF 完成状态待对账；保留原回执，不自动重读或换端',
          output: result,
        });
      else if (result.process.reason === 'canceled')
        await journal.stopped(
          operationId,
          result,
          '本地 PDF 读取已物理停止，未换端',
        );
      else
        await journal.outcome(operationId, {
          status: result.document !== null ? 'succeeded' : 'failed',
          effects: 'none',
          output: result,
          summary: result.document
            ? '本地固定 PDF 已解析授权原字节并物理退出；结果保留原页来源'
            : '本地 PDF 读取未完成；未自动重试或换端',
        });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (localPdfPreExecutionDenialCodes.some((value) => value === code))
        await journal.outcome(operationId, {
          status: 'failed',
          effects: 'none',
          summary: '本地 PDF 执行前校验未通过，解析进程未启动',
          errorCode: code,
          output: { errorCode: code },
        });
      else
        await journal.uncertain(operationId, 'receipt_missing', {
          summary: '本地 PDF 停止或结果待对账；不自动重读或换端',
        });
    }
  }

  private async executePython(dispatch: RuntimeBridgeDispatch) {
    if (
      dispatch.payload.capability !== 'local.python.execute' ||
      !this.input.pythonRunner
    )
      throw Error('LOCAL_PYTHON_UNAVAILABLE');
    const { pythonRunner: runner, journal, config, token } = this.input;
    const { operationId, attemptId } = dispatch.snapshot.binding.attempt;
    const body = {
      contractVersion: 1,
      attempt: dispatch.snapshot.binding.attempt,
      leaseToken: dispatch.leaseToken,
    };
    try {
      const result = await runner.execute(dispatch.payload, {
        attemptId,
        signal: this.input.signal,
        transport: localPythonHttpTransport({
          server: config.server,
          token,
          id: operationId,
          leaseToken: dispatch.leaseToken,
        }),
        maintainLease: async () => {
          if (this.input.signal?.aborted) return false;
          try {
            const current = await this.request<{
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
      });
      if (['canceled', 'lease_lost'].includes(result.reason))
        await journal.stopped(
          operationId,
          result,
          `本地 Python 已物理停止（${result.reason}）`,
        );
      else
        await journal.outcome(operationId, {
          status:
            result.reason === 'exited' && result.exitCode === 0
              ? 'succeeded'
              : 'failed',
          effects: 'none',
          output: result,
          summary: `本地 ${result.purpose === 'office' ? 'Office' : 'Python'} 已停止；${result.artifacts.length} 个原始字节输出已验证并上传`,
        });
      await runner
        .cleanup(attemptId, result.containerId, dispatch.payload)
        .catch(() => undefined);
    } catch (error) {
      const notExecuted =
        error instanceof LocalCommandError &&
        [
          'TOOLCHAIN_CHANGED',
          'ISOLATION_UNAVAILABLE',
          'UNSAFE_DAEMON_SOCKET',
          'INPUT_VERSION_CHANGED',
          'INPUT_LIMIT',
          'INPUT_DOWNLOAD_UNAVAILABLE',
          'EXECUTION_REVOKED',
        ].includes(error.code);
      if (notExecuted)
        await journal.outcome(operationId, {
          status: 'failed',
          effects: 'none',
          summary: '本地 Python 在执行前校验失败，未执行或换端',
          errorCode: error.code,
        });
      else
        await journal.uncertain(operationId, 'receipt_missing', {
          summary: '本地 Python 停止或字节收集结果待对账；不自动重放或换端',
        });
    }
  }

  private async executeMcp(dispatch: RuntimeBridgeDispatch, root: string) {
    if (
      dispatch.payload.capability !== 'local.mcp.discover' &&
      dispatch.payload.capability !== 'local.mcp.call'
    )
      throw new Error('LOCAL_MCP_TOOL_DENIED');
    const { config, token, journal, runner } = this.input,
      { operationId, attemptId } = dispatch.snapshot.binding.attempt,
      payload = dispatch.payload;
    if (!runner || !(await runner.localMcpEnabled())) {
      await journal.outcome(operationId, {
        status: 'failed',
        effects: 'none',
        summary: '本机未启用本地 MCP，进程未启动',
        errorCode: 'LOCAL_MCP_DISABLED',
      });
      return;
    }
    const mcp = new LocalMcpRunner(runner);
    try {
      const result = await mcp.execute(root, payload, {
        attemptId,
        hardDeadlineAt: new Date(
          Math.min(
            Date.parse(dispatch.leaseExpiresAt),
            Date.now() + payload.arguments.limits.timeoutMs,
          ),
        ).toISOString(),
        signal: this.input.signal,
        prepareCall: (intent) =>
          journal.prepareLocalMcpCall(operationId, intent),
        resolveCredential: (reference) =>
          readLocalMcpCredential({
            server: new URL(config.server).origin,
            deviceId: config.deviceId,
            connectionId: payload.arguments.connectionId,
            sourceDigest: payload.arguments.source.digest,
            reference,
          }),
        validateTools: validateLocalMcpTools,
        maintainLease: async () => {
          if (this.input.signal?.aborted)
            throw Error('LOCAL_MCP_STOP_REQUESTED');
          const current = await this.request<{
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
            maximumResponseBytes: 200000,
            timeoutMs: 2500,
          });
          const snapshot = RuntimeOperationSnapshotSchema.parse(
            current.snapshot,
          );
          if (
            !runtimeContractEqual(snapshot.binding, dispatch.snapshot.binding)
          )
            throw Error('LOCAL_MCP_BINDING_CHANGED');
          return {
            leaseExpiresAt: current.leaseExpiresAt,
            stopRequested:
              snapshot.status !== 'running' ||
              snapshot.cancelRequestId !== null ||
              Boolean(this.input.signal?.aborted),
          };
        },
      });
      // initialize/tools/list already execute untrusted server code. Missing
      // results cannot prove absence of effects even before tools/call.
      if (
        !result.stopConfirmed ||
        !result.resultKnown ||
        result.toolResult?.isError
      ) {
        await journal.uncertain(operationId, 'receipt_missing', {
          summary: '本地 MCP 结果待核实，不自动重试',
          output: result,
        });
      } else {
        await journal.outcome(operationId, {
          status: result.resultKnown ? 'succeeded' : 'failed',
          effects: result.callAttempted ? 'applied' : 'none',
          summary: result.resultKnown
            ? '本地 MCP 已返回；隔离进程已停止'
            : '本地 MCP 未返回成功结果；已确认停止',
          output: result,
        });
      }
      // Store complete evidence before removing the exact stopped container.
      if (result.stopConfirmed)
        await mcp.cleanup(attemptId, result.containerId).catch(() => undefined);
    } catch {
      // A failure can occur after starting code or dispatching a call. Cold
      // recovery stops only our exact container and never replays protocol.
      await journal.uncertain(operationId, 'receipt_missing', {
        summary: '本地 MCP 执行中断，结果待核实；不会自动重发',
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
      persistenceQueue = Promise.resolve(),
      outputFailed = false,
      journalFailed = false;
    try {
      const result = await runner.execute(root, dispatch.payload, {
        attemptId,
        signal: this.input.signal,
        leaseExpiresAt: dispatch.leaseExpiresAt,
        maintainLease: async () => {
          if (outputFailed || this.input.signal?.aborted) return false;
          try {
            const current = await this.request<{
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
          // Disk commit must not wait behind a stalled network acknowledgment.
          const saved = persistenceQueue.then(async () => {
            if (journalFailed)
              throw new BridgeJournalError('JOURNAL_OUTPUT_NOT_DURABLE');
            return journal.recordOutput(operationId, chunk);
          });
          persistenceQueue = saved
            .then(() => undefined)
            .catch(() => {
              journalFailed = true;
              outputFailed = true;
            });
          outputQueue = outputQueue
            .then(async () => {
              const body = await saved;
              if (outputFailed) return; // still retain every later bounded chunk on disk
              await this.deliverOutput(body);
            })
            .catch(() => {
              outputFailed = true;
            });
        },
      });
      await persistenceQueue;
      await outputQueue;
      if (journalFailed)
        throw new BridgeJournalError('JOURNAL_OUTPUT_NOT_DURABLE');
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
      // A daemon/log failure can reject after onOutput has queued disk commits.
      // Drain those callbacks before unknown/final closes the entry to new output.
      await persistenceQueue;
      await outputQueue;
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
          'CANDIDATE_CONTENT_CHANGED',
          'EXECUTION_REVOKED',
          'DEPENDENCY_SOURCE_DENIED',
          'DEPENDENCY_DOWNLOAD_REJECTED',
          'DEPENDENCY_ARCHIVE_LIMIT',
          'DEPENDENCY_MANIFEST_REQUIRED',
          'DEPENDENCY_MANIFEST_INVALID',
          'DEPENDENCY_LAYOUT_UNSUPPORTED',
          'DEPENDENCY_LOCK_MISMATCH',
          'DEPENDENCY_ARCHIVE_REQUIRED',
          'DEPENDENCY_INTEGRITY_MISMATCH',
          'DEPENDENCY_NETWORK_UNAVAILABLE',
        ].includes(error.code);
      if (noExecution)
        await journal.outcome(operationId, {
          status: 'failed',
          effects: 'none',
          summary:
            dependencyPreparationErrorLabels[error.code] ??
            '本地执行前检查未通过，命令未运行',
          errorCode: error.code,
        });
      else await journal.uncertain(operationId, 'receipt_missing');
    }
  }
}
