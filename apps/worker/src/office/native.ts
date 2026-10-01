import { randomUUID } from 'node:crypto';
import {
  CloudCommandInputSchema,
  NativeOfficeExportSchema,
  type DeliveryFormat,
  type ExecutionLocation,
} from '@allrice/contracts';
import {
  getDatabase,
  getToolBrokerFile,
  executionResourceObserver,
} from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';
import {
  CloudRunnerBackend,
  CloudRunnerError,
} from '../cloud-runner/backend.js';
import { HandlerError } from '../errors.js';
import type { RiceToolExecutionInput } from '../tool-broker/types.js';
import { readOfficeBytes } from './export.js';
import { OfficePackage, officeError, officeMediaTypes } from './package.js';
import { executeManagedOffice } from './managed-python.js';

/** Execute upstream's Python workflow, then return bytes to the existing
 * managed export/version/quality pipeline. No document-editing engine here. */
export async function generateNativeOfficeExport(
  input: RiceToolExecutionInput,
  format: DeliveryFormat,
  value: unknown,
  location?: ExecutionLocation,
) {
  if (format !== 'docx' && format !== 'xlsx' && format !== 'pptx')
    officeError('Python Office 交付须使用 docx、xlsx 或 pptx');
  const native = NativeOfficeExportSchema.parse(value);
  if (native.inputs.length && !input.capabilities.includes('storage:read'))
    officeError('读取 Office 输入文件需要文件读取能力');
  const choice = await executeManagedOffice(input, format, native, location);
  if (choice.location === 'local') {
    const source = native.inputs.find(
      (f) => f.objectId === native.sourceObjectId,
    );
    return {
      bytes: choice.bytes,
      mediaType: officeMediaTypes[format],
      extension: `.${format}`,
      sourceFile: source
        ? { objectId: source.objectId, checksum: source.checksum }
        : undefined,
      warnings: undefined,
      changes: undefined,
      cloudQualityAllowed: !choice.localOnly,
      nativeExecution: {
        status: 'checked' as const,
        upstream: '@deepseek-ai/dsh-skill-office@0.1.7-alpha.2',
        output: `${choice.result.stdout}\n${choice.result.stderr}`.slice(-6000),
        executionLocation: 'local' as const,
        executionReason: choice.reason,
        operationId: choice.operationId,
        profileVersion: choice.result.profileVersion,
        imageId: choice.result.imageId,
        stopped: choice.result.stopped,
        artifactsCollected: true,
      },
    };
  }
  const storage = new LocalStorageAdapter(input.storageRoot);
  const files = [];
  let size = 0;
  for (const selected of native.inputs) {
    const file = await getToolBrokerFile(input.context, selected.objectId);
    if (file.object.checksum !== selected.checksum)
      officeError('输入文件已变化，请重新读取');
    size += file.object.sizeBytes;
    if (size > 20_000_000) officeError('Office 输入文件合计超过 20 MB');
    const bytes = await readOfficeBytes(await storage.get(file.object));
    files.push({
      path: selected.path,
      contentBase64: bytes.toString('base64'),
    });
  }
  const args = CloudCommandInputSchema.parse({
    script: native.script,
    inputs: native.inputs,
    outputs: [
      { path: `result.${format}`, fileName: `result.${format}`, format: 'txt' },
    ],
    limits: {
      timeoutMs: 60_000,
      artifactBytes: 4_000_000,
      memoryMiB: 512,
      cpuMillis: 1000,
    },
  });
  const backend = new CloudRunnerBackend(),
    attemptId = randomUUID();
  const db = getDatabase(),
    ctx = input.context;
  const leaseToken = input.managedBrowserJobLeaseToken;
  if (!leaseToken) officeError('任务执行租约不可用，请重试当前任务');
  const observer = executionResourceObserver(
    { context: ctx, leaseToken, attemptId, callId: input.call.id },
    db,
  );
  let nextCheck = 0,
    active = false;
  const maintainLease = async () => {
    if (input.signal?.aborted) return false;
    if (Date.now() < nextCheck) return active;
    const [job] =
      await db`select id from allrice_jobs where id=${ctx.jobId} and run_id=${ctx.runId} and organization_id=${ctx.organizationId} and worker_id=${ctx.worker.id} and lease_token::text=${leaseToken} and status='running' and lease_expires_at>clock_timestamp() and timeout_at>clock_timestamp() and cancel_requested_at is null`;
    active = !!job;
    nextCheck = Date.now() + 1000;
    return active;
  };
  try {
    const result = await backend.executeOffice(args, files, {
      attemptId,
      deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
      isTurn: observer.isTurn,
      observe: observer.observe,
      ...(input.signal ? { signal: input.signal } : {}),
      maintainLease,
    });
    if (result.reason !== 'completed' || !result.artifacts[0])
      officeError(
        `原生 Office 执行未完成 (${result.reason}; exitCode=${result.exitCode ?? 'unknown'})：${result.output.slice(-6000) || '沙箱未返回诊断输出，不能据此判断为公式或图表错误。'}`,
      );
    const bytes = Buffer.from(result.artifacts[0].contentBase64, 'base64');
    await OfficePackage.open(bytes, format);
    const source = native.inputs.find(
      (f) => f.objectId === native.sourceObjectId,
    );
    return {
      bytes,
      mediaType: officeMediaTypes[format],
      extension: `.${format}`,
      sourceFile: source
        ? { objectId: source.objectId, checksum: source.checksum }
        : undefined,
      warnings: undefined,
      changes: undefined,
      cloudQualityAllowed: true,
      nativeExecution: {
        status: 'checked' as const,
        upstream: '@deepseek-ai/dsh-skill-office@0.1.7-alpha.2',
        output: result.output.slice(-6000),
        executionLocation: 'cloud' as const,
        executionReason: choice.reason,
      },
    };
  } catch (error) {
    const code =
      error instanceof CloudRunnerError &&
      /^CLOUD_[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : error instanceof HandlerError
          ? error.code
          : 'OFFICE_EXECUTION_FAILED';
    console.error('[Office] Native export failed', {
      runId: ctx.runId,
      callId: input.call.id,
      attemptId,
      format,
      code,
    });
    if (error instanceof HandlerError) throw error;
    // The finally block must confirm cleanup before this known pre-publication
    // failure can reach the broker's settlement boundary.
    throw new HandlerError(
      'OFFICE_RUNTIME_UNAVAILABLE',
      `Office 沙箱执行失败（${code}），本次未发布文件，可以重试。`,
      true,
    );
  } finally {
    // Office only computes private document bytes. Publication is performed by
    // the existing idempotent export broker after successful validation.
    await backend
      .stop(attemptId)
      .then(() => backend.cleanup(attemptId))
      .catch(() => {
        throw new HandlerError(
          'OFFICE_CLEANUP_UNCONFIRMED',
          'Office 沙箱停止状态尚未确认，请等待执行状态核对。',
          false,
        );
      });
  }
}
