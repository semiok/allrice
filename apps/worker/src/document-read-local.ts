import {
  RuntimeLocalPdfPayloadSchema,
  RuntimeLocalPdfSourceSchema,
  RuntimeLocalPdfResultSchema,
  localPdfResultMatchesPayload,
  localPdfInputBytesV1,
  localPdfResultBytesV1,
  localPdfTimeoutMsV1,
  localPdfMemoryBudgetBytesV1,
  localPdfPreExecutionDenialCodes,
  type WorkspaceDocumentReadArgs,
  type RuntimeLocalPdfPayload,
} from '@allrice/contracts';
import {
  selectLocalPdfExecution,
  createLocalPdfReadOperation,
  waitLocalPdfReadOperation,
  runtimePolicyDigest,
  RuntimePolicyError,
} from '@allrice/database';
import type { getToolBrokerFile } from '@allrice/database';
import type { RiceToolExecutionInput } from './tool-broker/types.js';
import { waitForLocalAdmission } from './tool-broker/handlers/local-admission.js';
import { HandlerError, confirmToolFailure } from './errors.js';

/** Source access is resolved first. A bound attempt never silently changes end. */
export async function readPdfLocally(
  input: RiceToolExecutionInput,
  file: Awaited<ReturnType<typeof getToolBrokerFile>>,
  args: WorkspaceDocumentReadArgs,
) {
  if (!input.managedBrowserJobAttempt || !input.managedBrowserJobLeaseToken) {
    if (args.location === 'local')
      throw new HandlerError(
        'PDF_LOCAL_UNAVAILABLE',
        '本地 PDF 阅读需要当前任务的执行租约；本次未执行。',
        false,
      );
    return null;
  }
  const source = RuntimeLocalPdfSourceSchema.parse({
    objectId: file.object.id,
    checksum: file.object.checksum,
    sizeBytes: file.object.sizeBytes,
    mediaType: file.object.mediaType,
    ...(file.artifactVersionId
      ? {
          artifactVersionId: file.artifactVersionId,
          artifactVersion: file.artifactVersion,
        }
      : {}),
  });
  let payload: RuntimeLocalPdfPayload | undefined;
  const created = await waitForLocalAdmission(input, async () => {
    const selected = await selectLocalPdfExecution({
      context: input.context,
      callId: input.call.id,
      toolName: 'workspace.document.read',
      arguments: input.call.arguments,
      source,
      location: args.location ?? 'auto',
      jobAttempt: input.managedBrowserJobAttempt!,
      jobLeaseToken: input.managedBrowserJobLeaseToken!,
    });
    if (selected.choice.status === 'reconcile')
      throw new HandlerError(
        'PDF_LOCAL_RESULT_UNKNOWN',
        '原本地 PDF 阅读结果待对账；不会重放或换端。',
        false,
      );
    if (selected.choice.status === 'unavailable')
      throw new HandlerError(
        'PDF_LOCAL_UNAVAILABLE',
        `本地 PDF 阅读不可用（${selected.choice.reason}）；本次未执行或换端。`,
        false,
      );
    if (selected.choice.location === 'cloud') return null;
    if (selected.choice.status === 'wait')
      throw new RuntimePolicyError(
        selected.choice.reason === 'local_busy'
          ? 'local_runner_busy'
          : 'local_runner_preparing',
      );
    if (!selected.profile)
      throw new HandlerError(
        'PDF_LOCAL_UNAVAILABLE',
        '本地固定 PDF 阅读环境尚未验证。',
        false,
      );
    payload =
      selected.existingPayload ??
      RuntimeLocalPdfPayloadSchema.parse({
        capability: 'local.pdf.read',
        arguments: {
          path: '.',
          origin: {
            toolName: 'workspace.document.read',
            callId: input.call.id,
            argumentsDigest: runtimePolicyDigest(input.call.arguments),
          },
          source,
          fileName: file.fileName,
          options: {
            ...(args.maxCharacters !== undefined
              ? { maxCharacters: args.maxCharacters }
              : {}),
            ...(args.includeStructure !== undefined
              ? { includeStructure: args.includeStructure }
              : {}),
            ...(args.pages !== undefined ? { pages: args.pages } : {}),
          },
          profileVersion: 1,
          pins: selected.profile.pins,
          limits: {
            inputBytes: localPdfInputBytesV1,
            resultBytes: localPdfResultBytesV1,
            timeoutMs: localPdfTimeoutMsV1,
            resourceBudgetBytes: localPdfMemoryBudgetBytesV1,
          },
        },
      });
    return createLocalPdfReadOperation({
      selection: selected,
      context: input.context,
      payload,
      arguments: input.call.arguments,
    });
  });
  if (!created) return null;
  const settled = await waitLocalPdfReadOperation(created, input.signal);
  const output = (settled.evidence as { output?: unknown } | null)?.output;
  if (
    settled.status === 'failed' &&
    output &&
    typeof output === 'object' &&
    !('type' in output) &&
    'errorCode' in output &&
    typeof output.errorCode === 'string' &&
    (localPdfPreExecutionDenialCodes as readonly string[]).includes(
      output.errorCode,
    )
  ) {
    const error = new HandlerError(
      output.errorCode,
      '本地 PDF 阅读在启动前被拒绝，源文件或运行环境已变化；本次未解析，不自动换端。',
      false,
    );
    confirmToolFailure(error, {
      runId: input.context.runId,
      callId: input.call.id,
      toolName: input.call.name,
    });
    throw error;
  }
  const result = RuntimeLocalPdfResultSchema.safeParse(output);
  if (
    !payload ||
    !result.success ||
    !localPdfResultMatchesPayload(result.data, payload)
  )
    throw new HandlerError(
      'PDF_LOCAL_RESULT_UNKNOWN',
      '本地 PDF 回执与原始文件、页码或执行参数不一致；需对账，不自动重放或换端。',
      false,
    );
  if (settled.status !== 'succeeded' || !result.data.document) {
    const known =
      ['failed', 'canceled'].includes(settled.status) &&
      result.data.process.stopped &&
      result.data.process.reason !== 'process_unknown';
    const error = new HandlerError(
      known
        ? (result.data.error?.code ?? 'PDF_LOCAL_READ_FAILED')
        : 'PDF_LOCAL_RESULT_UNKNOWN',
      known
        ? (result.data.error?.message ?? '本地 PDF 阅读已停止但未完成。')
        : '本地 PDF 进程的停止或结果尚未确认；不自动重放或换端。',
      false,
    );
    if (known)
      confirmToolFailure(error, {
        runId: input.context.runId,
        callId: input.call.id,
        toolName: input.call.name,
      });
    throw error;
  }
  return {
    document: result.data.document,
    execution: {
      location: 'local' as const,
      backend: 'native-seatbelt-v1' as const,
      operationId: settled.operationId,
    },
  };
}
