import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
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
  /^<allrice_tool_call>\s*([\s\S]*?)\s*<\/allrice_tool_call>$/;
const maximumToolCallsPerTurn = 8;

interface DshRuntime {
  client: DshProtocolClient;
  fingerprint: string;
  sessionId: string;
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
        | 'messageId'
      >
    : never
  : never;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
  if (input.tools.length === 0) {
    return 'No external tools are available. Never claim that a tool was called.';
  }
  const definitions = input.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  return [
    'All host capabilities are disabled. The only available tools are the AllRice tenant-scoped tools below.',
    JSON.stringify(definitions),
    'To call exactly one tool, return only <allrice_tool_call>{"id":"unique-id","name":"tool.name","arguments":{}}</allrice_tool_call>.',
    'Do not wrap that envelope in Markdown. Wait for an <allrice_tool_result> response before continuing.',
  ].join('\n');
}

function parseToolCall(text: string): HarnessToolCall | null {
  const match = toolEnvelopePattern.exec(text.trim());
  if (!match?.[1]) return null;
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
  readonly capabilities = {
    persistentThreads: true,
    assistantDeltas: true,
    toolEvents: true,
    usageEvents: true,
    interrupt: true,
    steer: false,
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
    this.runtimeCommand =
      options.runtimeCommand ?? process.env.ALLRICE_DSH_RUNTIME_COMMAND;
    this.runtimeArgs =
      options.runtimeArgs ??
      parseRuntimeArgs(process.env.ALLRICE_DSH_RUNTIME_ARGS);
    this.runtimeRoot = resolve(
      options.runtimeRoot ??
        process.env.ALLRICE_DSH_RUNTIME_ROOT ??
        '.local/dsh-runtime',
    );
    this.cordisConfig = resolve(
      options.cordisConfig ??
        process.env.ALLRICE_DSH_CORDIS_CONFIG ??
        'apps/worker/dsh/allrice-restricted.cordis.yml',
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
    });
    let order = 0;
    let turnId: string | null = null;
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    const emit = async (event: HarnessEventPayload) => {
      await input.onEvent(
        HarnessEventSchema.parse({
          schemaVersion: 1,
          harness: this.kind,
          generation,
          attempt: input.attempt,
          order: ++order,
          threadId,
          turnId,
          messageId: input.kernel.assistantMessageId,
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
          onDelta: async (text) => emit({ type: 'assistant.delta', text }),
        });
        usage.inputTokens += result.usage.inputTokens;
        usage.cachedInputTokens += result.usage.cachedInputTokens;
        usage.outputTokens += result.usage.outputTokens;
        const toolCall = parseToolCall(result.answer);
        if (!toolCall) {
          answer = result.answer;
          await emit({ type: 'assistant.completed', text: answer });
          await emit({ type: 'usage.updated', ...usage });
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
    }
    return {
      answer,
      usage,
      provider: snapshot.route,
      model: snapshot.model,
      threadId,
      turnId,
    };
  }

  async interrupt(input: { threadId: string }) {
    await this.dropRuntime(input.threadId);
  }

  async compact(input: { threadId: string }) {
    await this.dropRuntime(input.threadId);
  }

  async recover(input: { threadId: string }) {
    await this.dropRuntime(input.threadId);
  }

  async close() {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.allSettled(runtimes.map((runtime) => runtime.client.close()));
  }

  private async runtimeFor(input: {
    input: HarnessExecutionInput;
    snapshot: DshExecutionSnapshot;
    threadId: string;
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
    const credential = await this.credentialResolver.resolve({
      reference: input.snapshot.credentialReference,
      organizationId,
      workspaceId,
      ownerId,
      route: input.snapshot.route,
    });
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          snapshot: input.snapshot,
          systemInstructions: input.input.kernel.systemInstructions,
          credentialDigest: createHash('sha256')
            .update(credential.apiKey)
            .digest('hex'),
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
    const environment: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: process.env.LANG ?? 'C.UTF-8',
      DSH_CORDIS_CONFIG: this.cordisConfig,
      DSH_CWD: tenantRoot,
      DSH_SESSION_ROOT: resolve(tenantRoot, 'sessions'),
      DSH_MODEL: input.snapshot.model,
      DSH_REASONING_EFFORT: mappedReasoning(input.snapshot.reasoningEffort),
      DSH_SYSTEM_PROMPT: [
        input.input.kernel.systemInstructions,
        'All host capabilities are disabled. Use only capabilities explicitly supplied by AllRice in the current turn.',
      ].join('\n\n'),
    };
    if (input.snapshot.route === 'deepseek-official') {
      environment.DEEPSEEK_API_KEY = credential.apiKey;
      if (input.snapshot.baseUrl) {
        environment.DEEPSEEK_BASE_URL = input.snapshot.baseUrl;
      }
    } else {
      environment.OPENAI_COMPATIBLE_API_KEY = credential.apiKey;
      environment.OPENAI_COMPATIBLE_BASE_URL = input.snapshot.baseUrl!;
    }
    const runtime: DshRuntime = {
      client: new DshProtocolClient({
        command: this.runtimeCommand,
        args: this.runtimeArgs,
        cwd: tenantRoot,
        environment,
        requestTimeoutMs: this.requestTimeoutMs,
      }),
      fingerprint,
      sessionId: input.threadId,
    };
    try {
      await runtime.client.initialize({
        cwd: tenantRoot,
        provider: input.snapshot.route,
        model: input.snapshot.model,
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
    onDelta(text: string): Promise<void>;
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
    const processNotification = async (notification: DshNotification) => {
      if (notification.params.sessionId !== input.runtime.sessionId) return;
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
          await input.onDelta(delta);
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
        await input.onDelta(deltaBuffer);
        deltaBuffer = '';
        return;
      }
      if (event.type === 'assistant/message') {
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
      void input.runtime.client.close();
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
        await input.onDelta(deltaBuffer);
      }
      return { answer, usage };
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
