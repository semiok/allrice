import {
  RuntimeLocalPythonPayloadSchema,
  RuntimeLocalPythonResultSchema,
  localPythonResultMatchesPayload,
  type PythonExecuteArgs,
  type RuntimeLocalPythonPayload,
} from '@allrice/contracts';
import {
  selectManagedPythonExecution,
  createLocalPythonOperation,
  waitLocalPythonOperation,
  publishLocalPythonArtifacts,
  createCloudPythonOperation,
  getToolBrokerFile,
  cloudStableId,
  runtimePolicyDigest,
  RuntimePolicyError,
} from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';
import { runCloudCommandOperation } from '../cloud-runner/executor.js';
import { HandlerError, confirmToolFailure } from '../errors.js';
import { waitForLocalAdmission } from '../tool-broker/handlers/local-admission.js';
import type { RiceToolExecutionInput } from '../tool-broker/types.js';

const mediaTypes = {
  png: 'image/png',
  json: 'application/json',
  csv: 'text/csv',
  txt: 'text/plain',
} as const;

function unknownResult() {
  return new HandlerError(
    'PYTHON_LOCAL_RESULT_UNKNOWN',
    '原本地 Python 操作的停止或成果版本尚未确认；需对账，不会重放或换端。',
    false,
  );
}

/** One original frozen call, one selected operation, and the existing byte
 * publisher. Neither a local wait nor an uncertain outcome starts cloud work. */
