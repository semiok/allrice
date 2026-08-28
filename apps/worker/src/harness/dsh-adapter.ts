import { createHash, randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import {
  HarnessEventSchema,
  type DshExecutionSnapshot,
  type HarnessEvent,
} from '@allrice/contracts';

import { HandlerError } from '../errors.js';
import type {
  HarnessAdapter,
  HarnessExecutionInput,
  HarnessExecutionResult,
  HarnessRuntimeProcessSnapshot,
  HarnessToolCall,
} from './adapter.js';
import {
  DeploymentDshCredentialResolver,
  type DshCredentialResolver,
} from './dsh-credential-resolver.js';
import { DSH_DISTRIBUTION_CURRENT_VERSION } from './dsh-distribution.js';
import {
  DshProtocolClient,
  type DshNotification,
} from './dsh-protocol-client.js';

const toolEnvelopePrefix = '<allrice_tool_call>';
const toolEnvelopePattern =
  /<allrice_tool_call>\s*([\s\S]*?)\s*<\/allrice_tool_call>/;
const maximumToolCallsPerTurn = 8;
const dshNativeToolNames = new Set([
  'web.search',
  'local.fs.list',
  'local.fs.search',
  'local.fs.read',
  'local.git.status',
  'local.git.diff',
]);
const dshBrokerNativeToolNames = new Set([
  'local.fs.list',
  'local.fs.search',
  'local.fs.read',
  'local.git.status',
  'local.git.diff',
]);
const dshNativeWireNames: Readonly<Record<string, string>> = {
  web_search: 'web.search',
  local_fs_list: 'local.fs.list',
  local_fs_search: 'local.fs.search',
  local_fs_read: 'local.fs.read',
  local_git_status: 'local.git.status',
  local_git_diff: 'local.git.diff',
};

function isDshNativeTool(name: string) {
  return dshNativeToolNames.has(name);
}

interface DshRuntime {
  client: DshProtocolClient;
  id: string;
  fingerprint: string;
  sessionId: string;
  organizationId: string;
  workspaceId: string;
  productSessionId: string;
  ownerId: string;
  providerRoute: string;
  model: string;
  reasoningEffort: string;
  nativeTools: string[];
  startedAt: string;
  lastActivityAt: string;
}

interface DshAdapterOptions {
  credentialResolver?: DshCredentialResolver;
  runtimeCommand?: string;
  runtimeArgs?: readonly string[];
  runtimeRoot?: string;
  cordisConfig?: string;
  requestTimeoutMs?: number;
}

type HarnessEventPayload = HarnessEvent extends infer Event
  ? Event extends HarnessEvent
    ? Omit<
        Event,
        | 'schemaVersion'
        | 'harness'
        | 'generation'
        | 'attempt'
        | 'order'
        | 'threadId'
        | 'turnId'
        | 'sessionId'
        | 'messageId'
      >
    : never
  : never;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface DshSourceMetadata {
  sourceEventId: string;
  sourceEventType: string;
  sourceOccurredAt: string;
  sourcePayload: Record<string, unknown>;
}

function sourceMetadata(event: Record<string, unknown>): DshSourceMetadata {
  const sequence =
    typeof event.seq === 'number' || typeof event.seq === 'string'
      ? String(event.seq)
      : randomUUID();
  const occurredAt =
    typeof event.time === 'string' && !Number.isNaN(Date.parse(event.time))
      ? new Date(event.time).toISOString()
      : typeof event.time === 'number' && Number.isFinite(event.time)
        ? new Date(event.time).toISOString()
        : new Date().toISOString();
  return {
    sourceEventId: `dsh:${sequence}`,
    sourceEventType:
      typeof event.type === 'string' ? event.type : 'dsh/session-event',
    sourceOccurredAt: occurredAt,
    sourcePayload: safeDshSourcePayload(event),
  };
}

function shortText(value: unknown, maximum = 240) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maximum)
    : undefined;
}

/**
 * DSH's event log is intentionally lossless, but ChatFlow is a tenant-facing
 * audit stream. Keep ordering and presentation facts while excluding prompts,
 * credentials, raw tool arguments/results and hidden reasoning text.
 */
