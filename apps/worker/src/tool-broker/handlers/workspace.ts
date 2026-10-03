import { createHash } from 'node:crypto';

import {
  createTraceableMemory,
  getToolBrokerFile,
  listToolBrokerFiles,
  searchToolBrokerMemories,
  searchToolBrokerSessions,
  markCompanyMaterialRead,
} from '@allrice/database';
import {
  WorkspaceDocumentReadArgsSchema,
  type ExecutionContext,
  type RequestContext,
} from '@allrice/contracts';
import { LocalStorageAdapter } from '@allrice/storage';

import { inspectOffice } from '../../office/inspect.js';
import { officeMediaTypes, type OfficeFormat } from '../../office/package.js';
import { parseDocument } from '../../document-reader.js';
import { readPdfLocally } from '../../document-read-local.js';
import { HandlerError } from '../../errors.js';
import {
  hasExplicitRememberIntent,
  hasStableMemorySignal,
} from '../../memory-lifecycle.js';
import {
  limitValue,
  memoryClassValue,
  memoryLifecycleStateValue,
  stringValue,
} from '../input-values.js';
import type { RiceToolHandler } from '../types.js';

const maximumReadableBytes = 2_000_000;
const readableMediaTypes = new Set([
  'text/plain',
  'text/markdown',
  'application/json',
]);

function requestContextFromExecution(
  context: ExecutionContext,
): RequestContext {
  return {
    requestId: context.executionId,
    sessionId: context.runId,
    actor: context.delegatedBy,
    organizationId: context.organizationId,
    workspaceId: context.workspaceId,
    memberships: context.policySnapshot.memberships,
    authenticatedAt: context.startedAt,
  };
}

async function streamText(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumReadableBytes) {
        throw new HandlerError(
          'TOOL_FILE_TOO_LARGE',
          '文件超过 2 MB 的分页读取上限',
          false,
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const content = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(Buffer.concat(chunks));
    if (content.includes('\u0000')) throw new Error('binary content');
    return content;
  } catch {
    throw new HandlerError(
      'TOOL_FILE_TYPE_UNSUPPORTED',
      '文件不是有效的 UTF-8 文本，请使用对应的文档或文件工具。',
      false,
    );
  }
}

export const listWorkspaceFiles: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  const files = await listToolBrokerFiles(
    input.context,
    limitValue(args.limit, 20, 50),
  );
  return {
    modelContent: JSON.stringify(
      files.map((file) => ({
        ...file,
        downloadUrl: `/api/v1/files/${file.id}/download?name=${encodeURIComponent(file.fileName)}`,
      })),
    ),
    summary: `找到 ${files.length} 个可访问文件`,
    itemCount: files.length,
  };
};

export const readWorkspaceFile: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  const offset = args.offset ?? 0,
    limit = args.limit ?? 4_000;
  if (
    typeof offset !== 'number' ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 2_000_000 ||
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 4_000
  ) {
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      '分页 offset/limit 必须是有效整数，limit 最大 4000',
      false,
    );
  }
  const file = await getToolBrokerFile(
    input.context,
    stringValue(args.objectId, 'objectId'),
  );
  // Extracted private attachments may have a generic MIME. Select only the
  // same supported text extensions, then validate the actual bytes below.
  const genericText =
    file.object.mediaType === 'application/octet-stream' &&
    /\.(txt|md|json)$/i.test(file.fileName);
  if (!readableMediaTypes.has(file.object.mediaType) && !genericText) {
    throw new HandlerError(
      'TOOL_FILE_TYPE_UNSUPPORTED',
      '当前只支持读取 txt、md 和 json 文本文件',
      false,
    );
  }
  if (file.object.sizeBytes > maximumReadableBytes)
    throw new HandlerError(
      'TOOL_FILE_TOO_LARGE',
      '文件超过 2 MB 的分页读取上限',
      false,
    );
  const content = await streamText(
    await new LocalStorageAdapter(input.storageRoot).get(file.object),
  );
  if ('companyReference' in file) {
    if (
      `sha256:${createHash('sha256').update(content).digest('hex')}` !==
      file.object.checksum
    )
      throw new HandlerError(
        'TOOL_FILE_CHECKSUM_MISMATCH',
        '范本内容校验失败，请重新选用。',
        false,
      );
    await markCompanyMaterialRead(input.context, file.object.id);
  }
  return {
    modelContent: JSON.stringify({
      id: file.object.id,
      downloadUrl: `/api/v1/files/${file.object.id}/download?name=${encodeURIComponent(file.fileName)}`,
      fileName: file.fileName,
      mediaType: file.object.mediaType,
      content: content.slice(offset, offset + limit),
      offset,
      totalCharacters: content.length,
      truncated: offset > 0 || offset + limit < content.length,
      nextOffset: offset + limit < content.length ? offset + limit : null,
    }),
    summary: `已读取 ${file.fileName}`,
    itemCount: 1,
  };
};