export async function executeManagedCharts(
  input: RiceToolExecutionInput,
  args: PythonExecuteArgs,
) {
  if (!input.managedBrowserJobLeaseToken || !input.managedBrowserJobAttempt)
    throw new HandlerError(
      'PYTHON_EXECUTION_UNAVAILABLE',
      'Python 计算需要当前任务的执行租约；本次未执行。',
      false,
    );
  const inputs: RuntimeLocalPythonPayload['arguments']['inputs'] = [];
  let inputBytes = 0;
  for (const requested of args.inputs) {
    const file = await getToolBrokerFile(input.context, requested.objectId);
    if (file.object.checksum !== requested.checksum)
      throw new HandlerError(
        'PYTHON_INPUT_CHANGED',
        '输入版本已变化，请重新读取当前文件。',
        false,
      );
    inputBytes += file.object.sizeBytes;
    if (inputBytes > 2_000_000)
      throw new HandlerError(
        'TOOL_FILE_TOO_LARGE',
        'Python 输入合计超过 2 MB。',
        false,
      );
    inputs.push({
      ...requested,
      sizeBytes: file.object.sizeBytes,
      mediaType: file.object.mediaType,
    });
  }
  let selection:
      Awaited<ReturnType<typeof selectManagedPythonExecution>> | undefined,
    payload: RuntimeLocalPythonPayload | undefined;
  const created = await waitForLocalAdmission(input, async () => {
    selection = await selectManagedPythonExecution({
      context: input.context,
      callId: input.call.id,
      toolName: 'python.execute',
      arguments: input.call.arguments,
      purpose: 'python_charts',
      inputs,
      location: args.location ?? 'auto',
      jobAttempt: input.managedBrowserJobAttempt!,
      jobLeaseToken: input.managedBrowserJobLeaseToken!,
    });
    if (selection.choice.status === 'reconcile') throw unknownResult();
    if (selection.choice.status === 'unavailable')
      throw new HandlerError(
        'PYTHON_LOCAL_UNAVAILABLE',
        `Python 执行环境不可用（${selection.choice.reason}）；本次未执行或换端。`,
        false,
      );
    if (selection.choice.status === 'wait')
      throw new RuntimePolicyError(
        selection.choice.reason === 'local_busy'
          ? 'local_runner_busy'
          : 'local_runner_preparing',
      );
    if (selection.choice.location === 'cloud') {
      if (selection.localOnly || args.location === 'local')
        throw new HandlerError(
          'PYTHON_LOCAL_UNAVAILABLE',
          '本次计算要求本地执行；不会改用云端。',
          false,
        );
      return null;
    }
    if (
      selection.choice.location !== 'local' ||
      !selection.profile ||
      selection.profile.pythonChartsContractVersion !== 1
    )
      throw new HandlerError(
        'PYTHON_LOCAL_UNAVAILABLE',
        '本地 Python 图表协议尚未通过实际探测。',
        false,
      );
    payload = RuntimeLocalPythonPayloadSchema.parse({
      capability: 'local.python.execute',
      arguments: {
        path: '.',
        purpose: 'python_charts',
        origin: {
          toolName: 'python.execute',
          callId: input.call.id,
          argumentsDigest: runtimePolicyDigest(input.call.arguments),
        },
        script: args.script,
        inputs,
        outputs: args.outputs.map((file, index) => ({
          ...file,
          mediaType: mediaTypes[file.format],
          objectId: cloudStableId(
            `managed-python-output:${input.context.runId}:${input.call.id}:${index}`,
          ),
        })),
        profileVersion: 1,
        imageId: selection.profile.imageId,
        architecture: selection.profile.architecture,
        isolation: 'local-vm-container-v1',
        network: 'none',
        limits: { ...args.limits, inputBytes: 2_000_000 },
      },
    });
    return createLocalPythonOperation({
      context: input.context,
      selection,
      payload,
      arguments: input.call.arguments,
    });
  });
  const storage = new LocalStorageAdapter(input.storageRoot);
  if (!created) {
    const cloud = await createCloudPythonOperation({
      context: input.context,
      callId: input.call.id,
      arguments: input.call.arguments,
    });
    const result = await runCloudCommandOperation(cloud, {
      storage,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return {
      ...result,
      source: 'cloud-gvisor-v1' as const,
      location: 'cloud' as const,
      selectionReason: selection!.selectionReason,
      language: 'python' as const,
      localFilesModified: false,
    };
  }
  const settled = await waitLocalPythonOperation(created, input.signal);
  const evidence = settled.evidence as { output?: unknown } | null,
    parsed = RuntimeLocalPythonResultSchema.safeParse(evidence?.output);
  if (
    !parsed.success ||
    !localPythonResultMatchesPayload(payload!, parsed.data) ||
    parsed.data.artifacts.some((file) =>
      file.format === 'png'
        ? !file.png || file.png.checksum !== file.checksum
        : file.png !== undefined,
    )
  )
    throw unknownResult();
  const result = parsed.data;
  if (
    settled.status !== 'succeeded' ||
    result.reason !== 'exited' ||
    result.exitCode !== 0
  ) {
    if (!['failed', 'canceled'].includes(settled.status)) throw unknownResult();
    const error = new HandlerError(
      'PYTHON_RUNTIME_FAILED',
      `本地 Python 已停止但计算未完成（${result.reason}）：${result.stderr.slice(-4000)}`,
      false,
    );
    confirmToolFailure(error, {
      runId: input.context.runId,
      callId: input.call.id,
      toolName: input.call.name,
    });
    throw error;
  }
  const published = await publishLocalPythonArtifacts(
    { context: input.context, operationId: settled.operationId },
    storage,
  );
  if (
    published.length !== result.artifacts.length ||
    new Set(published.map((file) => file.object.id)).size !== published.length
  )
    throw unknownResult();
  const artifacts = published.map((file) => {
    const proof = result.artifacts.find((a) => a.objectId === file.object.id);
    if (
      !proof ||
      file.fileName !== proof.fileName ||
      file.object.checksum !== proof.checksum ||
      file.object.sizeBytes !== proof.sizeBytes ||
      file.object.mediaType !== proof.mediaType
    )
      throw unknownResult();
    return {
      objectId: file.object.id,
      versionId: file.versionId,
      fileName: file.fileName,
      checksum: file.object.checksum,
      ...(proof.png ? { png: proof.png } : {}),
    };
  });
  return {
    operationId: settled.operationId,
    status: settled.status,
    artifacts,
    output: [result.stdout, result.stderr].filter(Boolean).join('\n'),
    exitCode: result.exitCode,
    source: 'local-vm-container-v1' as const,
    location: 'local' as const,
    selectionReason: selection!.selectionReason,
    language: 'python' as const,
    localFilesModified: false,
  };
}