function safeDshSourcePayload(event: Record<string, unknown>) {
  const type = typeof event.type === 'string' ? event.type : '';
  const data = record(event.data) ?? {};
  const turn =
    typeof data.turn === 'number' || typeof data.turn === 'string'
      ? data.turn
      : undefined;
  const step =
    typeof data.step === 'number' || typeof data.step === 'string'
      ? data.step
      : undefined;
  const common = {
    ...(turn === undefined ? {} : { turn }),
    ...(step === undefined ? {} : { step }),
  };
  if (type === 'assistant/chunk') {
    const chunk = record(data.chunk) ?? {};
    return {
      ...common,
      chunk: {
        type: shortText(chunk.type),
        ...(typeof chunk.index === 'number' ? { index: chunk.index } : {}),
      },
    };
  }
  if (type === 'assistant/message') {
    const message = record(data.message) ?? {};
    const content = Array.isArray(message.content) ? message.content : [];
    return {
      ...common,
      interrupted: data.interrupted === true,
      contentTypes: content
        .map((block) => shortText(record(block)?.type, 80))
        .filter(Boolean),
    };
  }
  if (type === 'request/context') {
    return {
      provider: shortText(data.provider, 120),
      model: shortText(data.model, 160),
      ...(typeof data.contextWindow === 'number'
        ? { contextWindow: data.contextWindow }
        : {}),
    };
  }
  if (type === 'request/header') {
    return { reason: shortText(data.reason, 80) };
  }
  if (type === 'tool/call') {
    return {
      ...common,
      callId: shortText(data.callId, 160),
      name: shortText(data.name, 160),
    };
  }
  if (type === 'tool/result') {
    const message = record(data.message) ?? {};
    const resultBlock = Array.isArray(message.content)
      ? record(message.content[0])
      : null;
    const error = record(data.error);
    return {
      ...common,
      callId: shortText(
        resultBlock?.toolCallId ?? message.toolCallId ?? message.callId,
        160,
      ),
      ...(error
        ? {
            error: {
              name: shortText(error.name, 120),
              code: shortText(error.code, 120),
            },
          }
        : {}),
    };
  }
  if (type === 'user/message') {
    const source = record(data.source);
    return {
      ...common,
      source: source
        ? {
            kind: shortText(source.kind, 80),
            plugin: shortText(source.plugin, 120),
            label: shortText(source.label ?? source.name, 160),
          }
        : undefined,
    };
  }
  if (type === 'todo/write') {
    return {
      count: Array.isArray(data.todos) ? data.todos.length : 0,
      completed: Array.isArray(data.todos)
        ? data.todos.filter((todo) => record(todo)?.status === 'completed')
            .length
        : 0,
    };
  }
  if (type.startsWith('compaction/')) {
    return {
      compactionId: shortText(data.compactionId, 160),
      failed: Boolean(data.error),
    };
  }
  return common;
}

function nativeEventView(event: Record<string, unknown>) {
  const type = typeof event.type === 'string' ? event.type : '';
  const data = record(event.data) ?? {};
  const source = sourceMetadata(event);
  if (type === 'request/context') {
    const provider = shortText(data.provider, 120);
    const model = shortText(data.model, 160);
    return {
      type: 'native.event' as const,
      presentation: 'context' as const,
      status: 'info' as const,
      label: '模型上下文',
      ...(provider || model
        ? { summary: [provider, model].filter(Boolean).join(' · ') }
        : {}),
      ...source,
    };
  }
  if (type === 'request/header') {
    return {
      type: 'native.event' as const,
      presentation: 'context' as const,
      status: 'completed' as const,
      label: '上下文已注入',
      ...source,
    };
  }
  if (type === 'user/message') {
    const messageSource = record(data.source);
    if (!messageSource || messageSource.kind === 'human') return null;
    const label = shortText(
      messageSource.label ?? messageSource.name ?? messageSource.plugin,
      160,
    );
    return {
      type: 'native.event' as const,
      presentation: 'context' as const,
      status: 'completed' as const,
      label: '上下文注入',
      ...(label ? { summary: label } : {}),
      ...source,
    };
  }
  if (type === 'todo/write') {
    const count = Array.isArray(data.todos) ? data.todos.length : 0;
    return {
      type: 'native.event' as const,
      presentation: 'todo' as const,
      status: 'updated' as const,
      label: '任务计划已更新',
      ...(count ? { summary: `${count} 项` } : {}),
      ...source,
    };
  }
  if (type.startsWith('compaction/')) {
    const phase = type.slice('compaction/'.length);
    return {
      type: 'native.event' as const,
      presentation: 'compaction' as const,
      status:
        phase === 'start'
          ? ('started' as const)
          : data.error
            ? ('failed' as const)
            : phase === 'end'
              ? ('completed' as const)
              : ('updated' as const),
      label:
        phase === 'start'
          ? '正在整理会话上下文'
          : phase === 'end'
            ? '会话上下文已整理'
            : '上下文摘要已生成',
      ...source,
    };
  }
  return null;
}

function textBlocks(value: unknown) {
  if (!Array.isArray(value)) return '';
  return value
    .map((block) => {
      const item = record(block);
      return item?.type === 'text' && typeof item.text === 'string'
        ? item.text
        : '';
    })
    .join('');
}

function positiveInteger(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

function parseRuntimeArgs(value: string | undefined) {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new HandlerError(
      'DSH_RUNTIME_CONFIG_INVALID',
      'ALLRICE_DSH_RUNTIME_ARGS must be a JSON string array',
      false,
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === 'string')
  ) {
    throw new HandlerError(
      'DSH_RUNTIME_CONFIG_INVALID',
      'ALLRICE_DSH_RUNTIME_ARGS must be a JSON string array',
      false,
    );
  }
  return parsed;
}

function requestTimeout(value: number | undefined) {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1_000 &&
    value <= 3_600_000
    ? value
    : 300_000;
}

function mappedReasoning(
  effort: DshExecutionSnapshot['reasoningEffort'],
): string {
  if (effort === 'none') return 'off';
  if (effort === 'medium') return 'high';
  if (effort === 'xhigh') return 'max';
  return effort;
}

