import { createHash } from 'node:crypto';
import {
  ImageToolInputSchema,
  PromptImageAttachmentSchema,
} from '@allrice/contracts';
import {
  claimImageOperation,
  finishImageOperation,
  recordImageReceipt,
  getToolBrokerFile,
  publishWorkbenchArtifact,
  workbenchEnabled,
} from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';
import {
  requestCodexImage,
  CodexImageGenerationFailedError,
} from '../../codex-image-broker.js';
import { loadHarnessImages } from '../../harness/prompt-images.js';
import { confirmToolFailure, HandlerError } from '../../errors.js';
import type { RiceToolHandler, RiceToolResult } from '../types.js';

const knownFailureCodes = new Set([
  'IMAGE_AUTH_REQUIRED',
  'IMAGE_RATE_LIMITED',
  'IMAGE_MODEL_UNAVAILABLE',
  'IMAGE_GENERATION_FAILED',
]);

export function decodeGeneratedPng(encoded: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw new HandlerError('IMAGE_RESULT_INVALID', '图片数据无效', false);
  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.length < 45 ||
    bytes.length > 8_000_000 ||
    bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    bytes.subarray(12, 16).toString() !== 'IHDR' ||
    bytes.subarray(-8, -4).toString() !== 'IEND'
  )
    throw new HandlerError('IMAGE_RESULT_INVALID', '图片数据无效', false);
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (
    !width ||
    !height ||
    width > 8192 ||
    height > 8192 ||
    width * height > 32_000_000
  )
    throw new HandlerError('IMAGE_RESULT_INVALID', '图片尺寸无效', false);
  return { bytes, width, height };
}

export const generateImage: RiceToolHandler = async ({
  input,
  arguments: value,
}) => {
  const args = ImageToolInputSchema.parse(value);
  if (
    !input.sessionId ||
    !input.managedBrowserJobLeaseToken ||
    !workbenchEnabled()
  )
    throw new HandlerError(
      'IMAGE_UNAVAILABLE',
      '当前任务无法使用图片交付',
      false,
    );
  if (
    !input.capabilities.includes('model:invoke') ||
    (args.source && !input.capabilities.includes('storage:read'))
  )
    throw new HandlerError(
      'TOOL_CAPABILITY_DENIED',
      '当前任务没有所需图片权限',
      false,
    );
  if (input.call.name === 'image.edit' && !args.source)
    throw new HandlerError(
      'IMAGE_SOURCE_REQUIRED',
      '请明确选择要修改的图片及版本',
      false,
    );
  if (input.call.name === 'image.generate' && args.source)
    throw new HandlerError(
      'IMAGE_INPUT_INVALID',
      '修改图片请使用 image.edit',
      false,
    );
  let source;
  if (args.source) {
    const file = await getToolBrokerFile(input.context, args.source.objectId);
    if (
      file.object.checksum !== args.source.checksum ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(file.object.mediaType)
    )
      throw new HandlerError(
        'IMAGE_SOURCE_INVALID',
        '图片类型或版本不匹配，请重新选择原图',
        false,
      );
    const [image] = await loadHarnessImages(
      [
        PromptImageAttachmentSchema.parse({
          object: file.object,
          fileName: file.fileName,
        }),
      ],
      { storageRoot: input.storageRoot },
    );
    source = image;
  }
  const claimed = await claimImageOperation({
    context: input.context,
    sessionId: input.sessionId,
    callId: input.call.id,
    arguments: args,
    leaseToken: input.managedBrowserJobLeaseToken,
  });
  if (!claimed.execute) {
    if (claimed.status === 'succeeded' && claimed.result)
      return claimed.result as RiceToolResult;
    if (
      claimed.status === 'failed' &&
      knownFailureCodes.has(claimed.errorCode ?? '')
    ) {
      const failure = new HandlerError(
        claimed.errorCode!,
        '相同图片请求已确认失败，未取得图片；没有重复生成。',
        false,
      );
      confirmToolFailure(failure, {
        runId: input.context.runId,
        callId: input.call.id,
        toolName: input.call.name,
      });
      throw failure;
    }
    throw new HandlerError(
      'IMAGE_RESULT_UNKNOWN',
      '相同图片请求已提交，结果尚未确认或未成功；不会自动重复生成。',
      false,
    );
  }
  let received = false;
  try {
    const receipt = await requestCodexImage({
      configuration: claimed.configuration,
      prompt: args.prompt,
      ...(source ? { source } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    received = true;
    await recordImageReceipt({
      context: input.context,
      operationId: claimed.id,
      usage: receipt.usage,
      requestId: receipt.requestId,
    });
    if (input.signal?.aborted)
      throw new HandlerError(
        'IMAGE_RESULT_UNKNOWN',
        '已收到图片回执，但任务已取消，未继续发布。',
        false,
      );
    const { bytes, width, height } = decodeGeneratedPng(receipt.imageBase64);
    const fileName =
      [...args.fileName]
        .map((c) => (c.charCodeAt(0) < 32 ? '-' : c))
        .join('')
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/\.png$/i, '') + '.png';
    const artifact = await publishWorkbenchArtifact(
      {
        context: input.context,
        sessionId: input.sessionId,
        callId: `image:${claimed.id}`,
        kind: 'document',
        fileName,
        format: 'png',
        bytes,
        mediaType: 'image/png',
        trustedImageOperation: {
          id: claimed.id,
          leaseToken: input.managedBrowserJobLeaseToken,
        },
        ...(args.source
          ? {
              sourceFile: args.source,
              changeSummary: args.prompt.slice(0, 2000),
            }
          : {}),
      },
      new LocalStorageAdapter(input.storageRoot),
    );
    const result = {
      modelContent: JSON.stringify({
        operationId: claimed.id,
        objectId: artifact.object.id,
        artifactId: artifact.id,
        fileName,
        mediaType: 'image/png',
        width,
        height,
        checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        version: artifact.version.version,
        source: args.source ?? null,
        downloadUrl: `/api/v1/files/${artifact.object.id}/download?name=${encodeURIComponent(fileName)}`,
        imageModel: receipt.imageModel,
      }),
      summary: `已${args.source ? '修改' : '生成'}图片 ${fileName} · v${artifact.version.version}`,
      itemCount: 1,
    };
    await finishImageOperation({
      context: input.context,
      operationId: claimed.id,
      status: 'succeeded',
      result,
    });
    return result;
  } catch (error) {
    const code =
      error instanceof HandlerError ? error.code : 'IMAGE_RESULT_UNKNOWN';
    if (error instanceof CodexImageGenerationFailedError)
      await recordImageReceipt({
        context: input.context,
        operationId: claimed.id,
        usage: error.receipt.usage,
        requestId: error.receipt.requestId,
      });
    const knownFailure = !received && knownFailureCodes.has(code);
    const persisted = await finishImageOperation({
      context: input.context,
      operationId: claimed.id,
      status: knownFailure ? 'failed' : 'unknown',
      errorCode: code,
    }).catch(() => false);
    if (persisted && knownFailure && error instanceof HandlerError)
      confirmToolFailure(error, {
        runId: input.context.runId,
        callId: input.call.id,
        toolName: input.call.name,
      });
    throw error;
  }
};