export const readWorkspaceDocument: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  const file = await getToolBrokerFile(
    input.context,
    stringValue(args.objectId, 'objectId'),
  );
  const isPdf =
    file.object.mediaType === 'application/pdf' ||
    file.fileName.toLowerCase().endsWith('.pdf');
  if (
    args.location !== undefined &&
    !['auto', 'local', 'cloud'].includes(String(args.location))
  )
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      'location 必须是 auto、local 或 cloud',
      false,
    );
  if (!isPdf && args.location === 'local')
    throw new HandlerError(
      'TOOL_LOCATION_UNSUPPORTED',
      '本地文档阅读目前仅支持 PDF；Office 和文本继续使用云端读取。',
      false,
    );
  if (args.pages !== undefined && !isPdf) {
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      'pages 仅适用于 PDF 文档',
      false,
    );
  }
  if (
    args.pages !== undefined &&
    (!Array.isArray(args.pages) ||
      args.pages.length === 0 ||
      args.pages.length > 10 ||
      args.pages.some((page) => !Number.isSafeInteger(page) || page < 1))
  ) {
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      'PDF 页码必须是从 1 开始的正整数，每次最多指定 10 页',
      false,
    );
  }
  if (file.object.sizeBytes > 20 * 1024 * 1024) {
    throw new HandlerError(
      'TOOL_FILE_TOO_LARGE',
      '文档超过 20 MB 的安全解析上限',
      false,
    );
  }
  const local = isPdf
    ? await readPdfLocally(
        input,
        file,
        WorkspaceDocumentReadArgsSchema.parse(args),
      )
    : null;
  if (local) {
    if ('companyReference' in file)
      await markCompanyMaterialRead(input.context, file.object.id);
    return workspaceDocumentResult(file, local.document, local.execution);
  }
  const stream = await new LocalStorageAdapter(input.storageRoot).get(
    file.object,
  );
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 20 * 1024 * 1024) {
        throw new HandlerError(
          'TOOL_FILE_TOO_LARGE',
          '文档超过 20 MB 的安全解析上限',
          false,
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  if (
    (isPdf || 'companyReference' in file) &&
    (bytes.length !== file.object.sizeBytes ||
      `sha256:${createHash('sha256').update(bytes).digest('hex')}` !==
        file.object.checksum)
  ) {
    throw new HandlerError(
      'TOOL_SOURCE_CHANGED',
      '源 PDF 与记录的版本或校验值不一致，请重新选择文件',
      false,
    );
  }
  const maximumCharacters = limitValue(args.maxCharacters, 120_000, 300_000);
  const format = !isPdf
    ? (Object.keys(officeMediaTypes) as OfficeFormat[]).find(
        (format) => officeMediaTypes[format] === file.object.mediaType,
      )
    : undefined;
  const parsed =
    args.includeStructure === true && format
      ? await inspectOffice(bytes, format, maximumCharacters)
      : await parseDocument({
          bytes,
          mediaType: file.object.mediaType,
          fileName: file.fileName,
          maximumCharacters,
          pages: args.pages as number[] | undefined,
          includeStructure: args.includeStructure === true,
        });
  if ('companyReference' in file)
    await markCompanyMaterialRead(input.context, file.object.id);
  return workspaceDocumentResult(
    file,
    parsed,
    isPdf ? { location: 'cloud', backend: 'worker' } : undefined,
  );
};

function workspaceDocumentResult(
  file: Awaited<ReturnType<typeof getToolBrokerFile>>,
  parsed: Awaited<ReturnType<typeof parseDocument>>,
  execution?: {
    location: 'local' | 'cloud';
    backend: string;
    operationId?: string;
  },
) {
  const isPdf = parsed.kind === 'pdf';
  const modelContent = JSON.stringify({
    id: file.object.id,
    fileName: file.fileName,
    mediaType: file.object.mediaType,
    checksum: file.object.checksum,
    ...('companyReference' in file
      ? {
          companyTemplate: {
            assetId: file.companyReference.assetId,
            revisionId: file.companyReference.revision.id,
            digest: file.companyReference.revision.digest,
            title: file.companyReference.revision.content.title,
          },
        }
      : {}),
    ...parsed,
    ...(isPdf
      ? {
          source: {
            objectId: file.object.id,
            checksum: file.object.checksum,
            sizeBytes: file.object.sizeBytes,
            ...(file.artifactVersionId
              ? {
                  artifactVersionId: file.artifactVersionId,
                  artifactVersion: file.artifactVersion,
                }
              : {}),
          },
          execution,
        }
      : {}),
  });
  if (isPdf && Buffer.byteLength(modelContent) > 512_000) {
    throw new HandlerError(
      'TOOL_RESULT_TOO_LARGE',
      'PDF 结果超过读取上限，请减少页数或字符数后继续',
      false,
    );
  }
  return {
    modelContent,
    summary:
      isPdf &&
      (parsed.quality === 'no_extractable_text' ||
        !parsed.units.some((unit) => unit.text.trim()))
        ? `${file.fileName} 未提取到文本，请查看文件及提取说明`
        : `已解析 ${file.fileName} · ${parsed.units.length} 个内容单元${parsed.truncated ? ' · 结果已截断' : ''}`,
    itemCount: parsed.units.length,
  };
}

export const searchWorkspaceMemory: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  const memories = await searchToolBrokerMemories(
    input.context,
    stringValue(args.query, 'query'),
    limitValue(args.limit, 5, 20),
  );
  return {
    modelContent: JSON.stringify(memories),
    summary: `找到 ${memories.length} 条相关记忆`,
    itemCount: memories.length,
  };
};

