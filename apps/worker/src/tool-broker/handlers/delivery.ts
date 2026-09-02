import { createHash } from 'node:crypto';

import {
  createToolBrokerExportObject,
  registerToolBrokerExport,
} from '@allrice/database';
import { DeliveryFormatSchema } from '@allrice/contracts';
import { LocalStorageAdapter } from '@allrice/storage';

import { generateDeliverable } from '../../deliverable-generator.js';
import { HandlerError } from '../../errors.js';
import { stringValue } from '../input-values.js';
import type { RiceToolHandler } from '../types.js';

export const createWorkspaceExport: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  if (!input.sessionId && !input.platformTestRunId) {
    throw new HandlerError(
      'TOOL_SESSION_REQUIRED',
      '创建交付文件需要当前对话',
      false,
    );
  }
  const format = DeliveryFormatSchema.parse(stringValue(args.format, 'format'));
  const content = stringValue(args.content, 'content');
  if (content.length > 200_000) {
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      '交付文件内容不能超过 200000 个字符',
      false,
    );
  }
  const generated = await generateDeliverable({ format, content });
  let fileName = [...stringValue(args.fileName, 'fileName')]
    .map((character) =>
      '\\/:*?"<>|'.includes(character) || character.charCodeAt(0) < 32
        ? '-'
        : character,
    )
    .join('')
    .slice(0, 120);
  if (!fileName.toLowerCase().endsWith(generated.extension)) {
    fileName = `${fileName}${generated.extension}`;
  }
  const bytes = generated.bytes;
  const object = createToolBrokerExportObject({
    context: input.context,
    mediaType: generated.mediaType,
    sizeBytes: bytes.byteLength,
    checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  });
  const storage = new LocalStorageAdapter(input.storageRoot);
  await storage.put(object, new Blob([Uint8Array.from(bytes)]).stream());
  try {
    const registered = await registerToolBrokerExport({
      context: input.context,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.platformTestRunId
        ? { platformTestRunId: input.platformTestRunId }
        : {}),
      fileName,
      format,
      ...(typeof args.parentObjectId === 'string'
        ? { parentObjectId: args.parentObjectId }
        : {}),
      ...(typeof args.changeSummary === 'string'
        ? { changeSummary: args.changeSummary }
        : {}),
      object,
    });
    return {
      modelContent: JSON.stringify({
        objectId: object.id,
        fileName,
        mediaType: object.mediaType,
        sizeBytes: object.sizeBytes,
        seriesId: registered.seriesId,
        version: registered.version,
        parentObjectId: registered.parentObjectId,
        changeSummary:
          typeof args.changeSummary === 'string' ? args.changeSummary : null,
        downloadUrl: `/api/v1/files/${object.id}/download?name=${encodeURIComponent(fileName)}`,
        versionsUrl: `/api/v1/files/${object.id}/versions?workspaceId=${encodeURIComponent(input.context.workspaceId!)}`,
      }),
      summary: `已生成交付文件 ${fileName} · v${registered.version}`,
      itemCount: 1,
    };
  } catch (error) {
    await storage.delete(object).catch(() => undefined);
    throw error;
  }
};
