import {
  getToolBrokerFile,
  listToolBrokerFiles,
  recordToolBrokerAudit,
  searchToolBrokerMemories,
  searchToolBrokerSessions,
} from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';
import type { ExecutionContext, SkillCapability } from '@allrice/contracts';

import { HandlerError } from './errors.js';

const maximumReadableBytes = 200_000;
const readableMediaTypes = new Set([
  'text/plain',
  'text/markdown',
  'application/json',
]);

export const riceToolDefinitions = [
  {
    name: 'workspace.file.list',
    description: '列出当前用户在当前工作区有权读取的文件。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
  },
  {
    name: 'workspace.file.read',
    description: '按文件 ID 读取当前工作区内有权访问的文本文件。',
    inputSchema: {
      type: 'object',
      properties: { objectId: { type: 'string', format: 'uuid' } },
      required: ['objectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace.memory.search',
    description: '搜索当前用户有权读取的工作区记忆。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace.session.search',
    description: '按标题搜索当前用户有权读取的历史对话。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
] as const;

export interface RiceToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface RiceToolResult {
  modelContent: string;
  summary: string;
  itemCount?: number;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HandlerError('TOOL_INPUT_INVALID', '工具参数格式不正确', false);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HandlerError('TOOL_INPUT_INVALID', `${name} 不能为空`, false);
  }
  return value.trim();
}

function limitValue(value: unknown, fallback: number, maximum: number) {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(Math.max(value, 1), maximum)
    : fallback;
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

export async function executeRiceTool(input: {
  context: ExecutionContext;
  capabilities: SkillCapability[];
  storageRoot: string;
  call: RiceToolCall;
}): Promise<RiceToolResult> {
  if (!input.capabilities.includes('storage:read')) {
    throw new HandlerError(
      'TOOL_CAPABILITY_DENIED',
      'Rice 未被授予工作区读取能力',
      false,
    );
  }
  const args = objectValue(input.call.arguments);
  try {
    let result: RiceToolResult;
    if (input.call.name === 'workspace.file.list') {
      const files = await listToolBrokerFiles(
        input.context,
        limitValue(args.limit, 20, 50),
      );
      result = {
        modelContent: JSON.stringify(files),
        summary: `找到 ${files.length} 个可访问文件`,
        itemCount: files.length,
      };
    } else if (input.call.name === 'workspace.file.read') {
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
      result = {
        modelContent: JSON.stringify({
          id: file.object.id,
          fileName: file.fileName,
          mediaType: file.object.mediaType,
          content,
        }),
        summary: `已读取 ${file.fileName}`,
        itemCount: 1,
      };
    } else if (input.call.name === 'workspace.memory.search') {
      const memories = await searchToolBrokerMemories(
        input.context,
        stringValue(args.query, 'query'),
        limitValue(args.limit, 5, 20),
      );
      result = {
        modelContent: JSON.stringify(memories),
        summary: `找到 ${memories.length} 条相关记忆`,
        itemCount: memories.length,
      };
    } else if (input.call.name === 'workspace.session.search') {
      const sessions = await searchToolBrokerSessions(
        input.context,
        stringValue(args.query, 'query'),
        limitValue(args.limit, 10, 20),
      );
      result = {
        modelContent: JSON.stringify(sessions),
        summary: `找到 ${sessions.length} 个相关对话`,
        itemCount: sessions.length,
      };
    } else {
      throw new HandlerError(
        'TOOL_NOT_ALLOWED',
        `不允许调用工具 ${input.call.name}`,
        false,
      );
    }
    await recordToolBrokerAudit({
      context: input.context,
      toolName: input.call.name,
    });
    return result;
  } catch (error) {
    await recordToolBrokerAudit({
      context: input.context,
      toolName: input.call.name,
      decision: 'denied',
      reason:
        error instanceof HandlerError
          ? error.code.toLowerCase()
          : 'tool_execution_failed',
    }).catch(() => undefined);
    throw error;
  }
}
