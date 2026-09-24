import { randomUUID } from 'node:crypto';
import {
  CloudCommandInputSchema,
  NativeOfficeExportSchema,
  type DeliveryFormat,
} from '@allrice/contracts';
import { getDatabase, getToolBrokerFile } from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';
import { CloudRunnerBackend } from '../cloud-runner/backend.js';
import type { RiceToolExecutionInput } from '../tool-broker/types.js';
import { readOfficeBytes } from './export.js';
import { OfficePackage, officeError, officeMediaTypes } from './package.js';

/** Execute upstream's Python workflow, then return bytes to the existing
 * managed export/version/quality pipeline. No document-editing engine here. */
export async function generateNativeOfficeExport(
  input: RiceToolExecutionInput,
  format: DeliveryFormat,
  value: unknown,
) {
  if (format !== 'docx' && format !== 'xlsx' && format !== 'pptx')
    officeError('Python Office 交付须使用 docx、xlsx 或 pptx');
  const native = NativeOfficeExportSchema.parse(value);
  if (native.inputs.length && !input.capabilities.includes('storage:read'))
    officeError('读取 Office 输入文件需要文件读取能力');
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
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      ...(input.signal ? { signal: input.signal } : {}),
      maintainLease,
    });
    if (result.reason !== 'completed' || !result.artifacts[0])
      officeError(
        `原生 Office 执行未完成 (${result.reason})：${result.output.slice(-6000)}`,
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
      nativeExecution: {
        status: 'checked' as const,
        upstream: '@deepseek-ai/dsh-skill-office@0.1.7-alpha.2',
        output: result.output.slice(-6000),
      },
    };
  } finally {
    // Office only computes private document bytes. Publication is performed by
    // the existing idempotent export broker after successful validation.
    await backend.stop(attemptId).catch(() => false);
    await backend.cleanup(attemptId);
  }
}