function toolBridgeInstructions(input: HarnessExecutionInput) {
  const nativeTools = input.tools.filter((tool) => isDshNativeTool(tool.name));
  const bridgedTools = input.tools.filter(
    (tool) => !isDshNativeTool(tool.name),
  );
  if (bridgedTools.length === 0) {
    if (input.tools.some((tool) => isDshNativeTool(tool.name))) {
      return 'Use the native DSH tools supplied for this turn. Do not emit AllRice XML tool envelopes. Never claim a tool result unless the native call succeeds.';
    }
    return 'No external tools are available. Never claim that a tool was called.';
  }
  const definitions = bridgedTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  return [
    'All host capabilities are disabled. Use only the tenant-scoped tools supplied by AllRice for this turn.',
    ...(nativeTools.length
      ? [
          `DSH native tools available for this turn: ${nativeTools
            .map((tool) => tool.name)
            .join(
              ', ',
            )}. Call these through their native DSH function definitions; do not use an AllRice XML envelope for them.`,
        ]
      : []),
    'The following additional non-native AllRice tools are available through the Tool Broker envelope:',
    JSON.stringify(definitions),
    'To call exactly one tool, return only <allrice_tool_call>{"id":"unique-id","name":"tool.name","arguments":{}}</allrice_tool_call>.',
    'Do not wrap that envelope in Markdown. Wait for an <allrice_tool_result> response before continuing.',
  ].join('\n');
}

