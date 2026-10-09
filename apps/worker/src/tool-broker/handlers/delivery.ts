import { createHash } from 'node:crypto';

import {
  createToolBrokerExportObject,
  registerToolBrokerExport,
  publishWorkbenchArtifact,
  publishWorkbenchChangesetProposal,
  workbenchEnabled,
  ArtifactPublicationRollbackError,
  ArtifactPublicationParentError,
} from '@allrice/database';
import {
  ChangesetProposalSchema,
  DeliveryFormatSchema,
  NativeOfficeExportSchema,
} from '@allrice/contracts';
import { LocalStorageAdapter } from '@allrice/storage';
import { officeFormat } from '@allrice/office-runtime';

import { generateOfficeExport } from '../../office/export.js';
import { generateNativeOfficeExport } from '../../office/native.js';
import { generateOfficePdfExport } from '../../office/pdf.js';
import { checkOfficeExport } from '../../office/quality.js';
import { generateDeliverable } from '../../deliverable-generator.js';
import { confirmToolFailure, HandlerError } from '../../errors.js';
import { stringValue } from '../input-values.js';
import type { RiceToolHandler } from '../types.js';

function requiresOfficeQuality(request: string | undefined, format: string) {
  return (request ?? '')
    .slice(0, 12000)
    .split(/[。！？\n；;，,]/)
    .some((clause) => {
      if (/无需|不需要|不用|不要|不必|no need|do not|don['’]t/i.test(clause))
        return false;
      if (!/必须|务必|强制|一定要|\bmust\b|\brequired?\b/i.test(clause))
        return false;
      return (
        /渲染|页面预览|排版预览|\brender(?:ing)?\b|\bpreview\b/i.test(clause) ||
        (format === 'xlsx' &&
          /重算|重新计算|公式计算|recalculat(?:e|ion)/i.test(clause))
      );
    });
}

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
  const hasPython = args.python !== undefined;
  const hasOfficePdf = args.officePdf !== undefined;
  if (args.location !== undefined && !hasPython && !hasOfficePdf)
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      '执行位置仅适用于 python 原生 Office 或原文件转 PDF 工作流。',
      false,
    );
  if (
    [hasOffice, hasPython, hasOfficePdf, args.content !== undefined].filter(
      Boolean,
    ).length !== 1
  )
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      'content、python、officePdf 与旧版 office 必须且只能提供一个',
      false,
    );
  if (
    (hasOffice || hasPython || hasOfficePdf) &&
    args.artifactKind !== undefined &&
    args.artifactKind !== 'document'
  )
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      'Office 输入仅用于文档交付',
      false,
    );
  const content =
    hasOffice || hasPython || hasOfficePdf
      ? ''
      : stringValue(args.content, 'content');
  if (hasOfficePdf && format !== 'pdf')
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      'officePdf 原文件转换只能交付 PDF 格式。',
      false,
    );
  if (
    hasOfficePdf &&
    (!input.sessionId || !input.call.id || !workbenchEnabled())
  )
    throw new HandlerError(
      'OFFICE_PDF_PUBLICATION_UNAVAILABLE',
      '原文件转 PDF 需要当前对话的正式成果发布通道，未读取或转换原文件。',
      false,
    );
  const python = hasPython
    ? NativeOfficeExportSchema.parse(args.python)
    : undefined;
  if (
    typeof args.changeSummary === 'string' &&
    python?.changeSummary != null &&
    args.changeSummary !== python.changeSummary
  )
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      '外层 changeSummary 与 python.changeSummary 不一致，请只保留一个修改说明。',
      false,
    );
  const changeSummary =
    typeof args.changeSummary === 'string'
      ? args.changeSummary
      : python?.changeSummary;
  if (content.length > 200_000) {
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      '交付文件内容不能超过 200000 个字符',
      false,
    );
  }
  input.signal?.throwIfAborted();
  const generated = hasOfficePdf
    ? await generateOfficePdfExport(
        input,
        args.officePdf,
        args.location as 'auto' | 'local' | 'cloud' | undefined,
      )
    : hasPython
      ? await generateNativeOfficeExport(
          input,
          format,
          python,
          args.location as 'auto' | 'local' | 'cloud' | undefined,
        ).catch((error: unknown) => {
          // The native sandbox has stopped and rejected the document. No managed
          // file publication has started. DSH may correct the script in a new call.
          // Transport/cleanup errors remain unknown; never infer from retryability.
          if (
            error instanceof HandlerError &&
            ['OFFICE_DOCUMENT_INVALID', 'OFFICE_RUNTIME_UNAVAILABLE'].includes(
              error.code,
            )
          )
            confirmToolFailure(error, {
              runId: input.context.runId,
              callId: input.call.id,
              toolName: input.call.name,
            });
          throw error;
        })
      : hasOffice
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
  const officeType = officeFormat(generated.mediaType);
  const localQualityOnly =
    'cloudQualityAllowed' in generated &&
    generated.cloudQualityAllowed === false;
  const checked = officeType
    ? localQualityOnly
      ? {
          bytes: generated.bytes,
          quality: {
            status: 'unavailable' as const,
            reason:
              '本地生成已验证；本地公式重算与页面预览尚未就绪，按任务的数据限制未外发到云端。',
          },
          warnings: [
            '公式未重算、页面未渲染；生成通过不代表公式计算或排版已经检查。',
          ],
        }
      : await checkOfficeExport(generated.bytes, officeType)
    : undefined;
  if (
    hasPython &&
    checked?.quality.status === 'unavailable' &&
    requiresOfficeQuality(input.userRequest, format)
  ) {
    const error = new HandlerError(
      'OFFICE_QUALITY_UNAVAILABLE',
      '生成已经停止并通过文件校验，但任务明确要求的公式重算或页面渲染尚不可用；未发布正式成果。',
      false,
    );
    confirmToolFailure(error, {
      runId: input.context.runId,
      callId: input.call.id,
      toolName: input.call.name,
    });
    throw error;
  }
  if (checked && checked.bytes.length > 8_000_000)
    throw new HandlerError(
      'TOOL_FILE_TOO_LARGE',
      '交付文件超过 8 MB，请拆分内容',
      false,
    );
  const officeResult = officeType
    ? {
        sourceFile: generated.sourceFile,
        changes: generated.changes,
        quality: checked?.quality,
        ...('nativeExecution' in generated
          ? { nativeExecution: generated.nativeExecution }
          : {}),
        warnings: [
          ...(checked?.quality.status === 'checked'
            ? []
            : (generated.warnings ?? [])),
          ...(checked?.warnings ?? []),
        ],
      }
    : 'nativeConversion' in generated
      ? {
          sourceFile: generated.sourceFile,
          warnings: generated.warnings,
          nativeConversion: generated.nativeConversion,
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
  const bytes = checked?.bytes ?? generated.bytes;
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
      ...(checked
        ? {
            officeReceipt: {
              quality: checked.quality,
              warnings: checked.warnings,
            },
          }
        : {}),
      ...(typeof args.parentObjectId === 'string'
        ? { parentObjectId: args.parentObjectId }
        : {}),
      ...(typeof changeSummary === 'string' ? { changeSummary } : {}),
      ...(hasOfficePdf
        ? {
            trustedOfficePdfLease: {
              jobAttempt: input.managedBrowserJobAttempt!,
              jobLeaseToken: input.managedBrowserJobLeaseToken!,
            },
          }
        : {}),
    };
    const artifact = await (async () => {
      input.signal?.throwIfAborted();
      try {
        return kind === 'changeset'
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
      } catch (error) {
        if (
          error instanceof ArtifactPublicationParentError &&
          error.runId === input.context.runId &&
          error.callId === input.call.id
        ) {
          const failure = new HandlerError(
            'TOOL_PUBLICATION_PARENT_INVALID',
            error.code === 'artifact_not_found'
              ? '未找到当前会话中可访问的上一版文件，本次未发布；请读取真实文件对象 ID 后再续版。'
              : '上一版已更新或格式/成果类型不兼容，本次未发布；请读取最新版本，同格式续版或明确交付新的系列。',
            false,
          );
          confirmToolFailure(failure, {
            runId: input.context.runId,
            callId: input.call.id,
            toolName: input.call.name,
          });
          throw failure;
        }
        if (
          error instanceof ArtifactPublicationRollbackError &&
          error.runId === input.context.runId &&
          error.callId === input.call.id
        ) {
          const failure = new HandlerError(
            'TOOL_PUBLICATION_ROLLED_BACK',
            '文件登记发生临时冲突，本次已回滚且未发布文件；请重试相同文件。',
            true,
          );
          confirmToolFailure(failure, {
            runId: input.context.runId,
            callId: input.call.id,
            toolName: input.call.name,
          });
          throw failure;
        }
        throw error;
      }
    })();
    return {
      modelContent: JSON.stringify({
        ...officeResult,
        artifactId: artifact.id,
        // This is the checksum of the persisted, server-normalized object,
        // not a model-computed hash of its input proposal.
        digest: artifact.object.checksum,
        artifactKind: artifact.kind,
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
  if (hasOfficePdf)
    throw new HandlerError(
      'OFFICE_PDF_PUBLICATION_UNAVAILABLE',
      '当前对话的正式成果发布通道已不可用，转换结果未发布。',
      false,
    );
  const object = createToolBrokerExportObject({
    context: input.context,
    mediaType: generated.mediaType,
    sizeBytes: bytes.byteLength,
    checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  });
  input.signal?.throwIfAborted();
  await storage.put(object, new Blob([Uint8Array.from(bytes)]).stream());
  try {
    input.signal?.throwIfAborted();
    const registered = await registerToolBrokerExport({
      context: input.context,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.platformTestRunId
        ? { platformTestRunId: input.platformTestRunId }
        : {}),
      fileName,
      format,
      ...(generated.sourceFile ? { sourceFile: generated.sourceFile } : {}),
      ...(checked
        ? {
            officeReceipt: {
              quality: checked.quality,
              warnings: checked.warnings,
            },
          }
        : {}),
      ...(typeof args.parentObjectId === 'string'
        ? { parentObjectId: args.parentObjectId }
        : {}),
      ...(typeof changeSummary === 'string' ? { changeSummary } : {}),
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
        changeSummary: typeof changeSummary === 'string' ? changeSummary : null,
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
