import { createHash } from 'node:crypto';

import {
  createToolBrokerExportObject,
  registerToolBrokerExport,
  publishWorkbenchArtifact,
  publishWorkbenchChangesetProposal,
  workbenchEnabled,
} from '@allrice/database';
import {
  ChangesetProposalSchema,
  DeliveryFormatSchema,
} from '@allrice/contracts';
import { LocalStorageAdapter } from '@allrice/storage';

import { generateOfficeExport } from '../../office/export.js';
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
  const hasOffice = args.office !== undefined;
  if (hasOffice === (args.content !== undefined))
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      'content 与 office 必须且只能提供一个',
      false,
    );
  if (
    hasOffice &&
    args.artifactKind !== undefined &&
    args.artifactKind !== 'document'
  )
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      'Office 输入仅用于文档交付',
      false,
    );
  const content = hasOffice ? '' : stringValue(args.content, 'content');
  if (content.length > 200_000) {
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      '交付文件内容不能超过 200000 个字符',
      false,
    );
  }
  const generated = hasOffice
    ? await generateOfficeExport(input, format, args.office)
    : {
        ...(await generateDeliverable({ format, content })),
        sourceFile: undefined,
        warnings: undefined,
        changes: undefined,
      };
  if (generated.bytes.byteLength > 8_000_000)
    throw new HandlerError(
      'TOOL_FILE_TOO_LARGE',
      '交付文件超过 8 MB，请拆分内容',
      false,
    );
  const officeResult = hasOffice
    ? {
        sourceFile: generated.sourceFile,
        changes: generated.changes,
        warnings: generated.warnings,
      }
    : {};
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
  const storage = new LocalStorageAdapter(input.storageRoot);
  const kind = args.artifactKind ?? 'document';
  if (
    kind === 'changeset' &&
    (!workbenchEnabled() || !input.sessionId || format !== 'json')
  )
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      'Changeset 提案需要启用工作台、当前会话和 JSON 格式；不会直接修改文件。',
      false,
    );
  if (workbenchEnabled() && input.sessionId) {
    if (kind !== 'document' && kind !== 'plan' && kind !== 'changeset')
      throw new HandlerError(
        'TOOL_INPUT_INVALID',
        '此工具只创建文档、计划或 Changeset 提案，不能冒充命令回执。',
        false,
      );
    const publication = {
      context: input.context,
      sessionId: input.sessionId,
      callId: input.call.id,
      fileName,
      ...(generated.sourceFile ? { sourceFile: generated.sourceFile } : {}),
      ...(typeof args.parentObjectId === 'string'
        ? { parentObjectId: args.parentObjectId }
        : {}),
      ...(typeof args.changeSummary === 'string'
        ? { changeSummary: args.changeSummary }
        : {}),
    };
    const artifact =
      kind === 'changeset'
        ? await publishWorkbenchChangesetProposal(
            {
              ...publication,
              proposal: ChangesetProposalSchema.parse(JSON.parse(content)),
            },
            storage,
          )
        : await publishWorkbenchArtifact(
            {
              ...publication,
              kind,
              format,
              bytes,
              mediaType: generated.mediaType,
            },
            storage,
          );
    return {
      modelContent: JSON.stringify({
        ...officeResult,
        artifactId: artifact.id,
        // This is the checksum of the persisted, server-normalized object,
        // not a model-computed hash of its input proposal.
        digest: artifact.object.checksum,
        artifactKind: kind,
        ...(kind === 'changeset'
          ? {
              executionStarted: false,
              approvalRequired: true,
              notice:
                '文件修改提案已发布；请在右侧审查并请求应用，再批准精确动作。尚未修改本地文件。',
            }
          : {}),
        objectId: artifact.object.id,
        fileName,
        mediaType: artifact.object.mediaType,
        sizeBytes: artifact.object.sizeBytes,
        seriesId: artifact.version.seriesId,
        version: artifact.version.version,
        parentObjectId: artifact.version.parentObjectId,
        changeSummary: artifact.version.changeSummary,
        downloadUrl: `/api/v1/files/${artifact.object.id}/download?name=${encodeURIComponent(fileName)}`,
        versionsUrl: `/api/v1/files/${artifact.object.id}/versions?workspaceId=${encodeURIComponent(input.context.workspaceId!)}`,
      }),
      summary: `已生成${kind === 'plan' ? '待审查计划' : kind === 'changeset' ? '待审查文件修改提案' : '交付文件'} ${fileName} · v${artifact.version.version}`,
      itemCount: 1,
    };
  }
  const object = createToolBrokerExportObject({
    context: input.context,
    mediaType: generated.mediaType,
    sizeBytes: bytes.byteLength,
    checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  });
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
      ...(generated.sourceFile ? { sourceFile: generated.sourceFile } : {}),
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
        ...officeResult,
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
