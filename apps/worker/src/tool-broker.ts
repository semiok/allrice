import {
  getToolBrokerFile,
  listToolBrokerFiles,
  createAutomationFromExecutionContext,
  recordToolBrokerAudit,
  searchToolBrokerMemories,
  searchToolBrokerSessions,
} from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';
import type { ExecutionContext, SkillCapability } from '@allrice/contracts';

import { HandlerError } from './errors.js';
import { searchCodexHostedWeb } from './codex-search-broker.js';
import { fetchPublicWebPage } from './web-fetch.js';

const maximumReadableBytes = 200_000;
const readableMediaTypes = new Set([
  'text/plain',
  'text/markdown',
  'application/json',
]);

export type RiceToolRisk = 'read_only' | 'side_effect' | 'secret_bearing';

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
  {
    name: 'web.search',
    description:
      '使用平台已授权的 Codex Hosted Search 检索互联网。返回最新搜索摘要和来源，不需要第三方搜索 API Key。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 2000 },
        maxResults: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'web.fetch',
    description:
      '读取公开 HTTP/HTTPS 网页的正文。会阻止内网地址、重新校验重定向，并将结果标记为不可信外部内容。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', format: 'uri' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'automation.create',
    description:
      '当用户明确要求提醒或未来执行某项任务时，创建当前工作区的一次性自动化，并绑定到当前对话。不要在用户没有明确提出未来执行要求时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 160 },
        prompt: { type: 'string', minLength: 1, maxLength: 40000 },
        delayMinutes: { type: 'integer', minimum: 1, maximum: 525600 },
      },
      required: ['name', 'prompt', 'delayMinutes'],
      additionalProperties: false,
    },
  },
] as const;

const toolCapabilities: Readonly<Record<string, SkillCapability>> = {
  'workspace.file.list': 'storage:read',
  'workspace.file.read': 'storage:read',
  'workspace.memory.search': 'storage:read',
  'workspace.session.search': 'storage:read',
  'web.search': 'network:outbound',
  'web.fetch': 'network:outbound',
  'automation.create': 'automation:write',
};

const toolRisks: Readonly<Record<string, RiceToolRisk>> = {
  'workspace.file.list': 'read_only',
  'workspace.file.read': 'read_only',
  'workspace.memory.search': 'read_only',
  'workspace.session.search': 'read_only',
  'web.search': 'read_only',
  'web.fetch': 'read_only',
  'automation.create': 'side_effect',
};

export function riceToolCapability(name: string) {
  return toolCapabilities[name] ?? null;
}

export function riceToolRisk(name: string) {
  return toolRisks[name] ?? null;
}

export function riceToolDefinitionsForCapabilities(
  capabilities: SkillCapability[],
  allowedToolNames?: readonly string[],
) {
  const allowed = allowedToolNames ? new Set(allowedToolNames) : null;
  return riceToolDefinitions.filter(
    (definition) =>
      (!allowed || allowed.has(definition.name)) &&
      capabilities.includes(toolCapabilities[definition.name]!),
  );
}

/**
 * Stable DSH turn capability set. Tenant-authorized read-only tools are always
 * visible to the native Agent Loop; side-effect and secret-bearing tools only
 * become visible after an explicit Skill/Workflow/Tool route selected them.
 */
export function riceToolDefinitionsForTurn(
  capabilities: SkillCapability[],
  allowedToolNames: readonly string[] | undefined,
  selectedToolNames: readonly string[],
) {
  const selected = new Set(selectedToolNames);
  return riceToolDefinitionsForCapabilities(
    capabilities,
    allowedToolNames,
  ).filter(
    (definition) =>
      riceToolRisk(definition.name) === 'read_only' ||
      selected.has(definition.name),
  );
}

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
  skillVersionIds?: string[];
  sessionId?: string;
  call: RiceToolCall;
  codexSearch?: typeof searchCodexHostedWeb;
}): Promise<RiceToolResult> {
  const requiredCapability = toolCapabilities[input.call.name];
  if (!requiredCapability) {
    throw new HandlerError(
      'TOOL_NOT_ALLOWED',
      `不允许调用工具 ${input.call.name}`,
      false,
    );
  }
  if (!input.capabilities.includes(requiredCapability)) {
    throw new HandlerError(
      'TOOL_CAPABILITY_DENIED',
      `Rice 未被授予 ${requiredCapability} 能力`,
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
    } else if (input.call.name === 'web.search') {
      const query = stringValue(args.query, 'query');
      if (query.length > 2_000) {
        throw new HandlerError(
          'TOOL_INPUT_INVALID',
          'query 不能超过 2000 个字符',
          false,
        );
      }
      const search = await (input.codexSearch ?? searchCodexHostedWeb)(
        query,
        limitValue(args.maxResults, 5, 10),
      );
      result = {
        modelContent: JSON.stringify({
          provider: search.provider,
          query: search.query,
          retrievedAt: new Date().toISOString(),
          output: search.output,
          sources: search.results,
        }),
        summary: `已通过 Codex 检索“${query}”`,
        itemCount: search.results.length,
      };
    } else if (input.call.name === 'web.fetch') {
      const page = await fetchPublicWebPage(stringValue(args.url, 'url'));
      result = {
        modelContent: JSON.stringify(page),
        summary: `已读取 ${new URL(page.url).hostname}`,
        itemCount: 1,
      };
    } else if (input.call.name === 'automation.create') {
      const delayMinutes = args.delayMinutes;
      if (
        typeof delayMinutes !== 'number' ||
        !Number.isInteger(delayMinutes) ||
        delayMinutes < 1 ||
        delayMinutes > 525600
      ) {
        throw new HandlerError(
          'TOOL_INPUT_INVALID',
          'delayMinutes 必须是 1 到 525600 之间的整数',
          false,
        );
      }
      const automation = await createAutomationFromExecutionContext({
        context: input.context,
        sessionId: input.sessionId,
        name: stringValue(args.name, 'name'),
        prompt: stringValue(args.prompt, 'prompt'),
        delayMinutes,
      });
      result = {
        modelContent: JSON.stringify({
          automationId: automation.id,
          name: automation.name,
          runAt: automation.nextRunAt,
          sessionId: automation.lastSessionId,
        }),
        summary: `已创建一次性自动化，将于 ${automation.nextRunAt ?? '指定时间'} 执行`,
        itemCount: 1,
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
      metadata: {
        skillVersionIds: input.skillVersionIds ?? [],
        requiredCapability,
      },
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
      metadata: {
        skillVersionIds: input.skillVersionIds ?? [],
        requiredCapability,
      },
    }).catch(() => undefined);
    throw error;
  }
}
