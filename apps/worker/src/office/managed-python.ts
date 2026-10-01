import { createHash } from 'node:crypto';
import {
  RuntimeLocalPythonPayloadSchema,
  RuntimeLocalPythonResultSchema,
  ExecutionLocationSchema,
  type NativeOfficeExportSchema,
  type ExecutionLocation,
  type RuntimeLocalPythonPayload,
} from '@allrice/contracts';
import {
  selectManagedPythonExecution,
  createLocalPythonOperation,
  waitLocalPythonOperation,
  getToolBrokerFile,
  cloudStableId,
  runtimePolicyDigest,
  RuntimePolicyError,
} from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';
import type { RiceToolExecutionInput } from '../tool-broker/types.js';
import { waitForLocalAdmission } from '../tool-broker/handlers/local-admission.js';
import { HandlerError, confirmToolFailure } from '../errors.js';
import { readOfficeBytes } from './export.js';
import { OfficePackage, officeMediaTypes } from './package.js';

/** Internal adapter for the original frozen tool/call. Publication still has
 * exactly one owner: workspace.export.create's existing managed export path. */
export async function executeManagedOffice(
  input: RiceToolExecutionInput,
  format: 'docx' | 'xlsx' | 'pptx',
  native: ReturnType<typeof NativeOfficeExportSchema.parse>,
  location?: ExecutionLocation,
) {
  const requested = ExecutionLocationSchema.parse(location ?? 'auto');
  if (!input.managedBrowserJobLeaseToken || !input.managedBrowserJobAttempt) {
    if (requested === 'local')
      throw new HandlerError(
        'OFFICE_LOCAL_UNAVAILABLE',
        '本地 Office 需要当前任务的执行租约；本次未执行。',
        false,
      );
    return {
      location: 'cloud' as const,
      reason: 'legacy_cloud_snapshot',
      localOnly: false,
    };
  }
  const inputs: RuntimeLocalPythonPayload['arguments']['inputs'] = [];
  let total = 0;
  for (const selected of native.inputs) {
    const file = await getToolBrokerFile(input.context, selected.objectId);
    if (file.object.checksum !== selected.checksum)
      throw new HandlerError(
        'OFFICE_INPUT_CHANGED',
        '输入版本已变化，请重新读取当前文件。',
        true,
      );
    total += file.object.sizeBytes;
    if (total > 20_000_000)
      throw new HandlerError(
        'TOOL_FILE_TOO_LARGE',
        'Office 输入合计超过 20 MB。',
        false,
      );
    inputs.push({
      ...selected,
      sizeBytes: file.object.sizeBytes,
      mediaType: file.object.mediaType,
    });
  }
  let selected:
    Awaited<ReturnType<typeof selectManagedPythonExecution>> | undefined;
  const created = await waitForLocalAdmission(input, async () => {
    selected = await selectManagedPythonExecution({
      context: input.context,
      callId: input.call.id,
      toolName: 'workspace.export.create',
      arguments: input.call.arguments,
      purpose: 'office',
      inputs,
      location: requested,
      jobAttempt: input.managedBrowserJobAttempt!,
      jobLeaseToken: input.managedBrowserJobLeaseToken!,
    });
    if (selected.choice.status === 'reconcile')
      throw new HandlerError(
        'OFFICE_LOCAL_RESULT_UNKNOWN',
        '原本地 Office 操作结果待对账；不会重放或换端。',
        false,
      );
    if (selected.choice.status === 'unavailable')
      throw new HandlerError(
        'OFFICE_LOCAL_UNAVAILABLE',
        `本地 Office 不可用（${selected.choice.reason}）；本次未执行或换端。`,
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
        'OFFICE_LOCAL_UNAVAILABLE',
        '本地固定 Python 运行环境尚未验证。',
        false,
      );
    // Resume a known immutable operation using its original output identities
    // and pins. This is not a second execution or regeneration.
    const payload = RuntimeLocalPythonPayloadSchema.parse({
      capability: 'local.python.execute',
      arguments: {
        path: '.',
        purpose: 'office',
        origin: {
          toolName: 'workspace.export.create',
          callId: input.call.id,
          argumentsDigest: runtimePolicyDigest(input.call.arguments),
        },
        script: native.script,
        inputs,
        outputs: [
          {
            path: `result.${format}`,
            fileName: `result.${format}`,
            format,
            mediaType: officeMediaTypes[format],
            objectId: cloudStableId(
              `managed-python-output:${input.context.runId}:${input.call.id}:0`,
            ),
          },
        ],
        profileVersion: 1,
        imageId: selected.profile.imageId,
        architecture: selected.profile.architecture,
        isolation: 'local-vm-container-v1',
        network: 'none',
        limits: {
          timeoutMs: 60_000,
          inputBytes: 20_000_000,
          artifactBytes: 8_000_000,
          outputBytes: 65_536,
          memoryMiB: 512,
          cpuMillis: 1000,
          pids: 64,
        },
      },
    });
    return createLocalPythonOperation({
      selection: selected,
      context: input.context,
      payload,
      arguments: input.call.arguments,
    });
  });
  if (!created)
    return {
      location: 'cloud' as const,
      reason: selected!.selectionReason,
      localOnly: selected!.localOnly,
    };
  const settled = await waitLocalPythonOperation(created, input.signal);
  const evidence = settled.evidence as {
    output?: unknown;
    summary?: string;
    errorCode?: string;
  } | null;
  const result = RuntimeLocalPythonResultSchema.safeParse(evidence?.output);
  if (
    settled.status !== 'succeeded' ||
    !result.success ||
    result.data.reason !== 'exited' ||
    result.data.exitCode !== 0 ||
    result.data.artifacts.length !== 1
  ) {
    const known =
      result.success && ['failed', 'canceled'].includes(settled.status);
    const error = new HandlerError(
      known ? 'OFFICE_RUNTIME_UNAVAILABLE' : 'OFFICE_LOCAL_RESULT_UNKNOWN',
      known
        ? `本地 Office 已停止但生成未完成（${result.data.reason}）：${result.data.stderr.slice(-4000)}`
        : '本地 Office 的停止或原始字节上传结果尚未确认；不自动重放或换端。',
      known,
    );
    if (known)
      confirmToolFailure(error, {
        runId: input.context.runId,
        callId: input.call.id,
        toolName: input.call.name,
      });
    throw error;
  }
  const artifact = result.data.artifacts[0]!,
    file = await getToolBrokerFile(input.context, artifact.objectId),
    storage = new LocalStorageAdapter(input.storageRoot);
  if (
    file.object.checksum !== artifact.checksum ||
    file.object.sizeBytes !== artifact.sizeBytes ||
    file.object.mediaType !== artifact.mediaType
  )
    throw new HandlerError(
      'OFFICE_LOCAL_RESULT_UNKNOWN',
      '本地 Office 已上传对象的版本不一致，需对账。',
      false,
    );
  const bytes = await readOfficeBytes(await storage.get(file.object));
  if (
    bytes.length !== artifact.sizeBytes ||
    `sha256:${createHash('sha256').update(bytes).digest('hex')}` !==
      artifact.checksum
  )
    throw new HandlerError(
      'OFFICE_LOCAL_RESULT_UNKNOWN',
      '本地 Office 原始字节校验不一致，需对账。',
      false,
    );
  await OfficePackage.open(bytes, format);
  return {
    location: 'local' as const,
    reason: selected!.selectionReason,
    localOnly: selected!.localOnly,
    bytes,
    result: result.data,
    operationId: settled.operationId,
  };
}
