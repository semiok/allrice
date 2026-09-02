import {
  createTraceableMemory,
  getToolBrokerFile,
  listToolBrokerFiles,
  searchToolBrokerMemories,
  searchToolBrokerSessions,
} from '@allrice/database';
import type { ExecutionContext, RequestContext } from '@allrice/contracts';
import { LocalStorageAdapter } from '@allrice/storage';

import { parseDocument } from '../../document-reader.js';
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

const maximumReadableBytes = 200_000;
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
          '文件超过 200 KB 的对话读取上限',
          false,
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
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
    modelContent: JSON.stringify(files),
    summary: `找到 ${files.length} 个可访问文件`,
    itemCount: files.length,
  };
};

export const readWorkspaceFile: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  const file = await getToolBrokerFile(
    input.context,
    stringValue(args.objectId, 'objectId'),
  );
  if (!readableMediaTypes.has(file.object.mediaType)) {
    throw new HandlerError(
      'TOOL_FILE_TYPE_UNSUPPORTED',
      '当前只支持读取 txt、md 和 json 文本文件',
      false,
    );
  }
  const content = await streamText(
    await new LocalStorageAdapter(input.storageRoot).get(file.object),
  );
  return {
    modelContent: JSON.stringify({
      id: file.object.id,
      fileName: file.fileName,
      mediaType: file.object.mediaType,
      content,
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
  const maximumCharacters = limitValue(args.maxCharacters, 120_000, 300_000);
  const parsed = await parseDocument({
    bytes: Buffer.concat(chunks),
    mediaType: file.object.mediaType,
    fileName: file.fileName,
    maximumCharacters,
  });
  return {
    modelContent: JSON.stringify({
      id: file.object.id,
      fileName: file.fileName,
      mediaType: file.object.mediaType,
      ...parsed,
    }),
    summary: `已解析 ${file.fileName} · ${parsed.units.length} 个内容单元`,
    itemCount: parsed.units.length,
  };
};

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