function parseToolCall(text: string): HarnessToolCall | null {
  const candidate = text.trim();
  const match = toolEnvelopePattern.exec(candidate);
  if (!match?.[1]) return null;
  const prefix = candidate.slice(0, match.index);
  const suffix = candidate.slice(match.index + match[0].length);
  if (
    prefix.includes(toolEnvelopePrefix) ||
    suffix.includes(toolEnvelopePrefix)
  ) {
    throw new HandlerError(
      'DSH_TOOL_ENVELOPE_INVALID',
      'DSH returned more than one AllRice tool envelope',
      false,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(match[1]);
  } catch {
    throw new HandlerError(
      'DSH_TOOL_ENVELOPE_INVALID',
      'DSH returned an invalid AllRice tool envelope',
      false,
    );
  }
  const input = record(value);
  const args = record(input?.arguments);
  if (
    typeof input?.id !== 'string' ||
    !input.id ||
    typeof input.name !== 'string' ||
    !input.name ||
    !args
  ) {
    throw new HandlerError(
      'DSH_TOOL_ENVELOPE_INVALID',
      'DSH returned an invalid AllRice tool envelope',
      false,
    );
  }
  return { id: input.id, name: input.name, arguments: args };
}

function visibleModelText(text: string) {
  const candidate = text.trimStart();
  if ('<think>'.startsWith(candidate)) {
    return { ready: false, text: '' };
  }
  if (!candidate.startsWith('<think>')) {
    return { ready: true, text };
  }
  const closingTag = candidate.indexOf('</think>');
  if (closingTag === -1) {
    return { ready: false, text: '' };
  }
  return {
    ready: true,
    text: candidate.slice(closingTag + '</think>'.length).trimStart(),
  };
}

export class DshHarnessAdapter implements HarnessAdapter {
  readonly kind = 'dsh' as const;
  readonly contextStrategy = 'harness-native' as const;
  readonly capabilities = {
    persistentThreads: true,
    assistantDeltas: true,
    toolEvents: true,
    usageEvents: true,
    interrupt: true,
    steer: true,
    compact: true,
    recover: true,
  } as const;

  private readonly runtimes = new Map<string, DshRuntime>();
  private readonly credentialResolver: DshCredentialResolver;
  private readonly runtimeCommand: string | undefined;
  private readonly runtimeArgs: readonly string[];
  private readonly runtimeRoot: string;
  private readonly cordisConfig: string;
  private readonly requestTimeoutMs: number;

  constructor(options: DshAdapterOptions = {}) {
    this.credentialResolver =
      options.credentialResolver ?? new DeploymentDshCredentialResolver();
    const configuredRuntimeCommand =
      options.runtimeCommand ?? process.env.ALLRICE_DSH_RUNTIME_COMMAND;
    this.runtimeCommand = configuredRuntimeCommand ?? process.execPath;
    this.runtimeArgs =
      options.runtimeArgs ??
      (process.env.ALLRICE_DSH_RUNTIME_ARGS
        ? parseRuntimeArgs(process.env.ALLRICE_DSH_RUNTIME_ARGS)
        : configuredRuntimeCommand
          ? []
          : [
              resolve(
                import.meta.dirname,
                '../../dsh/allrice-jsonrpc-runtime.mjs',
              ),
            ]);
    this.runtimeRoot = resolve(
      options.runtimeRoot ??
        process.env.ALLRICE_DSH_RUNTIME_ROOT ??
        '.local/dsh-runtime',
    );
    this.cordisConfig = resolve(
      options.cordisConfig ??
        process.env.ALLRICE_DSH_CORDIS_CONFIG ??
        resolve(import.meta.dirname, '../../dsh/allrice-restricted.cordis.yml'),
    );
    this.requestTimeoutMs = requestTimeout(
      options.requestTimeoutMs ??
        Number(process.env.ALLRICE_DSH_REQUEST_TIMEOUT_MS ?? 300_000),
    );
  }

  isConfigured(snapshot: HarnessExecutionInput['providerSnapshot']) {
    return snapshot.provider === 'dsh' && Boolean(this.runtimeCommand);
  }

  async execute(input: HarnessExecutionInput): Promise<HarnessExecutionResult> {
    if (input.providerSnapshot.provider !== 'dsh') {
      throw new TypeError('DSH harness requires a DSH provider snapshot');
    }
    const snapshot = input.providerSnapshot;
    const expectedThreadId = `dsh-${input.kernel.sessionId}`;
    const threadId = input.threadId?.startsWith('dsh-')
      ? input.threadId
      : expectedThreadId;
    const existing = this.runtimes.get(threadId);
    const grantedToolNames = new Set(input.tools.map((tool) => tool.name));
    const nativeSkills = (input.nativeSkills ?? []).filter((skill) =>
      skill.requiredToolRefs.every((tool) => grantedToolNames.has(tool)),
    );
    const systemInstructions = input.kernel.systemInstructions;
    let generation = input.generation;
    if (!input.threadId || input.threadId !== threadId) {
      const bound = await input.onThreadBound?.({
        threadId,
        resumed: Boolean(existing),
        replacedThreadId: input.threadId ?? null,
      });
      generation = bound?.generation ?? generation;
    }
    const { runtime, fresh } = await this.runtimeFor({
      input,
      snapshot,
      threadId,
      systemInstructions,
      nativeSkills,
    });
    runtime.lastActivityAt = new Date().toISOString();
    runtime.client.setRequestHandler(async (method, params) => {
      if (method !== 'allrice/tool-call') {
        throw new HandlerError(
          'DSH_INBOUND_REQUEST_DENIED',
          `DSH requested an unsupported Worker method: ${method}`,
          false,
        );
      }
      const id = shortText(params.toolCallId, 240);
      const name = shortText(params.name, 160);
      const args = record(params.arguments);
      if (!id || !name || !args || !dshBrokerNativeToolNames.has(name)) {
        throw new HandlerError(
          'DSH_NATIVE_TOOL_INVALID',
          'DSH requested an invalid AllRice native tool call',
          false,
        );
      }
      if (!input.tools.some((tool) => tool.name === name)) {
        throw new HandlerError(
          'TOOL_NOT_ALLOWED',
          `DSH requested an unavailable tool: ${name}`,
          false,
        );
      }
      if (!input.onToolCall) {
        throw new HandlerError(
          'TOOL_NOT_ALLOWED',
          'No AllRice Tool Broker is available for this execution',
          false,
        );
      }
      const result = await input.onToolCall({ id, name, arguments: args });
      return {
        modelContent: result.modelContent,
        summary: result.summary,
        ...(result.itemCount === undefined
          ? {}
          : { itemCount: result.itemCount }),
      };
    });
    let order = 0;
    let turnId: string | null = null;
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    const emit = async (event: HarnessEventPayload) => {
      const sourceEventType =
        event.type === 'assistant.delta'
          ? 'assistant/chunk'
          : event.type === 'assistant.completed'
            ? 'assistant/message'
            : event.type === 'usage.updated'
              ? 'assistant/message:usage'
              : 'source' in event && event.source === 'tool_broker'
                ? 'allrice/tool-broker'
                : 'dsh/tool';
      await input.onEvent(
        HarnessEventSchema.parse({
          schemaVersion: 1,
          harness: this.kind,
          generation,
          attempt: input.attempt,
          order: ++order,
          threadId,
          turnId,
          sessionId: input.kernel.sessionId,
          messageId: input.kernel.assistantMessageId,
          sourceEventId: `dsh:${input.attempt}:${order}`,
          sourceEventType,
          sourceOccurredAt: new Date().toISOString(),
          sourcePayload: {},
          ...event,
        }),
      );
    };
    const initialPrompt = [
      toolBridgeInstructions(input),
      fresh && input.kernel.bootstrapConversation
        ? `Conversation context:\n${input.kernel.bootstrapConversation}`
        : '',
      input.kernel.authorizedMemoryContext,
      input.kernel.userRequest,
    ]
      .filter(Boolean)
      .join('\n\n');
    let prompt = initialPrompt;
    let answer = '';
    try {
      for (
        let callIndex = 0;
        callIndex <= maximumToolCallsPerTurn;
        callIndex++
      ) {
        const result = await this.runOnce({
          runtime,
          prompt,
          signal: input.signal,
          onTurn: async (nextTurnId) => {
            turnId = nextTurnId;
            await input.onTurnStarted?.({ threadId, turnId: nextTurnId });
          },
          onDelta: async (text, source) =>
            emit({ type: 'assistant.delta', text, ...source }),
          onNative: async (event) => emit(event),
        });
        usage.inputTokens += result.usage.inputTokens;
        usage.cachedInputTokens += result.usage.cachedInputTokens;
        usage.outputTokens += result.usage.outputTokens;
        const toolCall = parseToolCall(result.answer);
        if (!toolCall) {
          answer = result.answer;
          await emit({
            type: 'assistant.completed',
            text: answer,
            ...(result.completionSource ?? {}),
          });
          await emit({
            type: 'usage.updated',
            ...usage,
            ...(result.usageSource ?? result.completionSource ?? {}),
          });
          break;
        }
        if (callIndex === maximumToolCallsPerTurn) {
          throw new HandlerError(
            'DSH_TOOL_LIMIT_EXCEEDED',
            'DSH exceeded the AllRice tool-call limit',
            false,
          );
        }
        if (!input.tools.some((tool) => tool.name === toolCall.name)) {
          throw new HandlerError(
            'TOOL_NOT_ALLOWED',
            `DSH requested an unavailable tool: ${toolCall.name}`,
            false,
          );
        }
        if (!input.onToolCall) {
          throw new HandlerError(
            'TOOL_NOT_ALLOWED',
            'No AllRice Tool Broker is available for this execution',
            false,
          );
        }
        await emit({
          type: 'tool.started',
          toolCallId: toolCall.id,
          name: toolCall.name,
          label: toolCall.name,
          source: 'tool_broker',
          sourceEventType: 'allrice/tool-broker',
          sourcePayload: {
            presentation: toolCall.name === 'web.search' ? 'search' : 'tool',
            status: 'started',
            query:
              toolCall.name === 'web.search' &&
              typeof toolCall.arguments.query === 'string'
                ? toolCall.arguments.query.slice(0, 500)
                : undefined,
          },
        });
        try {
          const toolResult = await input.onToolCall(toolCall);
          await emit({
            type: 'tool.completed',
            toolCallId: toolCall.id,
            name: toolCall.name,
            label: toolCall.name,
            source: 'tool_broker',
            summary: toolResult.summary,
            sourceEventType: 'allrice/tool-broker',
            sourcePayload: {
              presentation: toolCall.name === 'web.search' ? 'search' : 'tool',
              status: 'completed',
              summary: toolResult.summary,
            },
            ...(toolResult.itemCount === undefined
              ? {}
              : { itemCount: toolResult.itemCount }),
          });
          prompt = `<allrice_tool_result>${JSON.stringify({
            id: toolCall.id,
            ok: true,
            content: toolResult.modelContent,
          })}</allrice_tool_result>`;
        } catch (error) {
          await emit({
            type: 'tool.failed',
            toolCallId: toolCall.id,
            name: toolCall.name,
            label: toolCall.name,
            source: 'tool_broker',
            summary: error instanceof Error ? error.message : 'tool failed',
            sourceEventType: 'allrice/tool-broker',
            sourcePayload: {
              presentation: toolCall.name === 'web.search' ? 'search' : 'tool',
              status: 'failed',
            },
          });
          throw error;
        }
      }
    } catch (error) {
      await this.dropRuntime(threadId);
      if (input.signal.aborted) {
        throw new HandlerError(
          'EXECUTION_ABORTED',
          'DSH execution was interrupted',
          false,
        );
      }
      throw error;
    } finally {
      runtime.lastActivityAt = new Date().toISOString();
      runtime.client.setRequestHandler(null);
    }
    return {
      answer,
      usage,
      provider: snapshot.route,
      model: snapshot.model,
      threadId,
      turnId,
      nativeContextPressure: await runtime.client
        .sessionProjection(runtime.sessionId)
        .then((projection) =>
          projection.contextPressure
            ? {
                ...(projection.asOfSeq === undefined
                  ? {}
                  : { asOfSeq: projection.asOfSeq }),
                ...projection.contextPressure,
              }
            : null,
        )
        .catch(() => null),
    };
  }

  async interrupt(input: { threadId: string }) {
    const runtime = this.runtimes.get(input.threadId);
    if (!runtime) return;
    await runtime.client.interrupt(runtime.sessionId);
  }

  async compact(input: { threadId: string }) {
    const runtime = this.runtimes.get(input.threadId);
    if (!runtime) return;
    await runtime.client.compact(runtime.sessionId);
  }

  async recover(input: { threadId: string }) {
    const runtime = this.runtimes.get(input.threadId);
    if (!runtime) return;
    await runtime.client.recover(runtime.sessionId);
  }

  async steer(input: { threadId: string; message: string }) {
    const runtime = this.runtimes.get(input.threadId);
    if (!runtime) {
      throw new HandlerError(
        'DSH_SESSION_NOT_LIVE',
        'DSH session is not live on this worker',
        true,
      );
    }
    await runtime.client.steer(runtime.sessionId, input.message);
  }

  async close() {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.allSettled(runtimes.map((runtime) => runtime.client.close()));
  }

  runtimeInventory(): readonly HarnessRuntimeProcessSnapshot[] {
    return [...this.runtimes.values()].map((runtime) => ({
      id: runtime.id,
      organizationId: runtime.organizationId,
      workspaceId: runtime.workspaceId,
      sessionId: runtime.productSessionId,
      ownerId: runtime.ownerId,
      threadId: runtime.sessionId,
      providerRoute: runtime.providerRoute,
      model: runtime.model,
      reasoningEffort: runtime.reasoningEffort,
      profileFingerprint: runtime.fingerprint,
      nativeTools: [...runtime.nativeTools],
      startedAt: runtime.startedAt,
      lastActivityAt: runtime.lastActivityAt,
    }));
  }

  private async runtimeFor(input: {
    input: HarnessExecutionInput;
    snapshot: DshExecutionSnapshot;
    threadId: string;
    systemInstructions: string;
    nativeSkills: NonNullable<HarnessExecutionInput['nativeSkills']>;
  }) {
    if (!this.runtimeCommand) {
      throw new HandlerError(
        'DSH_RUNTIME_UNAVAILABLE',
        'DSH is not configured in this deployment',
        false,
      );
    }
    const organizationId =
      input.input.executionEnvironment.ALLRICE_ORGANIZATION_ID;
    const workspaceId = input.input.executionEnvironment.ALLRICE_WORKSPACE_ID;
    const ownerId = input.input.executionEnvironment.ALLRICE_OWNER_ID;
    if (!organizationId || !workspaceId || !ownerId) {
      throw new HandlerError(
        'DSH_TENANT_CONTEXT_INVALID',
        'DSH execution is missing tenant isolation context',
        false,
      );
    }
    const dshPlatformHome = resolve(
      process.env.ALLRICE_DSH_PLATFORM_HOME ?? '.local/dsh-platform',
    );
    const dshCredentialsPath = resolve(dshPlatformHome, '.credentials.yaml');
    const credential =
      input.snapshot.route === 'openai-codex'
        ? null
        : await this.credentialResolver.resolve({
            reference: input.snapshot.credentialReference,
            organizationId,
            workspaceId,
            ownerId,
            route: input.snapshot.route,
          });
    const codexGrantMetadata =
      input.snapshot.route === 'openai-codex'
        ? await stat(dshCredentialsPath).catch(() => null)
        : null;
    if (input.snapshot.route === 'openai-codex' && !codexGrantMetadata) {
      throw new HandlerError(
        'CODEX_SUBSCRIPTION_AUTH_REQUIRED',
        'The platform Codex subscription must be authorized before DSH can use it',
        false,
      );
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          snapshot: input.snapshot,
          systemInstructions: input.systemInstructions,
          nativeTools: input.input.tools
            .map((tool) => tool.name)
            .filter(isDshNativeTool)
            .sort(),
          nativeSkills: input.nativeSkills.map((skill) => ({
            id: skill.id,
            checksum: skill.checksum,
            name: skill.name,
            invocation: skill.invocation,
          })),
          credentialDigest: credential
            ? createHash('sha256').update(credential.apiKey).digest('hex')
            : `codex-grant:${codexGrantMetadata?.mtimeMs ?? 0}:${codexGrantMetadata?.size ?? 0}`,
        }),
      )
      .digest('hex');
    const existing = this.runtimes.get(input.threadId);
    if (existing?.fingerprint === fingerprint) {
      return { runtime: existing, fresh: false };
    }
    if (existing) await this.dropRuntime(input.threadId);
    const tenantRoot = resolve(
      this.runtimeRoot,
      organizationId,
      workspaceId,
      ownerId,
      input.input.kernel.sessionId,
    );
    if (!tenantRoot.startsWith(`${this.runtimeRoot}${sep}`)) {
      throw new HandlerError(
        'DSH_TENANT_CONTEXT_INVALID',
        'DSH runtime path escaped its tenant root',
        false,
      );
    }
    await mkdir(tenantRoot, { recursive: true, mode: 0o700 });
    await mkdir(dshPlatformHome, { recursive: true, mode: 0o700 });
    const environment: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: process.env.LANG ?? 'C.UTF-8',
      DSH_CORDIS_CONFIG: this.cordisConfig,
      DSH_HOME: dshPlatformHome,
      DSH_CREDENTIALS_PATH: resolve(dshPlatformHome, '.credentials.yaml'),
      DSH_CWD: tenantRoot,
      DSH_SESSION_ROOT: resolve(tenantRoot, 'sessions'),
      DSH_MODEL: input.snapshot.model,
      DSH_CODEX_MODEL:
        input.snapshot.route === 'openai-codex'
          ? input.snapshot.model
          : 'gpt-5.6-luna',
      DSH_OPENAI_COMPATIBLE_MODEL:
        input.snapshot.route === 'openai-compatible'
          ? input.snapshot.model
          : 'allrice-unused',
      DSH_REASONING_EFFORT: mappedReasoning(input.snapshot.reasoningEffort),
      DSH_SYSTEM_PROMPT: [
        input.systemInstructions,
        'All host capabilities are disabled. Use only capabilities explicitly supplied by AllRice in the current turn.',
      ].join('\n\n'),
      DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
      DSH_MAX_OUTPUT_TOKENS: String(input.input.maxOutputTokens ?? 16_000),
    };
    if (input.snapshot.route === 'openai-codex') {
      // The DSH credential service resolves and refreshes the platform OAuth
      // grant. No token is copied into the child environment.
    } else if (input.snapshot.route === 'deepseek-official') {
      environment.DEEPSEEK_API_KEY = credential!.apiKey;
      if (input.snapshot.baseUrl) {
        environment.DEEPSEEK_BASE_URL = input.snapshot.baseUrl;
      }
    } else {
      environment.OPENAI_COMPATIBLE_API_KEY = credential!.apiKey;
      environment.OPENAI_COMPATIBLE_BASE_URL = input.snapshot.baseUrl!;
    }
    const nativeTools = input.input.tools
      .map((tool) => tool.name)
      .filter(isDshNativeTool);
    const startedAt = new Date().toISOString();
    const runtime: DshRuntime = {
      client: new DshProtocolClient({
        command: this.runtimeCommand,
        args: this.runtimeArgs,
        cwd: tenantRoot,
        environment,
        requestTimeoutMs: this.requestTimeoutMs,
      }),
      id: randomUUID(),
      fingerprint,
      sessionId: input.threadId,
      organizationId,
      workspaceId,
      productSessionId: input.input.kernel.sessionId,
      ownerId,
      providerRoute: input.snapshot.route,
      model: input.snapshot.model,
      reasoningEffort: input.snapshot.reasoningEffort,
      nativeTools,
      startedAt,
      lastActivityAt: startedAt,
    };
    try {
      await runtime.client.initialize({
        cwd: tenantRoot,
        provider: input.snapshot.route,
        model: input.snapshot.model,
        nativeTools,
        nativeSkills: input.nativeSkills,
        maxTokens: input.input.maxOutputTokens,
        expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
      });
      this.runtimes.set(input.threadId, runtime);
      return { runtime, fresh: true };
    } catch (error) {
      await runtime.client.close();
      throw error;
    }
  }

  private async runOnce(input: {
    runtime: DshRuntime;
    prompt: string;
    signal: AbortSignal;
    onTurn(turnId: string): Promise<void>;
    onDelta(text: string, source: DshSourceMetadata): Promise<void>;
    onNative(event: HarnessEventPayload): Promise<void>;
  }) {
    let rawAnswer = '';
    let answer = '';
    let visibleLength = 0;
    let deltaBuffer = '';
    let deltaMode: 'unknown' | 'answer' | 'tool' = 'unknown';
    let eventChain = Promise.resolve();
    let processingError: unknown;
    let idle = false;
    let settle!: () => void;
    const idlePromise = new Promise<void>((resolveIdle) => {
      settle = resolveIdle;
    });
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    let completionSource: DshSourceMetadata | undefined;
    let usageSource: DshSourceMetadata | undefined;
    const activeReasoningBlocks = new Set<number>();
    const activeNativeTools = new Map<
      string,
      { name: string; query?: string }
    >();
    const processNotification = async (notification: DshNotification) => {
      if (notification.params.sessionId !== input.runtime.sessionId) return;
      if (notification.method === 'session.user-question') {
        const questions = Array.isArray(notification.params.questions)
          ? notification.params.questions
          : [];
        const first = record(questions[0]);
        const summary = shortText(first?.question, 500);
        await input.onNative({
          type: 'native.event',
          presentation: 'context',
          status: 'started',
          label: 'Rice 需要你确认',
          ...(summary ? { summary } : {}),
          sourceEventId: `dsh:${shortText(notification.params.questionId, 180) ?? randomUUID()}`,
          sourceEventType: 'session/user-question',
          sourceOccurredAt: new Date().toISOString(),
          sourcePayload: { questionCount: questions.length },
        });
        return;
      }
      if (notification.method === 'session.user-question-answered') {
        await input.onNative({
          type: 'native.event',
          presentation: 'context',
          status: 'completed',
          label: '已收到你的回答',
          sourceEventId: `dsh:${shortText(notification.params.questionId, 180) ?? randomUUID()}:answered`,
          sourceEventType: 'session/user-question-answered',
          sourceOccurredAt: new Date().toISOString(),
          sourcePayload: {},
        });
        return;
      }
      if (
        notification.method === 'session.status' &&
        notification.params.status === 'idle'
      ) {
        idle = true;
        settle();
        return;
      }
      if (notification.method !== 'session.event') return;
      const event = record(notification.params.event);
      const data = record(event?.data);
      if (!event || !data) return;
      const source = sourceMetadata(event);
      if (event.type === 'tool/call') {
        const callId = shortText(data.callId, 240);
        const rawName = shortText(data.name, 160);
        if (!callId || !rawName) return;
        const name = dshNativeWireNames[rawName] ?? rawName;
        let args: Record<string, unknown> | null = null;
        try {
          args =
            typeof data.arguments === 'string'
              ? record(JSON.parse(data.arguments))
              : record(data.arguments);
        } catch {
          args = null;
        }
        const queries = Array.isArray(args?.queries)
          ? args.queries.filter((query) => typeof query === 'string')
          : [];
        const query = queries.length
          ? queries.join(' · ').slice(0, 500)
          : shortText(args?.query, 500);
        activeNativeTools.set(callId, {
          name,
          ...(query ? { query } : {}),
        });
        await input.onNative({
          type: 'tool.started',
          toolCallId: callId,
          name,
          label: name,
          source: 'harness',
          ...source,
          sourcePayload: {
            ...source.sourcePayload,
            presentation: name === 'web.search' ? 'search' : 'tool',
            status: 'started',
            ...(query ? { query } : {}),
          },
        });
        return;
      }
      if (event.type === 'tool/result') {
        const message = record(data.message);
        const firstBlock = Array.isArray(message?.content)
          ? record(message.content[0])
          : null;
        const callId = shortText(
          firstBlock?.toolCallId ?? message?.toolCallId ?? message?.callId,
          240,
        );
        if (!callId) return;
        const active = activeNativeTools.get(callId);
        const name = active?.name ?? 'tool';
        const failed = Boolean(data.error);
        await input.onNative({
          type: failed ? 'tool.failed' : 'tool.completed',
          toolCallId: callId,
          name,
          label: name,
          source: 'harness',
          summary:
            name === 'web.search'
              ? failed
                ? '搜索失败'
                : '搜索完成'
              : failed
                ? '工具执行失败'
                : '工具执行完成',
          ...source,
          sourcePayload: {
            ...source.sourcePayload,
            presentation: name === 'web.search' ? 'search' : 'tool',
            status: failed ? 'failed' : 'completed',
            ...(active?.query ? { query: active.query } : {}),
          },
        });
        activeNativeTools.delete(callId);
        return;
      }
      const nativeView = nativeEventView(event);
      if (nativeView) await input.onNative(nativeView);
      if (event.type === 'turn/start') {
        const turn =
          typeof data.turn === 'number' || typeof data.turn === 'string'
            ? String(data.turn)
            : randomUUID();
        await input.onTurn(`${input.runtime.sessionId}:turn:${turn}`);
        return;
      }
      if (event.type === 'assistant/chunk') {
        const chunk = record(data.chunk);
        const chunkIndex =
          typeof chunk?.index === 'number' ? chunk.index : undefined;
        const block = record(chunk?.block);
        const startsReasoning =
          chunk?.type === 'block-start' && chunk.blockType === 'reasoning';
        const streamsReasoning = chunk?.type === 'reasoning-delta';
        if (
          chunkIndex !== undefined &&
          (startsReasoning || streamsReasoning) &&
          !activeReasoningBlocks.has(chunkIndex)
        ) {
          activeReasoningBlocks.add(chunkIndex);
          await input.onNative({
            type: 'native.event',
            presentation: 'think',
            status: 'started',
            label: 'Rice 正在思考',
            ...source,
          });
        }
        if (
          chunk?.type === 'block-end' &&
          chunkIndex !== undefined &&
          (activeReasoningBlocks.has(chunkIndex) || block?.kind === 'reasoning')
        ) {
          activeReasoningBlocks.delete(chunkIndex);
          await input.onNative({
            type: 'native.event',
            presentation: 'think',
            status: 'completed',
            label: '思考完成',
            ...source,
          });
        }
        if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') {
          return;
        }
        rawAnswer += chunk.text;
        const visible = visibleModelText(rawAnswer);
        if (!visible.ready) return;
        answer = visible.text;
        const delta = answer.slice(visibleLength);
        visibleLength = answer.length;
        if (!delta) return;
        if (deltaMode === 'tool') return;
        if (deltaMode === 'answer') {
          await input.onDelta(delta, source);
          return;
        }
        deltaBuffer += delta;
        const candidate = deltaBuffer.trimStart();
        if (!candidate || toolEnvelopePrefix.startsWith(candidate)) return;
        if (candidate.startsWith(toolEnvelopePrefix)) {
          deltaMode = 'tool';
          return;
        }
        deltaMode = 'answer';
        await input.onDelta(deltaBuffer, source);
        deltaBuffer = '';
        return;
      }
      if (event.type === 'assistant/message') {
        completionSource = source;
        const message = record(data.message);
        const final = textBlocks(message?.content);
        if (final) {
          rawAnswer = final;
          const visible = visibleModelText(final);
          if (visible.ready) answer = visible.text;
        }
        const eventUsage = record(data.usage);
        usage.inputTokens += positiveInteger(eventUsage?.inputTokens);
        usage.cachedInputTokens += positiveInteger(eventUsage?.cacheReadTokens);
        usage.outputTokens += positiveInteger(eventUsage?.outputTokens);
        usageSource = source;
      }
      if (event.type === 'turn/end') {
        const reason = record(data.reason);
        if (reason?.kind === 'error') {
          const failure = record(reason.error);
          throw new HandlerError(
            typeof failure?.code === 'string'
              ? `DSH_${failure.code}`
              : 'DSH_TURN_FAILED',
            typeof failure?.message === 'string'
              ? failure.message
              : 'DSH turn failed',
            true,
          );
        }
      }
    };
    const unsubscribe = input.runtime.client.subscribe((notification) => {
      eventChain = eventChain
        .then(() => processNotification(notification))
        .catch((error: unknown) => {
          processingError ??= error;
          settle();
        });
    });
    const abort = () => {
      void input.runtime.client.interrupt(input.runtime.sessionId);
      settle();
    };
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    try {
      await input.runtime.client.prompt(input.runtime.sessionId, input.prompt);
      if (!idle) await idlePromise;
      await eventChain;
      if (processingError) throw processingError;
      if (input.signal.aborted) {
        throw new HandlerError(
          'EXECUTION_ABORTED',
          'DSH execution was interrupted',
          false,
        );
      }
      if (deltaMode === 'unknown' && deltaBuffer && !parseToolCall(answer)) {
        await input.onDelta(deltaBuffer, {
          sourceEventId: `dsh:buffer:${randomUUID()}`,
          sourceEventType: 'assistant/chunk',
          sourceOccurredAt: new Date().toISOString(),
          sourcePayload: { text: deltaBuffer },
        });
      }
      return { answer, usage, completionSource, usageSource };
    } finally {
      unsubscribe();
      input.signal.removeEventListener('abort', abort);
    }
  }

  private async dropRuntime(threadId: string) {
    const runtime = this.runtimes.get(threadId);
    this.runtimes.delete(threadId);
    await runtime?.client.close();
  }
}
