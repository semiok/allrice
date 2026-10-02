import { createHash } from 'node:crypto';
import {
  OfficePdfExportSchema,
  type ExecutionLocation,
} from '@allrice/contracts';
import { getToolBrokerFile, selectOfficePdfExecution } from '@allrice/database';
import { officeFormat } from '@allrice/office-runtime';
import { previewOfficePdf } from '@allrice/office-runtime/preview';
import { LocalStorageAdapter } from '@allrice/storage';
import { HandlerError } from '../errors.js';
import type { RiceToolExecutionInput } from '../tool-broker/types.js';
import { readOfficeBytes } from './export.js';

const maximumSourceBytes = 20 * 1024 * 1024;
const maximumPdfBytes = 8_000_000;

/** The original DSH provider owns conversion and cancellation. This adapter
 * supplies only the authorized immutable Office bytes to that provider. */
export async function generateOfficePdfExport(
  input: RiceToolExecutionInput,
  value: unknown,
  location?: ExecutionLocation,
) {
  input.signal?.throwIfAborted();
  const officePdf = OfficePdfExportSchema.parse(value);
  if (!input.capabilities.includes('storage:read'))
    throw new HandlerError(
      'TOOL_CAPABILITY_DENIED',
      '转换原 Office 文件需要文件读取能力',
      false,
    );
  if (!input.managedBrowserJobAttempt || !input.managedBrowserJobLeaseToken)
    throw new HandlerError(
      'OFFICE_PDF_LEASE_UNAVAILABLE',
      '本轮任务租约不可用，未读取或转换原文件。',
      false,
    );
  const selection = await selectOfficePdfExecution({
    context: input.context,
    callId: input.call.id,
    arguments: input.call.arguments,
    officePdf,
    jobAttempt: input.managedBrowserJobAttempt,
    jobLeaseToken: input.managedBrowserJobLeaseToken,
    ...(location !== undefined ? { location } : {}),
  });
  if (
    selection.choice.status !== 'execute' ||
    selection.choice.location !== 'cloud' ||
    !selection.source
  )
    throw new HandlerError(
      'OFFICE_PDF_EXECUTION_UNAVAILABLE',
      `Office 转 PDF 的所选执行位置不可用（${selection.selectionReason}）；未读取原文件或自动换端。`,
      false,
    );
  const remaining = Date.parse(selection.deadlineAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0)
    throw new HandlerError(
      'OFFICE_PDF_LEASE_UNAVAILABLE',
      '本轮任务已到期，未读取或转换原文件。',
      false,
    );
  const deadline = AbortSignal.timeout(
    Math.max(1, Math.floor(Math.min(60_000, remaining))),
  );
  const signal = input.signal
    ? AbortSignal.any([input.signal, deadline])
    : deadline;
  signal.throwIfAborted();
  const file = await getToolBrokerFile(input.context, officePdf.objectId);
  signal.throwIfAborted();
  if (
    file.object.id !== officePdf.objectId ||
    file.object.checksum !== officePdf.checksum ||
    selection.source.source.objectId !== officePdf.objectId ||
    selection.source.source.checksum !== officePdf.checksum
  )
    throw new HandlerError(
      'TOOL_SOURCE_CHANGED',
      'Office 原文件或版本已变化，请重新读取。',
      false,
    );
  const format = officeFormat(file.object.mediaType);
  if (!format)
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      '原文件必须是 docx、xlsx 或 pptx，不能用其他文件冒充 Office 来源。',
      false,
    );
  if (file.object.sizeBytes > maximumSourceBytes)
    throw new HandlerError(
      'TOOL_FILE_TOO_LARGE',
      'Office 原文件超过 20 MiB，请先拆分文件。',
      false,
    );
  const storage = new LocalStorageAdapter(input.storageRoot);
  let sourceVerified = false;
  const readSource: Parameters<typeof previewOfficePdf>[0]['read'] = async (
    readSignal,
    maximum,
  ) => {
    const readAbort = AbortSignal.any([signal, readSignal]);
    readAbort.throwIfAborted();
    if (!Number.isSafeInteger(maximum) || maximum < file.object.sizeBytes)
      throw new HandlerError(
        'TOOL_FILE_TOO_LARGE',
        'Office 来源超过转换器允许的读取额度。',
        false,
      );
    const stream = await storage.get(file.object);
    const limit = Math.min(maximumSourceBytes, maximum, file.object.sizeBytes);
    let received = 0;
    const bounded = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        readAbort.throwIfAborted();
        received += chunk.byteLength;
        if (received > limit)
          throw new HandlerError(
            'TOOL_SOURCE_CHANGED',
            'Office 原文件字节数与登记版本不一致，请重新读取。',
            false,
          );
        controller.enqueue(chunk);
      },
    });
    // Standard stream cancellation also interrupts a pending source read;
    // checking only between chunks would leave a stalled read uncancelable.
    void stream
      .pipeTo(bounded.writable, { signal: readAbort })
      .catch(() => undefined);
    const bytes = await readOfficeBytes(bounded.readable);
    readAbort.throwIfAborted();
    if (
      bytes.length !== file.object.sizeBytes ||
      `sha256:${createHash('sha256').update(bytes).digest('hex')}` !==
        officePdf.checksum
    )
      throw new HandlerError(
        'TOOL_SOURCE_CHANGED',
        'Office 原文件内容与登记版本不一致，请重新读取。',
        false,
      );
    sourceVerified = true;
    return bytes;
  };
  const converted = await previewOfficePdf({
    objectId: file.object.id,
    checksum: officePdf.checksum,
    sizeBytes: file.object.sizeBytes,
    format,
    signal,
    read: readSource,
  });
  signal.throwIfAborted();
  if (!converted.pdf.byteLength)
    throw new HandlerError(
      'OFFICE_PDF_CONVERSION_FAILED',
      '转换器未返回完整 PDF，本次未发布文件。',
      false,
    );
  if (converted.pdf.byteLength > maximumPdfBytes)
    throw new HandlerError(
      'TOOL_FILE_TOO_LARGE',
      'PDF 交付文件超过 8 MB，请先拆分原文件。',
      false,
    );
  // A DSH source-alias cache hit skips its deferred read. Still verify the
  // authorized original bytes; stale cache metadata cannot hide changed data.
  if (!sourceVerified) await readSource(signal, file.object.sizeBytes);
  signal.throwIfAborted();
  return {
    bytes: Buffer.from(converted.pdf),
    mediaType: 'application/pdf',
    extension: '.pdf',
    sourceFile: selection.source.source,
    changes: undefined,
    warnings: converted.missingFonts.length
      ? [
          `PDF 转换未找到字体：${converted.missingFonts.join('、')}；请核对字符显示与排版。`,
        ]
      : [],
    nativeConversion: {
      status: 'converted' as const,
      provider: '@deepseek-ai/dsh-office-to-pdf@0.1.7-rc.1',
      backend: 'platform-dsh-provider',
      sourceFormat: format,
      executionLocation: 'cloud' as const,
      executionReason: selection.selectionReason,
      missingFonts: converted.missingFonts,
      cache: { key: converted.cacheKey, generation: converted.generation },
    },
  };
}