export const rememberWorkspaceMemory: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  const lifecycleState = memoryLifecycleStateValue(args.lifecycleState);
  if (
    lifecycleState === 'durable' &&
    !hasExplicitRememberIntent(input.userRequest)
  ) {
    throw new HandlerError(
      'MEMORY_EXPLICIT_CONFIRMATION_REQUIRED',
      '只有用户在当前消息中明确要求记住时，才能写入长期记忆',
      false,
    );
  }
  if (
    lifecycleState === 'candidate' &&
    !hasStableMemorySignal(input.userRequest)
  ) {
    throw new HandlerError(
      'MEMORY_STABLE_USER_STATEMENT_REQUIRED',
      '候选记忆必须来自用户当前消息中的稳定偏好、决定或项目事实',
      false,
    );
  }
  if (!input.context.workspaceId || !input.employeeId || !input.userMessageId) {
    throw new HandlerError(
      'MEMORY_SOURCE_MESSAGE_REQUIRED',
      '长期记忆缺少当前员工或用户消息来源',
      false,
    );
  }
  const content = stringValue(args.content, 'content');
  if (content.length > 10_000) {
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      'content 不能超过 10000 个字符',
      false,
    );
  }
  const expiresAt =
    args.expiresAt === undefined || args.expiresAt === null
      ? null
      : stringValue(args.expiresAt, 'expiresAt');
  const memory = await (input.memoryCreate ?? createTraceableMemory)(
    requestContextFromExecution(input.context),
    {
      workspaceId: input.context.workspaceId,
      employeeId: input.employeeId,
      content,
      visibility: 'private',
      sourceType: 'message',
      sourceId: input.userMessageId,
      sourceLabel:
        lifecycleState === 'durable' ? '用户明确要求记住' : '用户稳定陈述候选',
      confidence: lifecycleState === 'durable' ? 1 : 0.8,
      expiresAt,
      lifecycleState,
      memoryClass: memoryClassValue(args.memoryClass),
    },
  );
  return {
    modelContent: JSON.stringify({
      id: memory.id,
      content: memory.content,
      memoryClass: memory.memoryClass,
      lifecycleState: memory.lifecycleState,
      provenance: {
        sourceType: memory.sourceType,
        sourceId: memory.sourceId,
        sourceLabel: memory.sourceLabel,
        trust: memory.trust,
        confidence: memory.confidence,
        capturedAt: memory.capturedAt,
      },
    }),
    summary:
      lifecycleState === 'durable'
        ? '已保存为长期记忆'
        : '已保存为待确认候选记忆',
    itemCount: 1,
  };
};

export const searchWorkspaceSessions: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  const sessions = await searchToolBrokerSessions(
    input.context,
    stringValue(args.query, 'query'),
    limitValue(args.limit, 10, 20),
  );
  return {
    modelContent: JSON.stringify(sessions),
    summary: `找到 ${sessions.length} 个相关对话`,
    itemCount: sessions.length,
  };
};
